import {
  type ProtocolOp, type LdapControl, type LdapMessage, type LdapResult,
  encodeLdapMessage, decodeLdapMessage,
} from '@/network/devices/windows/server/ad/ldap/LdapMessage';
import type { SearchScope } from '@/network/devices/windows/server/ad/ldap/DirectoryTree';
import { putFilter } from '@/network/devices/windows/server/ad/ldap/LdapFilterString';
import { LdapRc, ldapErr2String } from './ldapErrors';
import { type LdapOptions, LdapVersion } from './ldapOptions';
import {
  type LdapUrlDesc, urlSchemePort, urlScheme2Proto, ldapUrlParseListExt, ldapUrlParseExt,
  LdapUrlErr, LdapUrlParse, LdapScope,
} from './ldapUrl';
import { LdapDebug, LdapLog } from './ldapLog';
import { BerElement, LBER_DEFAULT, formatPointer } from './libber';
import { Sockbuf, berGetNext, newBerGetNextState, type BerGetNextState } from './ldapSockbuf';
import type { LdapChannel, LdapTransport, TlsUpgradeRequest } from './ldapChannel';
import { HeapSim } from './ldapHeap';
import { LDAP_SASL_QUIET } from './lutilSasl';
import { SaslClientConn, saslErrstring, type SaslHostEnvironment } from './sasl/saslClient';
import { SaslProp, SaslRc, type SaslInteract } from './sasl/saslTypes';

export type { LdapChannel, LdapTransport, TlsUpgradeRequest, TlsUpgradeOutcome } from './ldapChannel';

export const LdapRes = {
  BIND: 0x61,
  SEARCH_ENTRY: 0x64,
  SEARCH_RESULT: 0x65,
  SEARCH_REFERENCE: 0x73,
  EXTENDED: 0x78,
  INTERMEDIATE: 0x79,
} as const;

export const LdapMsg = { ONE: 0, ALL: 1, RECEIVED: 2 } as const;
export const LDAP_RES_ANY = -1;
const LDAP_RES_UNSOLICITED = 0;
const LDAP_TAG_MESSAGE = 0x30;
const LDAP_TAG_REFERRAL = 0xa3;
const LDAP_TAG_SASL_RES_CREDS = 0x87;
const LDAP_TAG_EXOP_RES_OID = 0x8a;
const LDAP_TAG_EXOP_RES_VALUE = 0x8b;
const LDAP_TAG_CONTROLS = 0xa0;
const LDAP_NOTICE_OF_DISCONNECTION = '1.3.6.1.4.1.1466.20036';
const START_TLS_OID = '1.3.6.1.4.1.1466.20037';
const LDAP_REF_STR = 'Referral:\n';
const LDAP_MSG_X_KEEP_LOOKING = -2;
const LDAP_REFHOPLIMIT = 5;

const RES_TAG_NAMES: Readonly<Record<number, string>> = {
  0x69: 'add', 0x61: 'bind', 0x6f: 'compare', 0x6b: 'delete', 0x78: 'extended-result',
  0x79: 'intermediate', 0x67: 'modify', 0x6d: 'rename', 0x64: 'search-entry',
  0x73: 'search-reference', 0x65: 'search-result',
};

const ReqStatus = { INPROGRESS: 1, CHASINGREFS: 2, NOTCONNECTED: 3, WRITING: 4, COMPLETED: 5 } as const;
const ReqTag = { BIND: 0x60, UNBIND: 0x42, SEARCH: 0x63, DELETE: 0x4a, ABANDON: 0x50 } as const;
const ConnStatus = { CLOSED: 0, NEEDSOCKET: 1, CONNECTING: 2, CONNECTED: 3 } as const;

const SCOPE_NAMES: readonly SearchScope[] = ['base', 'one', 'sub', 'children'];

function msgtype2str(tag: number): string {
  return RES_TAG_NAMES[tag] ?? 'unknown';
}

export function messageType(message: LdapMessage): number {
  switch (message.protocolOp.kind) {
    case 'bindResponse': return LdapRes.BIND;
    case 'searchResultEntry': return LdapRes.SEARCH_ENTRY;
    case 'searchResultDone': return LdapRes.SEARCH_RESULT;
    case 'searchResultReference': return LdapRes.SEARCH_REFERENCE;
    case 'extendedResponse': return LdapRes.EXTENDED;
    case 'intermediateResponse': return LdapRes.INTERMEDIATE;
    case 'modifyResponse': return 0x67;
    case 'addResponse': return 0x69;
    case 'delResponse': return 0x6b;
    case 'modifyDNResponse': return 0x6d;
    case 'compareResponse': return 0x6f;
    default: return -1;
  }
}

export function resultOf(message: LdapMessage): LdapResult | null {
  const op = message.protocolOp;
  switch (op.kind) {
    case 'bindResponse':
    case 'searchResultDone':
    case 'extendedResponse':
    case 'modifyResponse':
    case 'addResponse':
    case 'delResponse':
    case 'modifyDNResponse':
    case 'compareResponse':
      return op.result;
    default:
      return null;
  }
}

export interface ParsedResult {
  readonly code: number;
  readonly matchedDn: string;
  readonly text: string;
  readonly referrals: string[] | null;
  readonly controls: readonly LdapControl[] | null;
}

export interface ResultBatch {
  readonly type: number;
  readonly messages: LdapMessage[];
}

export interface SearchRequestSpec {
  readonly base: string | null;
  readonly scope: number;
  readonly filter: string;
  readonly attributes: readonly string[] | null;
  readonly attrsOnly: boolean;
  readonly serverControls: readonly LdapControl[] | null;
  readonly timeoutSeconds: number | null;
  readonly sizeLimit: number;
}

export interface WaitTimeout {
  readonly seconds: number;
  readonly microseconds: number;
}

export interface SessionClock {
  now(): number;
  nowMicroseconds(): number;
  ctime(seconds: number): string;
}

class LdapConn {
  refcnt = 0;
  status: number = ConnStatus.CONNECTED;
  created = 0;
  lastUsed = 0;
  rebindInProgress = false;
  rebindQueue: string[][] | null = null;
  berState: BerGetNextState = newBerGetNextState();
  server: LdapUrlDesc | null = null;
  isDefault = false;
  descriptor = 3;
  saslAuthCtx: SaslClientConn | null = null;
  saslSockCtx: SaslClientConn | null = null;

  constructor(readonly sb: Sockbuf) {}
}

class LdapReq {
  msgid = 0;
  origid = 0;
  status: number = ReqStatus.INPROGRESS;
  refcnt = 0;
  outrefcnt = 0;
  parentcnt = 0;
  conn: LdapConn | null = null;
  ber: BerElement | null = null;
  op: ProtocolOp | null = null;
  controls: readonly LdapControl[] = [];
  dn = '';
  parent: LdapReq | null = null;
  child: LdapReq | null = null;
  refnext: LdapReq | null = null;
  resMsgType = 0;
  resErrno: number = LdapRc.SUCCESS;
  resError: string | null = null;
  resMatched: string | null = null;
}

export class RespMsg {
  chain: RespMsg | null = null;
  chainTail: RespMsg;
  next: RespMsg | null = null;

  constructor(
    readonly msgid: number,
    readonly msgtype: number,
    readonly ber: BerElement,
    readonly message: LdapMessage,
  ) {
    this.chainTail = this;
  }
}

interface RebindInfo {
  readonly msgid: number;
  readonly url: string;
  readonly request: number;
}

interface WaitOutcome {
  readonly rc: number;
  readonly result: RespMsg | null;
}

export class LdapSession {
  errno: number = LdapRc.SUCCESS;
  errorText: string | null = null;
  matched: string | null = null;
  referrals: string[] | null = null;
  serverControls: readonly LdapControl[] | null = null;
  reservedDescriptors = 0;

  private nextMessageId = 1;
  private readonly heap = new HeapSim();
  private readonly ldPointer: number;
  private conns: LdapConn[] = [];
  private defConn: LdapConn | null = null;
  private readonly requests = new Map<number, LdapReq>();
  private responses: RespMsg | null = null;
  private abandoned: number[] = [];
  private unbound = false;
  private readonly openDescriptors = new Set<number>();
  private readonly responseIndex = new WeakMap<LdapMessage, RespMsg>();
  private readonly requestPointers = new WeakMap<LdapReq, number>();

  constructor(
    readonly options: LdapOptions,
    private readonly transport: LdapTransport,
    readonly log: LdapLog = new LdapLog(() => undefined),
    private readonly clock: SessionClock,
    private readonly saslHost: SaslHostEnvironment | null = null,
  ) {
    this.ldPointer = this.heap.allocate(1024);
    this.log.debug(LdapDebug.TRACE, 'ldap_create\n');
  }

  setUri(uri: string): number {
    const parsed = ldapUrlParseListExt(uri, null, LdapUrlParse.NOEMPTY_HOST | LdapUrlParse.DEF_PORT, this.log);
    if (parsed.rc !== LdapUrlErr.SUCCESS) {
      return parsed.rc === 0x01 ? LdapRc.NO_MEMORY : LdapRc.PARAM_ERROR;
    }
    this.options.urls = parsed.list;
    return LdapRc.SUCCESS;
  }

  get connectedUrl(): LdapUrlDesc | null {
    return this.defConn?.server ?? null;
  }

  get isConnected(): boolean {
    return this.defConn !== null && this.defConn.status === ConnStatus.CONNECTED;
  }

  get peerAddress(): string | null {
    return this.defConn?.sb.channel.peerAddress ?? null;
  }

  allocateMessageId(): number {
    return this.nextMessageId++;
  }

  private ld(): string {
    return formatPointer(this.ldPointer);
  }

  private requestPointer(lr: LdapReq): string {
    let pointer = this.requestPointers.get(lr);
    if (pointer === undefined) {
      pointer = this.heap.allocate(256);
      this.requestPointers.set(lr, pointer);
    }
    return formatPointer(pointer);
  }

  async open(): Promise<number> {
    if (this.defConn !== null && this.defConn.status === ConnStatus.CONNECTED) return 0;
    return (await this.openDefconn()) === 0 ? 0 : -1;
  }

  private async openDefconn(): Promise<number> {
    const conn = await this.newConnection(this.options.urls, true, true, null);
    if (conn === null) {
      this.errno = LdapRc.SERVER_DOWN;
      return -1;
    }
    this.defConn = conn;
    ++conn.refcnt;
    return 0;
  }

  private lowestFreeDescriptor(): number {
    let descriptor = 3 + this.reservedDescriptors;
    while (this.openDescriptors.has(descriptor)) descriptor++;
    return descriptor;
  }

  private async newConnection(
    srvlist: readonly LdapUrlDesc[], useLdsb: boolean, connect: boolean, bind: RebindInfo | null,
  ): Promise<LdapConn | null> {
    this.log.debug(LdapDebug.TRACE, `ldap_new_connection ${useLdsb ? 1 : 0} ${connect ? 1 : 0} ${bind !== null ? 1 : 0}\n`);
    let lc: LdapConn | null = null;
    if (connect) {
      for (const server of srvlist) {
        const opened = await this.openConnection(server);
        if (opened !== null) {
          lc = opened;
          lc.server = { ...server, attrs: server.attrs ? [...server.attrs] : null, exts: server.exts ? [...server.exts] : null };
          break;
        }
      }
      if (lc === null) {
        this.errno = LdapRc.SERVER_DOWN;
        return null;
      }
    }
    if (lc === null) return null;
    lc.isDefault = useLdsb;
    lc.status = ConnStatus.CONNECTED;
    this.conns.unshift(lc);

    if (connect && lc.server !== null && lc.server.exts !== null) {
      const ext = this.findTlsExt(lc.server);
      if (ext !== 0) {
        const savedDefault = this.defConn;
        ++lc.refcnt;
        this.defConn = lc;
        const rc = await this.startTlsSync({ serverName: lc.server.host ?? '', tls: this.options.tls });
        this.defConn = savedDefault;
        --lc.refcnt;
        if (rc !== LdapRc.SUCCESS && ext === 2) {
          this.freeConnection(lc, true, false);
          return null;
        }
      }
    }

    if (bind !== null) {
      let err = 0;
      lc.rebindInProgress = true;
      const savedDefault = this.defConn;
      ++lc.refcnt;
      this.defConn = lc;
      this.log.debug(LdapDebug.TRACE, 'anonymous rebind via ldap_sasl_bind("")\n');
      const sent = await this.saslBindSimple('', new Uint8Array(0), null);
      if (sent.rc !== LdapRc.SUCCESS) {
        err = -1;
      } else {
        for (err = 1; err > 0;) {
          const outcome = await this.resultRaw(sent.messageId, LdapMsg.ALL, { seconds: 0, microseconds: 100000 });
          if (outcome.rc === -1) {
            err = -1;
          } else if (outcome.rc === 0) {
            err = 1;
          } else if (outcome.rc === LdapRes.BIND && outcome.result !== null) {
            const parsed = this.parseResultChain(outcome.result, true);
            err = parsed !== LdapRc.SUCCESS ? -1 : this.errno !== LdapRc.SUCCESS ? -1 : 0;
          } else {
            this.log.debug(
              LdapDebug.TRACE,
              `ldap_new_connection ${this.ld()}: unexpected response ${outcome.rc} from BIND request id=${sent.messageId}\n`,
            );
            err = -1;
          }
        }
      }
      this.defConn = savedDefault;
      --lc.refcnt;
      if (err !== 0) {
        this.freeConnection(lc, true, false);
        return null;
      }
      lc.rebindInProgress = false;
    }
    return lc;
  }

  private findTlsExt(server: LdapUrlDesc): number {
    if (server.exts === null) return 0;
    for (const raw of server.exts) {
      let ext = raw;
      let crit = 0;
      if (ext.startsWith('!')) {
        ext = ext.slice(1);
        crit = 1;
      }
      const lower = ext.toLowerCase();
      if (lower === 'starttls' || lower === 'x-starttls' || ext === START_TLS_OID) return crit + 1;
    }
    return 0;
  }

  private async openConnection(srv: LdapUrlDesc): Promise<LdapConn | null> {
    this.log.debug(LdapDebug.TRACE, 'ldap_int_open_connection\n');
    const proto = urlScheme2Proto(srv.scheme);
    if (proto !== 'tcp') return null;
    const connected = await this.connectToHost(srv);
    if (connected === null) return null;
    const sb = new Sockbuf(connected.channel, this.log);
    sb.descriptor = connected.descriptor;
    const conn = new LdapConn(sb);
    conn.descriptor = connected.descriptor;
    conn.created = this.clock.now();
    conn.lastUsed = conn.created;
    if (srv.scheme === 'ldaps') {
      ++conn.refcnt;
      const outcome = connected.channel.upgradeTls({ serverName: srv.host ?? '', tls: this.options.tls, implicit: true });
      --conn.refcnt;
      if ('detail' in outcome) {
        this.errno = LdapRc.CONNECT_ERROR;
        this.errorText = outcome.detail;
        this.closeSocket(conn);
        return null;
      }
    }
    return conn;
  }

  private closeSocket(conn: LdapConn): void {
    conn.sb.channel.close();
    this.openDescriptors.delete(conn.descriptor);
  }

  private async connectToHost(srv: LdapUrlDesc): Promise<{ channel: LdapChannel; descriptor: number } | null> {
    const host = srv.host === null || srv.host === '' ? 'localhost' : srv.host;
    const port = urlSchemePort(srv.scheme, srv.port);
    this.log.debug(LdapDebug.TRACE, `ldap_connect_to_host: TCP ${host}:${port}\n`);
    const addresses = await this.transport.resolve(host);
    if (addresses === null || addresses.length === 0) {
      this.log.debug(LdapDebug.TRACE, 'ldap_connect_to_host: getaddrinfo failed: Name or service not known\n');
      return null;
    }
    for (const address of addresses) {
      const descriptor = this.lowestFreeDescriptor();
      this.openDescriptors.add(descriptor);
      this.log.debug(LdapDebug.TRACE, `ldap_new_socket: ${descriptor}\n`);
      this.log.debug(LdapDebug.TRACE, `ldap_prepare_socket: ${descriptor}\n`);
      const separator = address.includes(':') ? ' ' : ':';
      this.log.debug(LdapDebug.TRACE, `ldap_connect_to_host: Trying ${address}${separator}${port}\n`);
      const networkTimeout = this.options.networkTimeout !== null && this.options.networkTimeout >= 0
        ? this.options.networkTimeout : -1;
      this.log.debug(LdapDebug.TRACE, `ldap_pvt_connect: fd: ${descriptor} tm: ${networkTimeout} async: 0\n`);
      this.log.debug(LdapDebug.TRACE, 'attempting to connect: \n');
      const outcome = this.transport.connect(address, port);
      if (outcome.kind === 'connected') {
        this.log.debug(LdapDebug.TRACE, 'connect success\n');
        return { channel: outcome.channel, descriptor };
      }
      this.log.debug(LdapDebug.TRACE, `connect errno: ${outcome.errno}\n`);
      this.log.debug(LdapDebug.TRACE, `ldap_close_socket: ${descriptor}\n`);
      this.openDescriptors.delete(descriptor);
    }
    return null;
  }

  private findConnection(srv: readonly LdapUrlDesc[], any: boolean): LdapConn | null {
    for (const lc of this.conns) {
      const lcu = lc.server;
      if (lcu === null) continue;
      const lcuPort = urlSchemePort(lcu.scheme, lcu.port);
      for (const lsu of srv) {
        const lsuPort = urlSchemePort(lsu.scheme, lsu.port);
        if (lsuPort === lcuPort && lcu.scheme === lsu.scheme
          && lcu.host !== null && lsu.host !== null && lsu.host.toLowerCase() === lcu.host.toLowerCase()) {
          return lc;
        }
        if (!any) break;
      }
    }
    return null;
  }

  private useConnection(lc: LdapConn): void {
    ++lc.refcnt;
    lc.lastUsed = this.clock.now();
  }

  private freeConnection(lc: LdapConn, force: boolean, unbind: boolean): void {
    this.log.debug(LdapDebug.TRACE, `ldap_free_connection ${force ? 1 : 0} ${unbind ? 1 : 0}\n`);
    if (force || --lc.refcnt <= 0) {
      const index = this.conns.indexOf(lc);
      if (index >= 0) {
        this.conns.splice(index, 1);
        if (this.defConn === lc) this.defConn = null;
      }
      if (lc.status === ConnStatus.CONNECTED && unbind) this.sendUnbind(lc);
      if (force) this.freeAllRequests();
      this.closeSocket(lc);
      this.log.debug(LdapDebug.TRACE, 'ldap_free_connection: actually freed\n');
    } else {
      lc.lastUsed = this.clock.now();
      this.log.debug(LdapDebug.TRACE, `ldap_free_connection: refcnt ${lc.refcnt}\n`);
    }
  }

  private sendUnbind(lc: LdapConn): void {
    this.log.debug(LdapDebug.TRACE, 'ldap_send_unbind\n');
    const id = this.allocateMessageId();
    const pdu = encodeLdapMessage({ messageID: id, protocolOp: { kind: 'unbindRequest' }, controls: [] });
    lc.sb.flush(pdu);
  }

  private freeAllRequests(): void {
    for (const lr of [...this.requests.values()].sort((a, b) => a.msgid - b.msgid)) this.doFreeRequest(lr);
    this.requests.clear();
  }

  private doFreeRequest(lr: LdapReq): void {
    this.log.debug(
      LdapDebug.TRACE,
      `ldap_do_free_request: asked to free lr ${this.requestPointer(lr)} msgid ${lr.msgid} refcnt ${lr.refcnt}\n`,
    );
    if (lr.refcnt > 0) {
      lr.refcnt = -lr.refcnt;
      return;
    }
    lr.ber = null;
  }

  private freeRequestInt(lr: LdapReq): void {
    const removed = this.requests.get(lr.msgid) === lr;
    if (removed) this.requests.delete(lr.msgid);
    this.log.debug(
      LdapDebug.TRACE,
      `ldap_free_request_int: lr ${this.requestPointer(lr)} msgid ${lr.msgid}${removed ? '' : ' not'} removed\n`,
    );
    this.doFreeRequest(lr);
  }

  private freeRequest(lr: LdapReq): void {
    this.log.debug(LdapDebug.TRACE, `ldap_free_request (origid ${lr.origid}, msgid ${lr.msgid})\n`);
    while (lr.child !== null) this.freeRequest(lr.child);
    if (lr.parent !== null) {
      --lr.parent.outrefcnt;
      let cursor: LdapReq | null = lr.parent.child;
      let previous: LdapReq | null = null;
      while (cursor !== null && cursor !== lr) {
        previous = cursor;
        cursor = cursor.refnext;
      }
      if (cursor === lr) {
        if (previous === null) lr.parent.child = lr.refnext;
        else previous.refnext = lr.refnext;
      }
    }
    this.freeRequestInt(lr);
  }

  private findRequestByMsgid(msgid: number): LdapReq | null {
    const lr = this.requests.get(msgid) ?? null;
    if (lr !== null && lr.status !== ReqStatus.COMPLETED) {
      lr.refcnt++;
      this.log.debug(
        LdapDebug.TRACE,
        `ldap_find_request_by_msgid: msgid ${msgid}, lr ${this.requestPointer(lr)} lr->lr_refcnt = ${lr.refcnt}\n`,
      );
      return lr;
    }
    this.log.debug(
      LdapDebug.TRACE,
      `ldap_find_request_by_msgid: msgid ${msgid}, lr ${lr === null ? '(nil)' : this.requestPointer(lr)}\n`,
    );
    return null;
  }

  private returnRequest(lrx: LdapReq, freeit: boolean): void {
    let lr: LdapReq | null = this.requests.get(lrx.msgid) ?? null;
    this.log.debug(
      LdapDebug.TRACE,
      `ldap_return_request: lrx ${this.requestPointer(lrx)}, lr ${lr === null ? '(nil)' : this.requestPointer(lr)}\n`,
    );
    if (lr !== null) {
      if (lr.refcnt > 0) {
        lr.refcnt--;
      } else if (lr.refcnt < 0) {
        lr.refcnt++;
        if (lr.refcnt === 0) lr = null;
      }
    }
    this.log.debug(
      LdapDebug.TRACE,
      `ldap_return_request: lrx->lr_msgid ${lrx.msgid}, lrx->lr_refcnt is now ${lrx.refcnt}, lr is ${lr !== null ? 'still' : 'not'} present\n`,
    );
    if (lr === null) this.freeRequestInt(lrx);
    else if (freeit) this.freeRequest(lrx);
  }

  private newRequestBer(op: ProtocolOp, controls: readonly LdapControl[], msgid: number): BerElement {
    const pdu = encodeLdapMessage({ messageID: msgid, protocolOp: op, controls: [...controls] });
    return new BerElement(pdu, this.heap.allocate(pdu.length + 1), this.log);
  }

  private async sendInitialRequest(
    ber: BerElement, op: ProtocolOp, controls: readonly LdapControl[], msgid: number,
  ): Promise<number> {
    this.log.debug(LdapDebug.TRACE, 'ldap_send_initial_request\n');
    let rc = 1;
    if (this.defConn === null || this.defConn.status === ConnStatus.CLOSED) {
      rc = await this.openDefconn();
      if (rc === 0) this.log.debug(LdapDebug.TRACE, 'ldap_open_defconn: successful\n');
    }
    if (rc < 0) return -1;
    return this.sendServerRequest(ber, op, controls, msgid, null, null, null, null);
  }

  private async sendServerRequest(
    ber: BerElement, op: ProtocolOp, controls: readonly LdapControl[], msgid: number,
    parentreq: LdapReq | null, srvlist: readonly LdapUrlDesc[] | null, lcIn: LdapConn | null, bind: RebindInfo | null,
  ): Promise<number> {
    this.log.debug(LdapDebug.TRACE, 'ldap_send_server_request\n');
    let incparent = false;
    this.errno = LdapRc.SUCCESS;
    let lc = lcIn;
    if (lc === null) {
      if (srvlist === null) {
        lc = this.defConn;
      } else {
        lc = this.findConnection(srvlist, true);
        if (lc === null) {
          if (bind !== null && parentreq !== null) {
            incparent = true;
            ++parentreq.outrefcnt;
          }
          lc = await this.newConnection(srvlist, false, true, bind);
        }
      }
    }
    if (lc === null || lc.status !== ConnStatus.CONNECTED) {
      if (this.errno === LdapRc.SUCCESS) this.errno = LdapRc.SERVER_DOWN;
      if (incparent && parentreq !== null) --parentreq.outrefcnt;
      return -1;
    }
    this.useConnection(lc);

    const lr = new LdapReq();
    lr.msgid = msgid;
    lr.status = ReqStatus.INPROGRESS;
    lr.resErrno = LdapRc.SUCCESS;
    lr.ber = ber;
    lr.op = op;
    lr.controls = controls;
    lr.conn = lc;
    if (parentreq !== null) {
      if (!incparent) ++parentreq.outrefcnt;
      lr.origid = parentreq.origid;
      lr.parentcnt = ++parentreq.parentcnt;
      lr.parent = parentreq;
      lr.refnext = parentreq.child;
      parentreq.child = lr;
    } else {
      lr.origid = lr.msgid;
    }

    const tmpber = ber.copy();
    tmpber.ptr = 0;
    tmpber.scanf('{it');
    const tag = this.requestTag(op);
    if (tag === ReqTag.BIND) tmpber.scanf('{i');
    else if (tag !== ReqTag.DELETE && tag !== ReqTag.ABANDON) tmpber.scanf('{');
    lr.dn = this.requestDn(op);
    this.requests.set(lr.msgid, lr);

    this.errno = LdapRc.SUCCESS;
    if (!this.flushRequest(lr)) return -1;
    return msgid;
  }

  private requestTag(op: ProtocolOp): number {
    switch (op.kind) {
      case 'bindRequest': return ReqTag.BIND;
      case 'unbindRequest': return ReqTag.UNBIND;
      case 'searchRequest': return ReqTag.SEARCH;
      case 'delRequest': return ReqTag.DELETE;
      case 'abandonRequest': return ReqTag.ABANDON;
      default: return 0;
    }
  }

  private requestDn(op: ProtocolOp): string {
    switch (op.kind) {
      case 'bindRequest': return op.name;
      case 'searchRequest': return op.baseObject;
      case 'delRequest': return op.entry;
      case 'extendedRequest': return op.requestName;
      default: return '';
    }
  }

  private flushRequest(lr: LdapReq): boolean {
    const lc = lr.conn as LdapConn;
    const ber = lr.ber as BerElement;
    const pdu = ber.buf.slice(0, ber.end);
    if (!lc.sb.flush(pdu)) {
      this.errno = LdapRc.SERVER_DOWN;
      this.freeRequest(lr);
      this.freeConnection(lc, false, false);
      return false;
    }
    lr.status = ReqStatus.INPROGRESS;
    return true;
  }

  async saslBindSimple(
    dn: string | null, password: Uint8Array | null, controls: readonly LdapControl[] | null,
  ): Promise<{ rc: number; messageId: number }> {
    this.log.debug(LdapDebug.TRACE, 'ldap_sasl_bind\n');
    const messageId = this.allocateMessageId();
    const credentials = password ?? new Uint8Array(0);
    const op: ProtocolOp = {
      kind: 'bindRequest', version: this.options.version, name: dn ?? '',
      password: new TextDecoder().decode(credentials), credentials,
    };
    const effective = this.effectiveControls(controls);
    const ber = this.newRequestBer(op, effective, messageId);
    const id = await this.sendInitialRequest(ber, op, effective, messageId);
    if (id < 0) return { rc: this.errno, messageId: -1 };
    return { rc: LdapRc.SUCCESS, messageId: id };
  }

  private effectiveControls(explicit: readonly LdapControl[] | null): readonly LdapControl[] {
    return explicit ?? this.serverControls ?? [];
  }

  async searchExt(spec: SearchRequestSpec, entryPoint = 'ldap_search_ext'): Promise<{ rc: number; messageId: number }> {
    this.log.debug(LdapDebug.TRACE, `${entryPoint}\n`);
    let timeLimit = this.options.timeLimit;
    if (spec.timeoutSeconds !== null && spec.timeoutSeconds === 0) return { rc: LdapRc.PARAM_ERROR, messageId: -1 };
    const messageId = this.allocateMessageId();
    const filter = putFilter(spec.filter, (line) => this.log.debug(LdapDebug.TRACE, line));
    if (filter === null) {
      this.errno = LdapRc.FILTER_ERROR;
      return { rc: LdapRc.FILTER_ERROR, messageId: -1 };
    }
    if (spec.timeoutSeconds !== null) timeLimit = spec.timeoutSeconds;
    const base = spec.base ?? this.options.defBase ?? '';
    if (this.log.enabled(LdapDebug.ARGS)) {
      const shown = spec.attributes === null ? ' *' : spec.attributes.map(attribute => ` ${attribute}`).join('');
      this.log.debug(LdapDebug.ARGS, `ldap_build_search_req ATTRS:${shown}\n`);
    }
    const op: ProtocolOp = {
      kind: 'searchRequest', baseObject: base, scope: SCOPE_NAMES[spec.scope],
      derefAliases: this.options.deref,
      sizeLimit: spec.sizeLimit < 0 ? this.options.sizeLimit : spec.sizeLimit,
      timeLimit,
      typesOnly: spec.attrsOnly,
      filter,
      attributes: spec.attributes === null ? [] : [...spec.attributes],
    };
    const effective = this.effectiveControls(spec.serverControls);
    const ber = this.newRequestBer(op, effective, messageId);
    const id = await this.sendInitialRequest(ber, op, effective, messageId);
    if (id < 0) return { rc: this.errno, messageId: -1 };
    this.errno = LdapRc.SUCCESS;
    return { rc: LdapRc.SUCCESS, messageId: id };
  }

  async extendedOperation(
    requestName: string, requestValue: Uint8Array | null,
  ): Promise<{ rc: number; messageId: number }> {
    this.log.debug(LdapDebug.TRACE, 'ldap_extended_operation\n');
    const messageId = this.allocateMessageId();
    const op: ProtocolOp = { kind: 'extendedRequest', requestName, requestValue: requestValue ?? undefined };
    const effective = this.effectiveControls(null);
    const ber = this.newRequestBer(op, effective, messageId);
    const id = await this.sendInitialRequest(ber, op, effective, messageId);
    if (id < 0) return { rc: this.errno, messageId: -1 };
    this.errno = LdapRc.SUCCESS;
    return { rc: LdapRc.SUCCESS, messageId: id };
  }

  private isAbandoned(msgid: number): boolean {
    return this.abandoned.includes(msgid);
  }

  private markAbandoned(msgid: number): void {
    const index = this.abandoned.indexOf(msgid);
    if (index >= 0) this.abandoned.splice(index, 1);
  }

  private dumpConnections(): void {
    this.log.debug(LdapDebug.TRACE, `** ld ${this.ld()} Connections:\n`);
    for (const lc of this.conns) {
      if (lc.server !== null) {
        this.log.debug(
          LdapDebug.TRACE,
          `* host: ${lc.server.host ?? '(null)'}  port: ${lc.server.port}${lc.isDefault ? '  (default)' : ''}\n`,
        );
      }
      this.log.debug(LdapDebug.TRACE, `* from: ${lc.sb.channel.localEndpoint}\n`);
      const status = lc.status === ConnStatus.NEEDSOCKET ? 'NeedSocket'
        : lc.status === ConnStatus.CONNECTING ? 'Connecting' : 'Connected';
      this.log.debug(LdapDebug.TRACE, `  refcnt: ${lc.refcnt}  status: ${status}\n`);
      this.log.debug(
        LdapDebug.TRACE,
        `  last used: ${this.clock.ctime(lc.lastUsed)}${lc.rebindInProgress ? '  rebind in progress' : ''}\n`,
      );
      if (lc.rebindInProgress) {
        if (lc.rebindQueue !== null) {
          lc.rebindQueue.forEach((refs, i) => refs.forEach((ref, j) => {
            this.log.debug(LdapDebug.TRACE, `    queue ${i} entry ${j} - ${ref}\n`);
          }));
        } else {
          this.log.debug(LdapDebug.TRACE, '    queue is empty\n');
        }
      }
      this.log.debug(LdapDebug.TRACE, '\n');
    }
  }

  private dumpRequestsAndResponses(): void {
    this.log.debug(LdapDebug.TRACE, `** ld ${this.ld()} Outstanding Requests:\n`);
    const sorted = [...this.requests.values()].sort((a, b) => a.msgid - b.msgid);
    if (sorted.length === 0) this.log.debug(LdapDebug.TRACE, '   Empty\n');
    for (const lr of sorted) {
      const status = lr.status === ReqStatus.INPROGRESS ? 'InProgress'
        : lr.status === ReqStatus.CHASINGREFS ? 'ChasingRefs'
          : lr.status === ReqStatus.NOTCONNECTED ? 'NotConnected'
            : lr.status === ReqStatus.WRITING ? 'Writing'
              : lr.status === ReqStatus.COMPLETED ? 'RequestCompleted' : 'InvalidStatus';
      this.log.debug(LdapDebug.TRACE, ` * msgid ${lr.msgid},  origid ${lr.origid}, status ${status}\n`);
      this.log.debug(LdapDebug.TRACE, `   outstanding referrals ${lr.outrefcnt}, parent count ${lr.parentcnt}\n`);
    }
    this.log.debug(LdapDebug.TRACE, `  ld ${this.ld()} request count ${sorted.length} (abandoned ${this.abandoned.length})\n`);
    this.log.debug(LdapDebug.TRACE, `** ld ${this.ld()} Response Queue:\n`);
    let count = 0;
    if (this.responses === null) this.log.debug(LdapDebug.TRACE, '   Empty\n');
    for (let lm = this.responses; lm !== null; lm = lm.next, count++) {
      this.log.debug(LdapDebug.TRACE, ` * msgid ${lm.msgid},  type ${lm.msgtype}\n`);
      if (lm.chain !== null) {
        this.log.debug(LdapDebug.TRACE, '   chained responses:\n');
        for (let l: RespMsg | null = lm.chain; l !== null; l = l.chain) {
          this.log.debug(LdapDebug.TRACE, `  * msgid ${l.msgid},  type ${l.msgtype}\n`);
        }
      }
    }
    this.log.debug(LdapDebug.TRACE, `  ld ${this.ld()} response count ${count}\n`);
  }

  private chkResponseList(msgid: number, all: number): RespMsg | null {
    this.log.debug(LdapDebug.TRACE, `ldap_chkResponseList ld ${this.ld()} msgid ${msgid} all ${all}\n`);
    let previous: RespMsg | null = null;
    let lm: RespMsg | null = this.responses;
    while (lm !== null) {
      const nextlm: RespMsg | null = lm.next;
      if (this.isAbandoned(lm.msgid)) {
        this.log.debug(
          LdapDebug.ANY,
          `response list msg abandoned, msgid ${lm.msgid} message type ${msgtype2str(lm.msgtype)}\n`,
        );
        if (lm.msgtype !== LdapRes.SEARCH_ENTRY && lm.msgtype !== LdapRes.SEARCH_REFERENCE && lm.msgtype !== LdapRes.INTERMEDIATE) {
          this.markAbandoned(lm.msgid);
        }
        if (previous === null) this.responses = nextlm;
        else previous.next = nextlm;
        this.log.debug(LdapDebug.TRACE, 'ldap_msgfree\n');
        lm = nextlm;
        continue;
      }
      if (msgid === LDAP_RES_ANY || lm.msgid === msgid) {
        if (all === LdapMsg.ONE || all === LdapMsg.RECEIVED || msgid === LDAP_RES_UNSOLICITED) break;
        const tail: RespMsg = lm.chainTail;
        const incomplete = tail.msgtype === LdapRes.SEARCH_ENTRY || tail.msgtype === LdapRes.SEARCH_REFERENCE
          || tail.msgtype === LdapRes.INTERMEDIATE;
        if (incomplete) lm = null;
        break;
      }
      previous = lm;
      lm = nextlm;
    }
    if (lm !== null) {
      if (all === LdapMsg.ONE && lm.chain !== null) {
        const chainHead: RespMsg = lm.chain;
        if (previous === null) this.responses = chainHead;
        else previous.next = chainHead;
        chainHead.next = lm.next;
        chainHead.chainTail = lm.chainTail !== lm ? lm.chainTail : chainHead;
        lm.chain = null;
        lm.chainTail = lm;
      } else if (previous === null) {
        this.responses = lm.next;
      } else {
        previous.next = lm.next;
      }
      lm.next = null;
    }
    if (lm === null) {
      this.log.debug(LdapDebug.TRACE, `ldap_chkResponseList returns ld ${this.ld()} NULL\n`);
    } else {
      this.log.debug(
        LdapDebug.TRACE,
        `ldap_chkResponseList returns ld ${this.ld()} msgid ${lm.msgid}, type 0x${lm.msgtype.toString(16).padStart(2, '0')}\n`,
      );
    }
    return lm;
  }

  async result(
    messageId: number, all: number, timeout: WaitTimeout | null = null,
  ): Promise<ResultBatch | null> {
    const outcome = await this.resultRaw(messageId, all, timeout);
    if (outcome.rc <= 0 || outcome.result === null) return null;
    return this.batchOf(outcome.result, outcome.rc);
  }

  private batchOf(head: RespMsg, type: number): ResultBatch {
    const messages: LdapMessage[] = [];
    for (let lm: RespMsg | null = head; lm !== null; lm = lm.chain) {
      messages.push(lm.message);
      this.responseIndex.set(lm.message, lm);
    }
    return { type, messages };
  }

  private async resultRaw(messageId: number, all: number, timeout: WaitTimeout | null): Promise<WaitOutcome> {
    this.log.debug(LdapDebug.TRACE, `ldap_result ld ${this.ld()} msgid ${messageId}\n`);
    if (this.errno === LdapRc.LOCAL_ERROR || this.errno === LdapRc.SERVER_DOWN) return { rc: -1, result: null };
    return this.wait4msg(messageId, all, timeout);
  }

  private async wait4msg(msgid: number, all: number, timeoutIn: WaitTimeout | null): Promise<WaitOutcome> {
    let timeout = timeoutIn;
    if (timeout === null && this.options.timeout !== null && this.options.timeout >= 0) {
      timeout = { seconds: this.options.timeout, microseconds: 0 };
    }
    if (timeout === null) {
      this.log.debug(LdapDebug.TRACE, `wait4msg ld ${this.ld()} msgid ${msgid} (infinite timeout)\n`);
    } else {
      this.log.debug(
        LdapDebug.TRACE,
        `wait4msg ld ${this.ld()} msgid ${msgid} (timeout ${timeout.seconds * 1000000 + timeout.microseconds} usec)\n`,
      );
    }
    let remaining: { seconds: number; microseconds: number } | null = null;
    let startMicroseconds = 0;
    if (timeout !== null && timeout.seconds !== -1) {
      remaining = { seconds: timeout.seconds, microseconds: timeout.microseconds };
      startMicroseconds = this.clock.nowMicroseconds();
    }
    let rc: number = LDAP_MSG_X_KEEP_LOOKING;
    let result: RespMsg | null = null;
    while (rc === LDAP_MSG_X_KEEP_LOOKING) {
      if (this.log.enabled(LdapDebug.TRACE)) {
        this.log.debug(LdapDebug.TRACE, `wait4msg continue ld ${this.ld()} msgid ${msgid} all ${all}\n`);
        this.dumpConnections();
        this.dumpRequestsAndResponses();
      }
      result = this.chkResponseList(msgid, all);
      if (result !== null) {
        rc = result.msgtype;
        continue;
      }
      this.log.debug(LdapDebug.TRACE, 'ldap_int_select\n');
      const ready = this.conns.some(lc => lc.status === ConnStatus.CONNECTED && lc.sb.channel.readable());
      if (!ready) {
        this.errno = LdapRc.TIMEOUT;
        return { rc: 0, result: null };
      }
      rc = LDAP_MSG_X_KEEP_LOOKING;
      let serviced = false;
      for (const lc of [...this.conns]) {
        if (rc !== LDAP_MSG_X_KEEP_LOOKING) break;
        if (lc.status === ConnStatus.CONNECTED && lc.sb.channel.readable()) {
          serviced = true;
          ++lc.refcnt;
          const read = await this.tryRead1msg(msgid, all, lc);
          rc = read.rc;
          if (read.result !== null) result = read.result;
          if (lc.refcnt <= 1) this.freeConnection(lc, false, true);
          else --lc.refcnt;
        }
      }
      if (!serviced) rc = -1;
      if (rc === LDAP_MSG_X_KEEP_LOOKING && remaining !== null) {
        const currentMicroseconds = this.clock.nowMicroseconds();
        let deltaSeconds = Math.floor((currentMicroseconds - startMicroseconds) / 1000000);
        let deltaMicroseconds = (currentMicroseconds - startMicroseconds) - deltaSeconds * 1000000;
        if (deltaMicroseconds < 0) {
          deltaSeconds--;
          deltaMicroseconds += 1000000;
        }
        if (remaining.seconds < deltaSeconds || (remaining.seconds === deltaSeconds && remaining.microseconds < deltaMicroseconds)) {
          this.errno = LdapRc.TIMEOUT;
          return { rc: 0, result: null };
        }
        remaining = { seconds: remaining.seconds - deltaSeconds, microseconds: remaining.microseconds - deltaMicroseconds };
        if (remaining.microseconds < 0) {
          remaining = { seconds: remaining.seconds - 1, microseconds: remaining.microseconds + 1000000 };
        }
        this.log.debug(LdapDebug.TRACE, `wait4msg ld ${this.ld()} ${remaining.seconds} s ${remaining.microseconds} us to go\n`);
        startMicroseconds = currentMicroseconds;
      }
    }
    if (rc < 0) return { rc, result: null };
    return { rc, result };
  }

  private async tryRead1msg(msgid: number, all: number, lc: LdapConn): Promise<WaitOutcome> {
    this.log.debug(LdapDebug.TRACE, `read1msg: ld ${this.ld()} msgid ${msgid} all ${all}\n`);
    const next = berGetNext(lc.sb, lc.berState, this.log, (size) => this.heap.allocate(size));
    if (next.kind === 'again') return { rc: LDAP_MSG_X_KEEP_LOOKING, result: null };
    if (next.kind === 'failed' || next.tag !== LDAP_TAG_MESSAGE) {
      this.log.debug(LdapDebug.CONNS, `ber_get_next failed, errno=${next.kind === 'failed' ? 0 : 34}.\n`);
      this.errno = LdapRc.SERVER_DOWN;
      --lc.refcnt;
      lc.status = ConnStatus.CLOSED;
      return { rc: -1, result: null };
    }
    const ber = next.ber;
    const idRead = ber.getInt();
    if (idRead.tag === LBER_DEFAULT) {
      this.errno = LdapRc.DECODING_ERROR;
      return { rc: -1, result: null };
    }
    let id = idRead.value;
    if (id < 0) return { rc: LDAP_MSG_X_KEEP_LOOKING, result: null };

    const dummy = new LdapReq();
    let lr: LdapReq | null = null;
    if (id > 0) {
      if (this.isAbandoned(id)) {
        const peek = ber.peekTag().tag;
        if (peek !== LdapRes.SEARCH_ENTRY && peek !== LdapRes.SEARCH_REFERENCE && peek !== LdapRes.INTERMEDIATE && peek !== LBER_DEFAULT) {
          this.markAbandoned(id);
        }
        this.log.debug(
          LdapDebug.ANY,
          `abandoned/discarded ld ${this.ld()} msgid ${id} message type ${msgtype2str(peek)}\n`,
        );
        return { rc: LDAP_MSG_X_KEEP_LOOKING, result: null };
      }
      lr = this.findRequestByMsgid(id);
      if (lr === null) {
        const peek = ber.peekTag().tag;
        const name = peek === LBER_DEFAULT ? 'unknown' : msgtype2str(peek);
        this.log.debug(
          LdapDebug.ANY,
          `no request for response on ld ${this.ld()} msgid ${id} message type ${name} (tossing)\n`,
        );
        return { rc: LDAP_MSG_X_KEEP_LOOKING, result: null };
      }
    }
    let tag = ber.peekTag().tag;
    if (tag === LBER_DEFAULT) {
      this.errno = LdapRc.DECODING_ERROR;
      return { rc: -1, result: null };
    }
    this.log.debug(
      LdapDebug.TRACE,
      `read1msg: ld ${this.ld()} msgid ${id} message type ${msgtype2str(tag)}\n`,
    );
    if (id === 0) {
      if (tag !== LdapRes.EXTENDED) return { rc: LDAP_MSG_X_KEEP_LOOKING, result: null };
      lr = dummy;
    }
    let decoded: LdapMessage;
    try {
      decoded = decodeLdapMessage(next.pdu);
    } catch {
      this.errno = LdapRc.DECODING_ERROR;
      return { rc: -1, result: null };
    }
    let current = lr as LdapReq | null;
    const request = lr as LdapReq;
    id = request.origid;
    let referCnt = 0;
    let hadref = false;
    let simpleRequest = false;
    let rc: number = LDAP_MSG_X_KEEP_LOOKING;
    request.resMsgType = tag;
    let berLive: BerElement | null = ber;
    let synthesized: LdapMessage | null = null;
    let lcLive: LdapConn | null = lc;
    const tmpber = ber.copy();

    if (tag === LdapRes.SEARCH_REFERENCE) {
      if (this.options.version > LdapVersion.V2 && (this.options.referrals || request.parent !== null)) {
        if (tmpber.scanf('{v}') === LBER_DEFAULT) {
          rc = LdapRc.DECODING_ERROR;
        } else {
          const uris = decoded.protocolOp.kind === 'searchResultReference' ? [...decoded.protocolOp.uris] : [];
          const chased = await this.chaseV3Referrals(request, uris, true);
          referCnt = chased.count;
          hadref = chased.hadref;
          request.resError = chased.unfollowed;
          if (referCnt > 0 && request.status !== ReqStatus.COMPLETED) {
            request.status = ReqStatus.CHASINGREFS;
            this.log.debug(
              LdapDebug.TRACE,
              `read1msg:  search ref chased, mark request chasing refs, id = ${request.msgid}\n`,
            );
          }
        }
      }
    } else if (tag !== LdapRes.SEARCH_ENTRY && tag !== LdapRes.INTERMEDIATE) {
      const result = resultOf(decoded);
      let lderr = -1;
      if (tmpber.scanf('{eAA') !== LBER_DEFAULT && result !== null) {
        lderr = result.resultCode;
        request.resMatched = result.matchedDN;
        if (request.resError !== null) request.resError = this.appendReferral(request.resError, result.diagnosticMessage);
        else request.resError = result.diagnosticMessage;
        if (tag !== LdapRes.BIND && (this.options.referrals || request.parent !== null)) {
          if (tmpber.peekTag().tag === LDAP_TAG_REFERRAL) {
            if (this.options.version > LdapVersion.V2) {
              if (tmpber.scanf('{v}') === LBER_DEFAULT) {
                rc = LdapRc.DECODING_ERROR;
                request.status = ReqStatus.COMPLETED;
                this.log.debug(
                  LdapDebug.TRACE,
                  `read1msg: referral decode error, mark request completed, ld ${this.ld()} msgid ${request.msgid}\n`,
                );
              } else {
                const chased = await this.chaseV3Referrals(request, result.referral ? [...result.referral] : [], false);
                referCnt = chased.count;
                hadref = chased.hadref;
                request.resError = chased.unfollowed;
                request.status = ReqStatus.COMPLETED;
                this.log.debug(
                  LdapDebug.TRACE,
                  `read1msg: referral ${referCnt > 0 ? '' : 'not'} chased, mark request completed, ld ${this.ld()} msgid ${request.msgid}\n`,
                );
                if (referCnt < 0) referCnt = 0;
              }
            }
          } else if (lderr !== LdapRc.SUCCESS && lderr !== LdapRc.COMPARE_TRUE && lderr !== LdapRc.COMPARE_FALSE) {
            if (request.resError !== null && request.resError === '') request.resError = null;
          }
        }
        if (!hadref || request.resError === null) {
          request.resErrno = lderr === LdapRc.PARTIAL_RESULTS ? LdapRc.SUCCESS : lderr;
        } else if (this.errno !== LdapRc.SUCCESS) {
          request.resErrno = this.errno;
        } else {
          request.resErrno = LdapRc.PARTIAL_RESULTS;
        }
      }
      this.log.debug(LdapDebug.TRACE, `read1msg: ld ${this.ld()} ${referCnt} new referrals\n`);
      if (referCnt !== 0) {
        berLive = null;
        if (referCnt < 0) {
          this.returnRequest(request, false);
          return { rc: -1, result: null };
        }
        request.resErrno = LdapRc.SUCCESS;
        request.resMatched = null;
      } else {
        if (request.outrefcnt <= 0 && request.parent === null) {
          simpleRequest = !hadref;
        } else {
          berLive = null;
        }
        request.status = ReqStatus.COMPLETED;
        this.log.debug(
          LdapDebug.TRACE,
          `read1msg:  mark request completed, ld ${this.ld()} msgid ${request.msgid}\n`,
        );
        const original: LdapReq = request;
        let cursor: LdapReq = request;
        while (cursor.parent !== null) {
          this.mergeErrorInfo(cursor.parent, cursor);
          cursor = cursor.parent;
          if (--cursor.outrefcnt > 0) break;
        }
        if (original.parent !== null) this.returnRequest(original, false);
        let tmplr: LdapReq | null = cursor;
        if (tmplr.status === ReqStatus.COMPLETED) {
          for (tmplr = cursor.child; tmplr !== null; tmplr = tmplr.refnext) {
            if (tmplr.status !== ReqStatus.COMPLETED) break;
          }
        }
        current = cursor;
        if (cursor.outrefcnt <= 0 && cursor.parent === null && tmplr === null) {
          id = cursor.msgid;
          tag = cursor.resMsgType;
          this.log.debug(LdapDebug.TRACE, `request done: ld ${this.ld()} msgid ${id}\n`);
          this.log.debug(
            LdapDebug.TRACE,
            `res_errno: ${cursor.resErrno}, res_error: <${cursor.resError ?? ''}>, res_matched: <${cursor.resMatched ?? ''}>\n`,
          );
          if (!simpleRequest) {
            const built = this.buildResultMessage(cursor);
            berLive = built.ber;
            synthesized = built.message;
          }
          if (cursor !== dummy) this.returnRequest(cursor, true);
          else {
            cursor.resMatched = null;
            cursor.resError = null;
          }
          current = null;
        }
        if (lcLive !== null && id !== 0) {
          --lcLive.refcnt;
          lcLive = null;
        }
      }
    }

    if (current !== null) {
      if (current !== dummy) this.returnRequest(current, false);
      current = null;
    }
    if (berLive === null) return { rc, result: null };

    if (id === 0 && msgid > LDAP_RES_UNSOLICITED) {
      let isNod = false;
      let probe = tmpber.peekTag().tag;
      if (probe === LDAP_TAG_EXOP_RES_OID && decoded.protocolOp.kind === 'extendedResponse') {
        isNod = decoded.protocolOp.responseName === LDAP_NOTICE_OF_DISCONNECTION;
        probe = LBER_DEFAULT;
      }
      if (isNod) {
        if (lcLive !== null) --lcLive.refcnt;
        this.errno = decoded.protocolOp.kind === 'extendedResponse' ? decoded.protocolOp.result.resultCode : LdapRc.SUCCESS;
        return { rc: -1, result: null };
      }
    }

    const newmsg = new RespMsg(id, tag, berLive, { ...(synthesized ?? decoded), messageID: id });
    let foundit = false;
    if (msgid === LDAP_RES_ANY || id === msgid) {
      if (all === LdapMsg.ONE
        || (newmsg.msgtype !== LdapRes.SEARCH_RESULT && newmsg.msgtype !== LdapRes.SEARCH_ENTRY
          && newmsg.msgtype !== LdapRes.INTERMEDIATE && newmsg.msgtype !== LdapRes.SEARCH_REFERENCE)) {
        this.errno = LdapRc.SUCCESS;
        return { rc: tag, result: newmsg };
      }
      if (newmsg.msgtype === LdapRes.SEARCH_RESULT) foundit = true;
    }

    let previous: RespMsg | null = null;
    let existing: RespMsg | null = this.responses;
    for (; existing !== null; existing = existing.next) {
      if (existing.msgid === newmsg.msgid) break;
      previous = existing;
    }
    let found: RespMsg | null = null;
    if (existing === null) {
      if (foundit) {
        found = newmsg;
      } else {
        newmsg.next = this.responses;
        this.responses = newmsg;
      }
    } else {
      this.log.debug(LdapDebug.TRACE, `adding response ld ${this.ld()} msgid ${newmsg.msgid} type ${newmsg.msgtype}:\n`);
      existing.chainTail.chain = newmsg;
      existing.chainTail = newmsg;
      if (foundit) {
        if (previous === null) this.responses = existing.next;
        else previous.next = existing.next;
        found = existing;
      }
    }
    if (foundit) {
      this.errno = LdapRc.SUCCESS;
      return { rc: tag, result: found };
    }
    return { rc: LDAP_MSG_X_KEEP_LOOKING, result: null };
  }

  private buildResultMessage(lr: LdapReq): { ber: BerElement; message: LdapMessage } {
    const result: LdapResult = {
      resultCode: lr.resErrno, matchedDN: lr.resMatched ?? '', diagnosticMessage: lr.resError ?? '',
    };
    const op: ProtocolOp = lr.resMsgType === LdapRes.BIND
      ? { kind: 'bindResponse', result }
      : { kind: 'searchResultDone', result };
    const message: LdapMessage = { messageID: lr.msgid, protocolOp: op, controls: [] };
    const pdu = encodeLdapMessage(message);
    const ber = new BerElement(pdu, this.heap.allocate(pdu.length + 1), this.log);
    ber.skipTag();
    ber.getInt();
    return { ber, message };
  }

  private appendReferral(existing: string, addition: string): string {
    if (addition === '') return existing;
    if (existing === '') return addition;
    return `${existing}\n${addition}`;
  }

  private mergeErrorInfo(parent: LdapReq, lr: LdapReq): void {
    if (lr.resErrno === LdapRc.PARTIAL_RESULTS) {
      parent.resErrno = lr.resErrno;
      if (lr.resError !== null) parent.resError = this.appendReferral(parent.resError ?? '', lr.resError);
    } else if (lr.resErrno !== LdapRc.SUCCESS && parent.resErrno === LdapRc.SUCCESS) {
      parent.resErrno = lr.resErrno;
      parent.resError = lr.resError;
      lr.resError = null;
      if (this.isNameError(lr.resErrno)) {
        parent.resMatched = lr.resMatched;
        lr.resMatched = null;
      }
    }
    this.log.debug(LdapDebug.TRACE, `merged parent (id ${parent.msgid}) error info:  `);
    this.log.debug(
      LdapDebug.TRACE,
      `result errno ${parent.resErrno}, error <${parent.resError ?? ''}>, matched <${parent.resMatched ?? ''}>\n`,
    );
  }

  private isNameError(code: number): boolean {
    return code === LdapRc.NO_SUCH_OBJECT || code === LdapRc.ALIAS_PROBLEM
      || code === LdapRc.INVALID_DN_SYNTAX || code === LdapRc.IS_LEAF || code === LdapRc.ALIAS_DEREF_PROBLEM;
  }

  private async chaseV3Referrals(
    lr: LdapReq, refsIn: readonly string[], sref: boolean,
  ): Promise<{ count: number; hadref: boolean; unfollowed: string | null }> {
    this.log.debug(LdapDebug.TRACE, 'ldap_chase_v3referrals\n');
    this.errno = LdapRc.SUCCESS;
    let hadref = false;
    let unfollowed: string | null = null;
    let count = 0;
    let rc = 0;
    if (refsIn.length === 0) return { count: 0, hadref, unfollowed: null };
    if (lr.parentcnt >= LDAP_REFHOPLIMIT) {
      this.log.debug(LdapDebug.ANY, `more than ${LDAP_REFHOPLIMIT} referral hops (dropping)\n`);
      this.errno = LdapRc.REFERRAL_LIMIT_EXCEEDED;
      return { count: -1, hadref, unfollowed: null };
    }
    let origreq: LdapReq = lr;
    while (origreq.parent !== null) origreq = origreq.parent;
    let refarray = [...refsIn];
    for (let i = 0; i < refarray.length; i++) {
      const parsed = ldapUrlParseExt(refarray[i], LdapUrlParse.NOEMPTY_DN, this.log);
      if (parsed.rc !== LdapUrlErr.SUCCESS || parsed.desc === null) {
        this.errno = LdapRc.PARAM_ERROR;
        return { count: -1, hadref, unfollowed };
      }
      const srv = parsed.desc;
      if (srv.critExts !== 0) {
        const ok = this.findTlsExt(srv) === 2 && srv.critExts === 1;
        if (!ok) {
          this.errno = LdapRc.NOT_SUPPORTED;
          return { count: -1, hadref, unfollowed };
        }
      }
      let lc = this.findConnection([srv], true);
      if (lc !== null) {
        let looped = false;
        const length = srv.dn === null ? 0 : srv.dn.length;
        let lp: LdapReq | null = origreq;
        while (lp !== null) {
          if (lp.conn === lc && length === lp.dn.length && length > 0 && srv.dn === lp.dn) {
            looped = true;
            break;
          }
          lp = lp === origreq ? lp.child : lp.refnext;
        }
        if (looped) {
          this.errno = LdapRc.CLIENT_LOOP;
          rc = -1;
          continue;
        }
        if (lc.rebindInProgress) {
          this.log.debug(LdapDebug.TRACE, `ldap_chase_v3referrals: queue referral "${refarray[i]}"\n`);
          if (lc.rebindQueue === null) lc.rebindQueue = [refarray];
          else lc.rebindQueue.push(refarray);
          return { count: 1, hadref: true, unfollowed: null };
        }
      }
      if (sref && srv.dn === null) srv.dn = '';
      const id = this.allocateMessageId();
      const reencoded = this.reEncodeRequest(origreq, id, sref, srv);
      if (reencoded === null) {
        this.errno = LdapRc.ENCODING_ERROR;
        return { count: -1, hadref, unfollowed };
      }
      this.log.debug(LdapDebug.TRACE, `ldap_chase_v3referral: msgid ${lr.msgid}, url "${refarray[i]}"\n`);
      const info: RebindInfo = { msgid: origreq.origid, url: refarray[i], request: reencoded.tag };
      const sent = await this.sendServerRequest(reencoded.ber, reencoded.op, reencoded.controls, id, origreq, [srv], null, info);
      if (sent < 0) {
        this.log.debug(
          LdapDebug.ANY,
          `Unable to chase referral "${refarray[i]}" (${this.errno}: ${this.err2string(this.errno)})\n`,
        );
        unfollowed = unfollowed === null ? `${LDAP_REF_STR}${refarray[i]}` : `${unfollowed}\n${refarray[i]}`;
        this.errno = LdapRc.REFERRAL;
        rc = -1;
      } else {
        rc = 0;
        ++count;
        hadref = true;
        if (lc === null) {
          lc = this.findConnection([srv], true);
          if (lc === null) {
            this.errno = LdapRc.OPERATIONS_ERROR;
            return { count: -1, hadref, unfollowed };
          }
        }
        if (lc.rebindQueue !== null) {
          const queued = lc.rebindQueue.pop() ?? [];
          if (lc.rebindQueue.length === 0) lc.rebindQueue = null;
          refarray = queued;
          i = -1;
          continue;
        }
        break;
      }
    }
    if (rc === 0) return { count, hadref, unfollowed: null };
    return { count: rc, hadref, unfollowed };
  }

  private reEncodeRequest(
    origreq: LdapReq, msgid: number, sref: boolean, srv: LdapUrlDesc,
  ): { ber: BerElement; op: ProtocolOp; controls: readonly LdapControl[]; tag: number } | null {
    const original = origreq.op;
    if (original === null || origreq.ber === null) return null;
    this.log.debug(
      LdapDebug.TRACE,
      `re_encode_request: new msgid ${msgid}, new dn <${srv.dn === null ? 'NONE' : srv.dn}>\n`,
    );
    const tmpber = origreq.ber.copy();
    tmpber.ptr = 0;
    tmpber.scanf('{it');
    let op: ProtocolOp = original;
    const tag = this.requestTag(original);
    if (original.kind === 'bindRequest') {
      tmpber.scanf('{im');
      op = { ...original, name: srv.dn ?? original.name };
    } else if (original.kind === 'delRequest') {
      tmpber.scanf('m');
      op = { ...original, entry: srv.dn ?? original.entry };
    } else if (original.kind === 'searchRequest') {
      tmpber.scanf('{me');
      let scope: SearchScope = original.scope;
      if (srv.scope !== LdapScope.DEFAULT) {
        scope = SCOPE_NAMES[srv.scope];
      } else if (sref) {
        scope = original.scope === 'sub' || original.scope === 'children' ? 'sub' : 'base';
      }
      op = { ...original, baseObject: srv.dn ?? original.baseObject, scope };
    } else {
      tmpber.scanf('{m');
    }
    tmpber.buf[tmpber.lastStringBv.start + tmpber.lastStringBv.length] = tmpber.tag;
    const ber = this.newRequestBer(op, origreq.controls, msgid);
    if (this.log.enabled(LdapDebug.PACKETS)) {
      this.log.debug(LdapDebug.ANY, 're_encode_request new request is:\n');
      ber.dump();
    }
    return { ber, op, controls: origreq.controls, tag };
  }



  berOf(value: Uint8Array): BerElement {
    return new BerElement(value, this.heap.allocate(value.length + 1), this.log);
  }

  traceGetDn(message: LdapMessage): void {
    this.log.debug(LdapDebug.TRACE, 'ldap_get_dn\n');
    const response = this.responseIndex.get(message);
    if (response === undefined) return;
    response.ber.copy().scanf('{a');
  }

  traceGetValues(message: LdapMessage, target: string, attributeNames: readonly string[]): void {
    this.log.debug(LdapDebug.TRACE, 'ldap_get_values\n');
    const response = this.responseIndex.get(message);
    if (response === undefined) return;
    const ber = response.ber.copy();
    if (ber.scanf('{x{{a') === LBER_DEFAULT) return;
    const wanted = target.toLowerCase();
    let index = 0;
    let found = attributeNames[0]?.toLowerCase() === wanted;
    while (!found) {
      if (ber.scanf('x}{a') === LBER_DEFAULT) return;
      index++;
      if (attributeNames[index]?.toLowerCase() === wanted) found = true;
    }
    ber.scanf('[v]');
  }

  err2string(code: number): string {
    this.log.debug(LdapDebug.TRACE, 'ldap_err2string\n');
    return ldapErr2String(code);
  }

  getDnBer(message: LdapMessage): BerElement | null {
    this.log.debug(LdapDebug.TRACE, 'ldap_get_dn_ber\n');
    const response = this.responseIndex.get(message);
    if (response === undefined) return null;
    const ber = response.ber.copy();
    if (ber.scanf('{ml{') === LBER_DEFAULT) {
      this.errno = LdapRc.DECODING_ERROR;
      return null;
    }
    ber.setRemainingBytes(ber.lastLength);
    return ber;
  }

  getEntryControls(message: LdapMessage): number {
    const response = this.responseIndex.get(message);
    if (response === undefined) return LdapRc.PARAM_ERROR;
    const ber = response.ber.copy();
    if (ber.scanf('{xx') === LBER_DEFAULT) return LdapRc.DECODING_ERROR;
    return this.getControls(ber) ? LdapRc.SUCCESS : LdapRc.DECODING_ERROR;
  }

  getAttributeBer(ber: BerElement | null, withValues: boolean): void {
    this.log.debug(LdapDebug.TRACE, 'ldap_get_attribute_ber\n');
    if (ber !== null && ber.remaining() > 0) ber.scanf(withValues ? '{mM}' : '{mx}');
  }

  parseReference(message: LdapMessage): number {
    const response = this.responseIndex.get(message);
    if (response === undefined) return LdapRc.PARAM_ERROR;
    const ber = response.ber.copy();
    if (ber.scanf('{v') === LBER_DEFAULT) return LdapRc.DECODING_ERROR;
    if (ber.scanf('}') === LBER_DEFAULT) return LdapRc.DECODING_ERROR;
    return this.getControls(ber) ? LdapRc.SUCCESS : LdapRc.DECODING_ERROR;
  }

  msgfree(batch: ResultBatch | null): void {
    void batch;
    this.log.debug(LdapDebug.TRACE, 'ldap_msgfree\n');
  }

  private parseResultChain(head: RespMsg, freeit: boolean): number {
    this.log.debug(LdapDebug.TRACE, 'ldap_parse_result\n');
    let lm: RespMsg | null = head.chainTail;
    if (lm.msgtype === LdapRes.SEARCH_ENTRY || lm.msgtype === LdapRes.SEARCH_REFERENCE || lm.msgtype === LdapRes.INTERMEDIATE) {
      lm = null;
    }
    let errcode: number = LdapRc.SUCCESS;
    if (lm === null) {
      errcode = this.errno = LdapRc.NO_RESULTS_RETURNED;
    } else {
      const result = resultOf(lm.message);
      this.errno = result?.resultCode ?? LdapRc.DECODING_ERROR;
      this.errorText = result?.diagnosticMessage ?? null;
      this.matched = result?.matchedDN ?? null;
      this.referrals = result?.referral ?? null;
      const ber = lm.ber.copy();
      let tag = this.options.version < LdapVersion.V2 ? ber.scanf('{iA}') : ber.scanf('{iAA');
      if (this.options.version >= LdapVersion.V2) {
        if (tag !== LBER_DEFAULT && ber.peekTag().tag === LDAP_TAG_REFERRAL) tag = ber.scanf('v');
        if (tag !== LBER_DEFAULT) {
          if (lm.msgtype === LdapRes.BIND) {
            if (ber.peekTag().tag === LDAP_TAG_SASL_RES_CREDS) tag = ber.scanf('x');
          } else if (lm.msgtype === LdapRes.EXTENDED) {
            if (ber.peekTag().tag === LDAP_TAG_EXOP_RES_OID) tag = ber.scanf('x');
            if (tag !== LBER_DEFAULT && ber.peekTag().tag === LDAP_TAG_EXOP_RES_VALUE) tag = ber.scanf('x');
          }
        }
        if (tag !== LBER_DEFAULT && !this.getControls(ber)) tag = LBER_DEFAULT;
        if (tag !== LBER_DEFAULT) tag = ber.scanf('}');
      }
      if (tag === LBER_DEFAULT) this.errno = errcode = LdapRc.DECODING_ERROR;
    }
    if (freeit) this.log.debug(LdapDebug.TRACE, 'ldap_msgfree\n');
    return errcode;
  }

  private getControls(ber: BerElement): boolean {
    if (ber.remaining() === 0) return true;
    const peek = ber.peekTag();
    if (peek.tag !== LDAP_TAG_CONTROLS) return peek.tag !== LBER_DEFAULT;
    const header = ber.skipTag();
    if (header.tag === LBER_DEFAULT) return false;
    const last = ber.ptr + header.length;
    if (header.length === 0) return true;
    for (;;) {
      if (ber.scanf('{a') === LBER_DEFAULT) return false;
      if (ber.peekTag().tag === 0x01) ber.scanf('b');
      if (ber.peekTag().tag === 0x04) ber.scanf('o');
      if (ber.ptr >= last) break;
    }
    return true;
  }

  parseResult(message: LdapMessage, freeit = false): ParsedResult {
    const response = this.responseIndex.get(message);
    if (response !== undefined) {
      const code = this.parseResultChain(response, freeit);
      if (code === LdapRc.NO_RESULTS_RETURNED) {
        return { code: LdapRc.NO_RESULTS_RETURNED, matchedDn: '', text: '', referrals: null, controls: null };
      }
    }
    const result = resultOf(message);
    if (result === null) {
      this.errno = LdapRc.NO_RESULTS_RETURNED;
      return { code: LdapRc.NO_RESULTS_RETURNED, matchedDn: '', text: '', referrals: null, controls: null };
    }
    this.errno = result.resultCode;
    this.errorText = result.diagnosticMessage;
    this.matched = result.matchedDN;
    this.referrals = result.referral ?? null;
    return {
      code: result.resultCode,
      matchedDn: result.matchedDN,
      text: result.diagnosticMessage,
      referrals: result.referral ?? null,
      controls: message.controls ?? null,
    };
  }

  async startTlsSync(request: Omit<TlsUpgradeRequest, 'implicit'>): Promise<number> {
    if (this.options.version < LdapVersion.V3) return LdapRc.PARAM_ERROR;
    const sent = await this.extendedOperation(START_TLS_OID, null);
    if (sent.rc !== LdapRc.SUCCESS) return sent.rc;
    const batch = await this.result(sent.messageId, LdapMsg.ALL);
    if (batch === null) return this.errno;
    const parsed = this.parseResult(batch.messages[batch.messages.length - 1]);
    if (parsed.code !== LdapRc.SUCCESS) return parsed.code;
    const conn = this.defConn as LdapConn;
    const outcome = conn.sb.channel.upgradeTls({ ...request, implicit: false });
    if ('detail' in outcome) {
      this.errno = LdapRc.CONNECT_ERROR;
      this.errorText = outcome.detail;
      return LdapRc.CONNECT_ERROR;
    }
    return LdapRc.SUCCESS;
  }

  async saslBind(
    dn: string | null, mechanism: string, cred: Uint8Array | null, controls: readonly LdapControl[] | null,
  ): Promise<{ rc: number; messageId: number }> {
    this.log.debug(LdapDebug.TRACE, 'ldap_sasl_bind\n');
    if (this.options.version < LdapVersion.V3) {
      this.errno = LdapRc.NOT_SUPPORTED;
      return { rc: this.errno, messageId: -1 };
    }
    const messageId = this.allocateMessageId();
    const op: ProtocolOp = {
      kind: 'bindRequest', version: this.options.version, name: dn ?? '', password: '',
      sasl: cred === null ? { mechanism } : { mechanism, credentials: cred },
    };
    const effective = this.effectiveControls(controls);
    const ber = this.newRequestBer(op, effective, messageId);
    const id = await this.sendInitialRequest(ber, op, effective, messageId);
    if (id < 0) return { rc: this.errno, messageId: -1 };
    return { rc: LdapRc.SUCCESS, messageId: id };
  }

  parseSaslBindResult(message: LdapMessage): { rc: number; scred: Uint8Array | null } {
    this.log.debug(LdapDebug.TRACE, 'ldap_parse_sasl_bind_result\n');
    const response = this.responseIndex.get(message);
    if (response === undefined || response.msgtype !== LdapRes.BIND) {
      this.errno = LdapRc.PARAM_ERROR;
      return { rc: this.errno, scred: null };
    }
    this.errorText = null;
    this.matched = null;
    const ber = response.ber.copy();
    const op = message.protocolOp;
    const result = op.kind === 'bindResponse' ? op.result : null;
    let scred: Uint8Array | null = null;
    if (this.options.version < LdapVersion.V2) {
      if (ber.scanf('{iA}') === LBER_DEFAULT) {
        this.errno = LdapRc.DECODING_ERROR;
        return { rc: this.errno, scred: null };
      }
    } else {
      if (ber.scanf('{eAA') === LBER_DEFAULT) {
        this.errno = LdapRc.DECODING_ERROR;
        return { rc: this.errno, scred: null };
      }
      let tag = ber.peekTag().tag;
      if (tag === LDAP_TAG_REFERRAL) {
        if (ber.scanf('x') === LBER_DEFAULT) {
          this.errno = LdapRc.DECODING_ERROR;
          return { rc: this.errno, scred: null };
        }
        tag = ber.peekTag().tag;
      }
      if (tag === LDAP_TAG_SASL_RES_CREDS) {
        if (ber.scanf('O') === LBER_DEFAULT) {
          this.errno = LdapRc.DECODING_ERROR;
          return { rc: this.errno, scred: null };
        }
        scred = op.kind === 'bindResponse' && op.serverSaslCreds !== undefined ? op.serverSaslCreds : new Uint8Array(0);
      }
    }
    this.errno = result?.resultCode ?? LdapRc.DECODING_ERROR;
    this.errorText = result?.diagnosticMessage ?? null;
    this.matched = result?.matchedDN ?? null;
    return { rc: LdapRc.SUCCESS, scred };
  }

  result2error(message: LdapMessage, freeit: boolean): number {
    const parsed = this.parseResult(message, freeit);
    return parsed.code;
  }

  private async getSaslMechs(): Promise<{ rc: number; mechs: string | null }> {
    this.log.debug(LdapDebug.TRACE, 'ldap_pvt_sasl_getmech\n');
    const sent = await this.searchExt({
      base: '', scope: LdapScope.BASE, filter: '(objectclass=*)', attributes: ['supportedSASLMechanisms'],
      attrsOnly: false, serverControls: null, timeoutSeconds: null, sizeLimit: -1,
    }, 'ldap_search');
    if (sent.messageId === -1) return { rc: sent.rc, mechs: null };
    const batch = await this.result(sent.messageId, LdapMsg.ALL);
    if (batch === null) return { rc: this.errno, mechs: null };
    const done = batch.messages[batch.messages.length - 1];
    const code = this.result2error(done, false);
    if (code !== LdapRc.SUCCESS) return { rc: code, mechs: null };
    const entry = batch.messages.find((candidate) => candidate.protocolOp.kind === 'searchResultEntry');
    if (entry === undefined) {
      this.log.debug(LdapDebug.TRACE, 'ldap_msgfree\n');
      this.errno = LdapRc.NO_SUCH_OBJECT;
      return { rc: this.errno, mechs: null };
    }
    const op = entry.protocolOp;
    const attributes = op.kind === 'searchResultEntry' ? op.attributes : [];
    this.traceGetValues(entry, 'supportedSASLMechanisms', attributes.map((candidate) => candidate.type));
    const attribute = attributes.find((candidate) => candidate.type.toLowerCase() === 'supportedsaslmechanisms');
    this.log.debug(LdapDebug.TRACE, 'ldap_msgfree\n');
    if (attribute === undefined) {
      this.errno = LdapRc.NO_SUCH_ATTRIBUTE;
      return { rc: this.errno, mechs: null };
    }
    return { rc: LdapRc.SUCCESS, mechs: attribute.values.join(' ') };
  }

  private async saslHostName(conn: LdapConn): Promise<string | null> {
    const server = conn.server;
    if (server !== null && server.scheme === 'ldapi') return this.saslHost?.hostname() ?? 'localhost';
    if (this.options.sasl.noCanon) return server === null ? null : server.host;
    const peer = conn.sb.channel.peerAddress;
    if (peer === '' || peer === '0.0.0.0' || peer === '::1' || peer === '127.0.0.1') {
      return this.saslHost?.hostname() ?? 'localhost';
    }
    const reverse = this.transport.reverse === undefined ? null : await this.transport.reverse(peer);
    return reverse !== null && reverse !== '' ? reverse : 'localhost';
  }

  async saslInteractiveBind(args: {
    dn: string | null;
    mechs: string | null;
    controls: readonly LdapControl[] | null;
    flags: number;
    interact: ((flags: number, prompts: SaslInteract[]) => number) | null;
    result: LdapMessage | null;
    rmech: { value: string | null };
  }): Promise<{ rc: number; msgid: number }> {
    let mechs = args.mechs;
    if (args.result === null) {
      if (mechs === null || mechs === '') mechs = this.options.sasl.mech;
      if (mechs === null || mechs === '') {
        const fetched = await this.getSaslMechs();
        if (fetched.rc !== LdapRc.SUCCESS) return { rc: fetched.rc, msgid: -1 };
        this.log.debug(LdapDebug.TRACE, `ldap_sasl_interactive_bind: server supports: ${fetched.mechs}\n`);
        mechs = fetched.mechs;
      } else {
        this.log.debug(LdapDebug.TRACE, `ldap_sasl_interactive_bind: user selected: ${mechs}\n`);
      }
    }
    return this.saslBindStep({ ...args, mechs });
  }

  private async saslBindStep(args: {
    dn: string | null;
    mechs: string | null;
    controls: readonly LdapControl[] | null;
    flags: number;
    interact: ((flags: number, prompts: SaslInteract[]) => number) | null;
    result: LdapMessage | null;
    rmech: { value: string | null };
  }): Promise<{ rc: number; msgid: number }> {
    const { mechs, flags, interact, result, rmech } = args;
    this.log.debug(LdapDebug.TRACE, `ldap_int_sasl_bind: ${mechs ?? '<null>'}\n`);
    if (this.options.version < LdapVersion.V3) {
      this.errno = LdapRc.NOT_SUPPORTED;
      return { rc: this.errno, msgid: -1 };
    }
    let ctx: SaslClientConn;
    let ccred: Uint8Array | null = null;
    let saslrc: number = SaslRc.OK;
    let mech: string | null = null;
    let rc: number;
    if (result === null) {
      const opened = await this.open();
      if (opened !== 0 || this.defConn === null) {
        if (this.errno === LdapRc.SUCCESS) this.errno = LdapRc.LOCAL_ERROR;
        return { rc: this.errno, msgid: -1 };
      }
      const conn = this.defConn;
      conn.saslAuthCtx = null;
      const saslhost = await this.saslHostName(conn);
      if (this.saslHost === null || saslhost === null) {
        this.errno = LdapRc.LOCAL_ERROR;
        return { rc: this.errno, msgid: -1 };
      }
      const created = SaslClientConn.create('ldap', saslhost, {
        plugins: this.saslHost.plugins(), clientFqdn: this.saslHost.hostname(), hostname: this.saslHost.hostname(),
        random: (length) => this.saslHost!.random(length),
      });
      if (created.conn === null) {
        this.errno = LdapRc.LOCAL_ERROR;
        return { rc: this.errno, msgid: -1 };
      }
      this.log.debug(LdapDebug.TRACE, `ldap_int_sasl_open: host=${saslhost}\n`);
      ctx = created.conn;
      conn.saslAuthCtx = ctx;
      const tls = conn.sb.channel.tlsState?.() ?? null;
      if (tls !== null) ctx.setExternal(tls.strength, tls.clientDn);
      ctx.setSecProps(this.options.sasl.secprops);
      let prompts: SaslInteract[] | null = null;
      let pmech: string | null = null;
      do {
        const started = ctx.start(mechs, prompts);
        saslrc = started.rc;
        prompts = started.prompts;
        ccred = started.out;
        mech = started.mech;
        if (pmech === null && mech !== null) {
          pmech = mech;
          rmech.value = mech;
          if (flags !== LDAP_SASL_QUIET) this.log.raw(`SASL/${pmech} authentication started\n`);
        }
        if (saslrc === SaslRc.INTERACT) {
          if (interact === null || prompts === null) break;
          const res = interact(flags, prompts);
          if (res !== LdapRc.SUCCESS) break;
        }
      } while (saslrc === SaslRc.INTERACT);
      rc = LdapRc.SASL_BIND_IN_PROGRESS;
    } else {
      const conn = this.defConn;
      if (conn === null || conn.saslAuthCtx === null) {
        this.errno = LdapRc.LOCAL_ERROR;
        return { rc: this.errno, msgid: -1 };
      }
      ctx = conn.saslAuthCtx;
      const parsedBind = this.parseSaslBindResult(result);
      if (parsedBind.rc !== LdapRc.SUCCESS) return { rc: parsedBind.rc, msgid: -1 };
      const scred = parsedBind.scred;
      rc = this.result2error(result, false);
      if (rc !== LdapRc.SUCCESS && rc !== LdapRc.SASL_BIND_IN_PROGRESS) {
        if (scred !== null) {
          this.log.debug(LdapDebug.TRACE, `ldap_int_sasl_bind: rc=${rc} len=${scred.length}\n`);
        }
        return { rc, msgid: -1 };
      }
      mech = rmech.value;
      if (rc === LdapRc.SUCCESS && mech === null) return this.saslBindSuccess(ctx, flags, rc);
      let prompts: SaslInteract[] | null = null;
      do {
        if (scred === null) this.log.debug(LdapDebug.TRACE, 'ldap_int_sasl_bind: no data in step!\n');
        const stepped = ctx.step(scred, prompts);
        saslrc = stepped.rc;
        prompts = stepped.prompts;
        ccred = stepped.out;
        this.log.debug(LdapDebug.TRACE, `sasl_client_step: ${saslrc}\n`);
        if (saslrc === SaslRc.INTERACT) {
          if (interact === null || prompts === null) break;
          const res = interact(flags, prompts);
          if (res !== LdapRc.SUCCESS) break;
        }
      } while (saslrc === SaslRc.INTERACT);
    }

    if (saslrc !== SaslRc.OK && saslrc !== SaslRc.CONTINUE) {
      rc = this.errno = saslErrorToLdap(saslrc);
      this.errorText = ctx.errdetail();
      return { rc, msgid: -1 };
    }
    if (saslrc === SaslRc.OK) rmech.value = null;

    if (rc === LdapRc.SASL_BIND_IN_PROGRESS) {
      const sent = await this.saslBind(args.dn, mech ?? '', ccred, args.controls);
      if (sent.rc !== LdapRc.SUCCESS) return { rc: sent.rc, msgid: -1 };
      return { rc: LdapRc.SASL_BIND_IN_PROGRESS, msgid: sent.messageId };
    }
    return this.saslBindSuccess(ctx, flags, rc);
  }

  private saslBindSuccess(ctx: SaslClientConn, flags: number, rc: number): { rc: number; msgid: number } {
    if (flags !== LDAP_SASL_QUIET) {
      const user = ctx.getProp(SaslProp.USERNAME);
      if (user.rc === SaslRc.OK && typeof user.value === 'string' && user.value !== '') {
        this.log.raw(`SASL username: ${user.value}\n`);
      }
    }
    const ssf = ctx.getProp(SaslProp.SSF);
    if (ssf.rc === SaslRc.OK) {
      if (flags !== LDAP_SASL_QUIET) this.log.raw(`SASL SSF: ${ssf.value}\n`);
      if (typeof ssf.value === 'number' && ssf.value !== 0) {
        this.installSaslLayer(ctx);
        if (flags !== LDAP_SASL_QUIET) this.log.raw('SASL data security layer installed.\n');
      }
    }
    return { rc, msgid: -1 };
  }

  private installSaslLayer(ctx: SaslClientConn): void {
    const conn = this.defConn;
    if (conn === null) return;
    conn.saslSockCtx = ctx;
    conn.sb.installSasl({ encode: (data) => ctx.encode(data), decode: (data) => ctx.decode(data), errorText: saslErrstring });
  }

  unbind(): void {
    if (this.unbound) return;
    this.unbound = true;
    this.freeAllRequests();
    while (this.conns.length > 0) this.freeConnection(this.conns[0], true, true);
  }
}

function saslErrorToLdap(saslrc: number): number {
  switch (saslrc) {
    case SaslRc.CONTINUE: return LdapRc.MORE_RESULTS_TO_RETURN;
    case SaslRc.INTERACT: return LdapRc.LOCAL_ERROR;
    case SaslRc.OK: return LdapRc.SUCCESS;
    case SaslRc.NOMEM: return LdapRc.NO_MEMORY;
    case SaslRc.NOMECH: return LdapRc.AUTH_UNKNOWN;
    case SaslRc.BADPROT: return LdapRc.DECODING_ERROR;
    case SaslRc.BADSERV: return LdapRc.AUTH_UNKNOWN;
    case SaslRc.BADAUTH: return LdapRc.AUTH_UNKNOWN;
    case SaslRc.NOAUTHZ: return LdapRc.PARAM_ERROR;
    case SaslRc.FAIL: return LdapRc.LOCAL_ERROR;
    case SaslRc.TOOWEAK:
    case SaslRc.ENCRYPT: return LdapRc.AUTH_UNKNOWN;
    default: return LdapRc.LOCAL_ERROR;
  }
}
