/**
 * LdapServerHandler — server-side endpoint for TCP/389 (RFC 4511 §5):
 * decodes each inbound LDAPMessage and applies Bind/Search/Add/Modify/
 * Delete/Compare/Unbind against a real `DirectoryTree`, replying with
 * genuine BER-encoded LDAPMessage responses over the raw `Uint8Array`
 * channel `TcpSocket.send()`/`onData()` expose — the same bytes a real
 * LDAP client would exchange with a real DC, not a JSON PDU shortcut
 * (contrast `SmbServerHandler`/`WinRmServerHandler`, which do use JSON).
 *
 * One handler instance per accepted connection (mirrors SSH/SMB/WinRM),
 * so `bound` state is naturally per-session.
 */

import type { TcpSocket } from '@/network/tcp/TcpStack';
import { DirectoryTree, type DirectoryEntry } from './DirectoryTree';
import { parseDN, formatDN, type DistinguishedName } from './LdapDN';
import {
  type LdapMessage, type ProtocolOp, type PartialAttribute, type LdapResult, type SaslCredentials, type LdapControl,
  encodeLdapMessage, decodeLdapMessages, ldapResult, LdapResultCode,
  START_TLS_OID, PAGED_RESULTS_CONTROL_OID, encodePagedResultsValue, decodePagedResultsValue,
} from './LdapMessage';
import { attributeToWire } from './LdapWireSyntax';
import {
  SORT_REQUEST_OID, SORT_RESPONSE_OID, DOMAIN_SCOPE_OID, decodeSortKeys, encodeSortResponse, type SortKey,
} from './LdapSortControl';
import { ApReplayCache, type KerberosServiceIdentity } from '@/network/kerberos/ApReqVerifier';
import { machineSalt, stringToKey } from '@/network/kerberos/crypto';
import { simulationNowMs } from '@/network/core/SystemClock';
import { GssapiServerExchange, type EstablishedSecurityLayer } from '@/network/ldap/gssapi/GssapiServerExchange';
import { GssSaslLayer } from '@/network/ldap/gssapi/GssSaslLayer';
import { LAYER_CONFIDENTIALITY, LAYER_INTEGRITY, LAYER_NONE, type LayerOffer } from '@/network/ldap/gssapi/Rfc4752';
import type { GssPeer } from '@/network/kerberos/gssapi/GssAcceptor';
import type { TlsServerConfig } from '@/network/tls/TlsServerSession';
import { TlsServerSession } from '@/network/tls/TlsServerSession';
import { encryptApplicationData, decryptApplicationData } from '@/network/http/https/ApplicationDataCipher';
import { bytesToBinaryString, binaryStringToBytes } from '@/crypto/encoding';
import { encodeRecords, decodeRecords } from '@/network/http/https/TlsRecordWire';
import { stepServerHandshake } from './ldapStartTls';

export interface LdapBindCheck {
  /** Validate a simple-bind DN + password. Anonymous bind (empty name and password) is always accepted per RFC 4511 §5.1.2, matching real DCs' default anonymous-bind allowance. */
  checkBind(name: string, password: string): boolean;
}

/**
 * Real Kerberos material a GSSAPI SASL bind (RFC 4511 §4.2,
 * PRD-Windows-Server-Advanced.md §5 P3) needs to validate an AP-REQ — the
 * presented service ticket (for this DC's own `ldap/<hostname>`-style SPN,
 * §5 P2's simplification: a computer-account ticket) is decrypted with
 * this DC's own computer-account secret (`serviceSecret`), the same key
 * `KdcSession`'s TGS-REQ handler encrypted it under — never krbtgt's key,
 * which only the KDC itself holds. Its session key then decrypts the
 * Authenticator. Omitted (`undefined`) on hosts with no `DirectoryStore`
 * (mirrors the port-389 listener itself being gated on that).
 */
export type LdapKerberosContext = KerberosServiceIdentity;

export interface LdapServerContext {
  tree: DirectoryTree;
  auth: LdapBindCheck;
  kerberos?: LdapKerberosContext;
  /** RFC 4511 §4.14.1 StartTLS — omitted (`undefined`) means `extendedRequest` is refused with `protocolError`, same as before this phase (PRD-Windows-Server-Advanced.md §5 P11). */
  startTls?: TlsServerConfig;
  implicitTls?: boolean;
  /**
   * RFC 4511 §4.1.10/§4.5.2 referrals (§5 P11, useful for §5 P8/P9's
   * multi-domain forest): DN-root strings (e.g.
   * `"DC=child,DC=lab,DC=local"`) of every *other* domain in this DC's
   * forest, so a search whose base lies there returns a
   * `searchResultReference` instead of an empty success.
   */
  otherForestDomainRoots?: () => string[];
  /** This DC's own name and site, published in the rootDSE as `dnsHostName`/`serverName` — how a client learns WHICH DC answered it. */
  serverIdentity?: () => { hostname: string; dnsName: string; site: string | null };
}

const MEMBER_ATTRIBUTE = 'member';

function expiringLinkTtl(attributeDescription: string): number | null {
  const match = /^member;ttl=(\d+)$/i.exec(attributeDescription.trim());
  return match ? parseInt(match[1], 10) : null;
}

function treeMessageToResultCode(message: string): number {
  if (message.startsWith('noSuchObject')) return LdapResultCode.noSuchObject;
  if (message.startsWith('entryAlreadyExists')) return LdapResultCode.entryAlreadyExists;
  if (message.startsWith('notAllowedOnNonLeaf')) return LdapResultCode.notAllowedOnNonLeaf;
  if (message.startsWith('namingViolation')) return LdapResultCode.namingViolation;
  return LdapResultCode.operationsError;
}

function entryToAttributes(tree: DirectoryTree, entry: DirectoryEntry): PartialAttribute[] {
  return [...entry.attributes.entries()].map(([type, values]) => ({ type: tree.canonicalAttributeName(type), values }));
}

const INVALID_CREDENTIALS_TEXT = '80090308: LdapErr: DSID-0C09044E, comment: AcceptSecurityContext error, data 52e, v4563';

function ldapGeneralizedTime(moment: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${moment.getUTCFullYear()}${pad(moment.getUTCMonth() + 1)}${pad(moment.getUTCDate())}${pad(moment.getUTCHours())}${pad(moment.getUTCMinutes())}${pad(moment.getUTCSeconds())}.0Z`;
}

const GSSAPI_LAYER_OFFER: LayerOffer = { layers: LAYER_NONE | LAYER_INTEGRITY | LAYER_CONFIDENTIALITY, maxBuffer: 10_485_760 };
const replayCaches = new WeakMap<KerberosServiceIdentity, ApReplayCache>();

function replayCacheOf(identity: KerberosServiceIdentity): ApReplayCache {
  let cache = replayCaches.get(identity);
  if (cache === undefined) {
    cache = new ApReplayCache();
    replayCaches.set(identity, cache);
  }
  return cache;
}

function authorizationIdentityNames(peer: GssPeer): string[] {
  const user = peer.name.join('/').toLowerCase();
  const qualified = `${user}@${peer.realm.toLowerCase()}`;
  return [user, qualified, `u:${user}`, `u:${qualified}`];
}

const NOT_BOUND: LdapResult = {
  resultCode: LdapResultCode.operationsError, matchedDN: '',
  diagnosticMessage: '000004DC: LdapErr: DSID-0C090A69, comment: In order to perform this operation a successful bind must be completed on the connection., data 0, v4563',
};

const SUPPORTED_CONTROLS: readonly string[] = [PAGED_RESULTS_CONTROL_OID, SORT_REQUEST_OID, DOMAIN_SCOPE_OID];
const SUPPORTED_SASL_MECHANISMS: readonly string[] = ['GSSAPI'];
const OPERATIONAL_ATTRIBUTES: ReadonlySet<string> = new Set([
  'createtimestamp', 'modifytimestamp', 'subschemasubentry', 'structuralobjectclass', 'entrydn',
]);

function responseFor(op: ProtocolOp, result: LdapResult): ProtocolOp | null {
  switch (op.kind) {
    case 'bindRequest': return { kind: 'bindResponse', result };
    case 'searchRequest': return { kind: 'searchResultDone', result };
    case 'modifyRequest': return { kind: 'modifyResponse', result };
    case 'addRequest': return { kind: 'addResponse', result };
    case 'delRequest': return { kind: 'delResponse', result };
    case 'compareRequest': return { kind: 'compareResponse', result };
    case 'modifyDNRequest': return { kind: 'modifyDNResponse', result };
    case 'extendedRequest': return { kind: 'extendedResponse', result };
    default: return null;
  }
}

function selectAttributes(
  attributes: PartialAttribute[], wanted: readonly string[], typesOnly: boolean,
): PartialAttribute[] {
  const names = new Set(wanted.map(name => name.toLowerCase()));
  const wantsUser = names.size === 0 || names.has('*');
  const wantsOperational = names.has('+');
  const selected = attributes.filter(attribute => {
    const key = attribute.type.toLowerCase();
    if (names.has(key)) return true;
    return OPERATIONAL_ATTRIBUTES.has(key) ? wantsOperational : wantsUser;
  });
  return typesOnly ? selected.map(attribute => ({ type: attribute.type, values: [] })) : selected;
}

export class LdapServerHandler {
  private bound = false;
  private authenticated = false;
  /** Non-null once an `extendedRequest` StartTLS has been accepted — `result === null` while the handshake itself is still in progress (§5 P11). */
  private tls: TlsServerSession | null = null;
  private tlsSendSeq = 0;
  private tlsRecvSeq = 0;
  /** Whether the *inbound* message currently being handled arrived as TLS application data — read by `reply()` so its response goes back the same way. */
  private replyEncrypted = false;
  private stringWire = false;
  private gssapi: GssapiServerExchange | null = null;
  private saslLayer: { readonly layer: GssSaslLayer; readonly maxSend: number } | null = null;

  constructor(private readonly ctx: LdapServerContext) {
    if (ctx.implicitTls === true && ctx.startTls) this.tls = new TlsServerSession(ctx.startTls);
  }

  register(socket: TcpSocket): void {
    let pending = new Uint8Array(0);
    const absorb = (carried: Uint8Array): LdapMessage[] => {
      const plaintext = this.unprotect(carried);
      const joined = new Uint8Array(pending.length + plaintext.length);
      joined.set(pending, 0);
      joined.set(plaintext, pending.length);
      const { messages, bytesConsumed } = decodeLdapMessages(joined);
      pending = joined.slice(bytesConsumed);
      return messages;
    };
    socket.onData((arriving) => {
      this.stringWire = typeof arriving === 'string';
      const data = typeof arriving === 'string' ? binaryStringToBytes(arriving) : arriving;
      if (!(data instanceof Uint8Array)) return;
      if (this.tls && this.tls.result === null) {
        const flight = stepServerHandshake(this.tls, data);
        if (flight) this.transmit(socket, flight);
        return;
      }
      if (this.tls && this.tls.result === 'accept') {
        let messages: LdapMessage[];
        try {
          const { plaintext, nextSeq } = decryptApplicationData(this.tls.clientTraffic(), this.tlsRecvSeq, decodeRecords(data));
          this.tlsRecvSeq = nextSeq;
          messages = absorb(plaintext);
        } catch { return; }
        this.replyEncrypted = true;
        for (const msg of messages) this.handle(socket, msg);
        return;
      }
      let messages: LdapMessage[];
      try { messages = absorb(data); } catch { return; }
      this.replyEncrypted = false;
      for (const msg of messages) this.handle(socket, msg);
    });
  }

  private reply(socket: TcpSocket, messageID: number, protocolOp: ProtocolOp, controls?: LdapControl[]): void {
    const bytes = this.protect(encodeLdapMessage({ messageID, protocolOp, controls }));
    if (this.replyEncrypted && this.tls && this.tls.result === 'accept') {
      const { records, nextSeq } = encryptApplicationData(this.tls.serverTraffic(), this.tlsSendSeq, bytes);
      this.tlsSendSeq = nextSeq;
      this.transmit(socket, encodeRecords(records));
      return;
    }
    this.transmit(socket, bytes);
  }

  private protect(bytes: Uint8Array): Uint8Array {
    if (this.saslLayer === null) return bytes;
    const { layer, maxSend } = this.saslLayer;
    const frames: Uint8Array[] = [];
    for (let offset = 0; offset < bytes.length; offset += maxSend) {
      frames.push(layer.encode(bytes.subarray(offset, Math.min(bytes.length, offset + maxSend))).data);
    }
    const joined = new Uint8Array(frames.reduce((total, frame) => total + frame.length, 0));
    let position = 0;
    for (const frame of frames) {
      joined.set(frame, position);
      position += frame.length;
    }
    return joined;
  }

  private unprotect(bytes: Uint8Array): Uint8Array {
    if (this.saslLayer === null) return bytes;
    const decoded = this.saslLayer.layer.decode(bytes);
    if (decoded.rc !== 0) throw new Error('SASL security layer: undecodable frame');
    return decoded.data;
  }

  private transmit(socket: TcpSocket, bytes: Uint8Array): void {
    socket.send(this.stringWire ? bytesToBinaryString(bytes) : bytes);
  }

  private handle(socket: TcpSocket, msg: LdapMessage): void {
    const op = msg.protocolOp;
    const unavailable = msg.controls?.find(c => c.criticality && !SUPPORTED_CONTROLS.includes(c.controlType));
    if (unavailable !== undefined) {
      const refusal = responseFor(op, ldapResult(LdapResultCode.unavailableCriticalExtension));
      if (refusal !== null) {
        this.reply(socket, msg.messageID, refusal);
        return;
      }
    }
    switch (op.kind) {
      case 'bindRequest': {
        this.authenticated = false;
        if (op.sasl === undefined) this.gssapi = null;
        if (op.version !== 2 && op.version !== 3) {
          this.bound = false;
          this.reply(socket, msg.messageID, {
            kind: 'bindResponse',
            result: ldapResult(LdapResultCode.protocolError, '', 'unsupported LDAP version'),
          });
          return;
        }
        if (op.sasl) {
          if (!SUPPORTED_SASL_MECHANISMS.includes(op.sasl.mechanism)) {
            this.bound = false;
            this.reply(socket, msg.messageID, {
              kind: 'bindResponse', result: ldapResult(LdapResultCode.authMethodNotSupported),
            });
            return;
          }
          this.bindGssapi(socket, msg.messageID, op.sasl);
          return;
        }
        this.gssapi = null;
        const anonymous = op.name === '' && op.password === '';
        if (!anonymous && op.password === '') {
          this.bound = false;
          this.reply(socket, msg.messageID, {
            kind: 'bindResponse',
            result: ldapResult(LdapResultCode.unwillingToPerform, '', '0000052D: SvcErr: DSID-0C09075C, problem 5003 (WILL_NOT_PERFORM), data 0'),
          });
          return;
        }
        this.bound = anonymous || this.ctx.auth.checkBind(op.name, op.password);
        this.authenticated = this.bound && !anonymous;
        this.reply(socket, msg.messageID, {
          kind: 'bindResponse',
          result: this.bound ? ldapResult(LdapResultCode.success) : ldapResult(LdapResultCode.invalidCredentials, '', INVALID_CREDENTIALS_TEXT),
        });
        return;
      }
      case 'unbindRequest':
        socket.close();
        return;
      case 'searchRequest': {
        const rootDse = op.baseObject.trim() === '' && op.scope === 'base';
        if (!this.authenticated && !rootDse) {
          this.reply(socket, msg.messageID, { kind: 'searchResultDone', result: NOT_BOUND });
          return;
        }
        if (rootDse) {
          this.reply(socket, msg.messageID, {
            kind: 'searchResultEntry', objectName: '',
            attributes: selectAttributes(this.rootDseAttributes(), op.attributes, op.typesOnly),
          });
          this.reply(socket, msg.messageID, { kind: 'searchResultDone', result: ldapResult(LdapResultCode.success) });
          return;
        }
        const baseDn = this.tryParseDn(op.baseObject);
        if (!baseDn) {
          this.reply(socket, msg.messageID, {
            kind: 'searchResultDone',
            result: ldapResult(LdapResultCode.invalidDNSyntax, '', `0000208F: NameErr: DSID-03100233, problem 2006 (BAD_NAME), data 8350, best match of:\n\t''\n`),
          });
          return;
        }

        const domainScope = msg.controls?.some(c => c.controlType === DOMAIN_SCOPE_OID) === true;
        const referralUri = domainScope ? null : this.referralFor(baseDn);
        if (referralUri) {
          this.reply(socket, msg.messageID, { kind: 'searchResultReference', uris: [referralUri] });
          this.reply(socket, msg.messageID, { kind: 'searchResultDone', result: ldapResult(LdapResultCode.referral) });
          return;
        }

        if (!this.ctx.tree.isWithinTree(baseDn)) {
          const domain = baseDn.flat().filter(ava => ava.type.toLowerCase() === 'dc').map(ava => ava.value).join('.');
          if (domain !== '') {
            this.reply(socket, msg.messageID, {
              kind: 'searchResultDone',
              result: {
                resultCode: LdapResultCode.referral, matchedDN: '',
                diagnosticMessage: `0000202B: RefErr: DSID-0310082F, data 0, 1 access points\n\tref 1: '${domain}'\n`,
                referral: [`ldap://${domain}/${formatDN(baseDn)}`],
              },
            });
            return;
          }
        }

        if (!this.ctx.tree.getByDn(baseDn)) {
          this.reply(socket, msg.messageID, {
            kind: 'searchResultDone',
            result: ldapResult(LdapResultCode.noSuchObject, '', this.noSuchObjectText(baseDn)),
          });
          return;
        }

        let entries = this.ctx.tree.search(baseDn, op.scope, op.filter);
        const sortControl = msg.controls?.find(c => c.controlType === SORT_REQUEST_OID);
        const responseControls: LdapControl[] = [];
        if (sortControl?.controlValue !== undefined) {
          const keys = decodeSortKeys(sortControl.controlValue);
          if (keys === null) {
            this.reply(socket, msg.messageID, { kind: 'searchResultDone', result: ldapResult(LdapResultCode.protocolError) });
            return;
          }
          entries = this.sortEntries(entries, keys);
          responseControls.push({
            controlType: SORT_RESPONSE_OID, criticality: false,
            controlValue: encodeSortResponse(LdapResultCode.success, null),
          });
        }
        const paged = this.paginate(entries, msg.controls);
        let page = paged.page;
        let resultCode: number = LdapResultCode.success;
        if (op.sizeLimit > 0 && page.length > op.sizeLimit) {
          page = page.slice(0, op.sizeLimit);
          resultCode = LdapResultCode.sizeLimitExceeded;
        }
        for (const entry of page) {
          this.reply(socket, msg.messageID, {
            kind: 'searchResultEntry',
            objectName: formatDN(entry.dn),
            attributes: selectAttributes(entryToAttributes(this.ctx.tree, entry), op.attributes, op.typesOnly).map(attributeToWire),
          });
        }
        if (paged.responseControls) responseControls.push(...paged.responseControls);
        this.reply(
          socket, msg.messageID,
          { kind: 'searchResultDone', result: ldapResult(resultCode) },
          responseControls.length > 0 ? responseControls : undefined,
        );
        return;
      }
      case 'addRequest': {
        if (!this.authenticated) { this.reply(socket, msg.messageID, { kind: 'addResponse', result: NOT_BOUND }); return; }
        const dn = this.tryParseDn(op.entry);
        if (!dn) { this.reply(socket, msg.messageID, { kind: 'addResponse', result: ldapResult(LdapResultCode.invalidDNSyntax) }); return; }
        const attrs: Record<string, string[]> = {};
        for (const a of op.attributes) attrs[a.type] = a.values;
        const res = this.ctx.tree.addEntry(dn, attrs);
        this.reply(socket, msg.messageID, {
          kind: 'addResponse',
          result: res.ok ? ldapResult(LdapResultCode.success) : ldapResult(treeMessageToResultCode(res.message), '', res.message),
        });
        return;
      }
      case 'modifyRequest': {
        if (!this.authenticated) { this.reply(socket, msg.messageID, { kind: 'modifyResponse', result: NOT_BOUND }); return; }
        const dn = this.tryParseDn(op.object);
        if (!dn) { this.reply(socket, msg.messageID, { kind: 'modifyResponse', result: ldapResult(LdapResultCode.invalidDNSyntax) }); return; }
        const ttls: Array<{ member: string; seconds: number }> = [];
        const res = this.ctx.tree.modifyEntry(dn, op.changes.map(c => {
          const expiring = expiringLinkTtl(c.modification.type);
          if (expiring === null) return { op: c.operation, type: c.modification.type, values: c.modification.values };
          if (c.operation === 'add') for (const v of c.modification.values) ttls.push({ member: v, seconds: expiring });
          return { op: c.operation, type: MEMBER_ATTRIBUTE, values: c.modification.values };
        }));
        if (res.ok) for (const { member, seconds } of ttls) this.ctx.tree.setLinkTtl(dn, member, seconds);
        this.reply(socket, msg.messageID, {
          kind: 'modifyResponse',
          result: res.ok ? ldapResult(LdapResultCode.success) : ldapResult(treeMessageToResultCode(res.message), '', res.message),
        });
        return;
      }
      case 'delRequest': {
        if (!this.authenticated) { this.reply(socket, msg.messageID, { kind: 'delResponse', result: NOT_BOUND }); return; }
        const dn = this.tryParseDn(op.entry);
        if (!dn) { this.reply(socket, msg.messageID, { kind: 'delResponse', result: ldapResult(LdapResultCode.invalidDNSyntax) }); return; }
        const res = this.ctx.tree.deleteEntry(dn);
        this.reply(socket, msg.messageID, {
          kind: 'delResponse',
          result: res.ok ? ldapResult(LdapResultCode.success) : ldapResult(treeMessageToResultCode(res.message), '', res.message),
        });
        return;
      }
      case 'compareRequest': {
        if (!this.authenticated) { this.reply(socket, msg.messageID, { kind: 'compareResponse', result: NOT_BOUND }); return; }
        const dn = this.tryParseDn(op.entry);
        if (!dn) { this.reply(socket, msg.messageID, { kind: 'compareResponse', result: ldapResult(LdapResultCode.invalidDNSyntax) }); return; }
        const outcome = this.ctx.tree.compare(dn, op.attributeDesc, op.assertionValue);
        const result = outcome === 'noSuchObject' ? ldapResult(LdapResultCode.noSuchObject)
          : outcome === 'true' ? ldapResult(LdapResultCode.compareTrue) : ldapResult(LdapResultCode.compareFalse);
        this.reply(socket, msg.messageID, { kind: 'compareResponse', result });
        return;
      }
      case 'modifyDNRequest': {
        if (!this.authenticated) { this.reply(socket, msg.messageID, { kind: 'modifyDNResponse', result: NOT_BOUND }); return; }
        const dn = this.tryParseDn(op.entry);
        if (!dn) { this.reply(socket, msg.messageID, { kind: 'modifyDNResponse', result: ldapResult(LdapResultCode.invalidDNSyntax) }); return; }
        let newSuperior: DistinguishedName | undefined;
        if (op.newSuperior !== undefined) {
          const parsed = this.tryParseDn(op.newSuperior);
          if (!parsed) { this.reply(socket, msg.messageID, { kind: 'modifyDNResponse', result: ldapResult(LdapResultCode.invalidDNSyntax) }); return; }
          newSuperior = parsed;
        }
        const res = this.ctx.tree.renameEntry(dn, op.newRdn, op.deleteOldRdn, newSuperior);
        this.reply(socket, msg.messageID, {
          kind: 'modifyDNResponse',
          result: res.ok ? ldapResult(LdapResultCode.success) : ldapResult(treeMessageToResultCode(res.message), '', res.message),
        });
        return;
      }
      case 'extendedRequest': {
        if (op.requestName !== START_TLS_OID || !this.ctx.startTls) {
          this.reply(socket, msg.messageID, {
            kind: 'extendedResponse',
            result: ldapResult(LdapResultCode.protocolError, '', 'unsupported extended operation'),
          });
          return;
        }
        this.reply(socket, msg.messageID, { kind: 'extendedResponse', result: ldapResult(LdapResultCode.success), responseName: START_TLS_OID });
        this.tls = new TlsServerSession(this.ctx.startTls);
        return;
      }
      case 'abandonRequest':
        // RFC 4511 §4.11 — never answered, by design; nothing is genuinely
        // "in flight" to cancel in this synchronous request/reply model,
        // so there is nothing further to do beyond not crashing.
        return;
      // bindResponse/searchResultEntry/searchResultDone/modifyResponse/addResponse/delResponse/compareResponse/
      // modifyDNResponse/extendedResponse/searchResultReference never arrive as inbound requests — a real DC
      // never receives its own response CHOICEs.
      default:
        return;
    }
  }

  /** RFC 2696 paged results — `entries` sliced to the requested page, plus the response control for the *next* page (empty cookie once exhausted). No control at all if the client didn't ask for paging. */
  private paginate(entries: DirectoryEntry[], controls: LdapControl[] | undefined): { page: DirectoryEntry[]; responseControls?: LdapControl[] } {
    const pagedControl = controls?.find(c => c.controlType === PAGED_RESULTS_CONTROL_OID);
    if (!pagedControl || pagedControl.controlValue === undefined) return { page: entries };
    const { size, cookie } = decodePagedResultsValue(pagedControl.controlValue);
    const offset = cookie.length > 0 ? Number(new TextDecoder().decode(cookie)) : 0;
    const page = entries.slice(offset, offset + size);
    const nextOffset = offset + page.length;
    const moreRemain = nextOffset < entries.length;
    return {
      page,
      responseControls: [{
        controlType: PAGED_RESULTS_CONTROL_OID, criticality: false,
        controlValue: encodePagedResultsValue({
          size: entries.length,
          cookie: moreRemain ? new TextEncoder().encode(String(nextOffset)) : new Uint8Array(0),
        }),
      }],
    };
  }

  /** A `searchResultReference` URI if `baseDn` lies under a *different* domain of this DC's forest, else `null` (an ordinary, possibly-empty local search). */
  private rootDseAttributes(): PartialAttribute[] {
    const root = formatDN(this.ctx.tree.getRootDn());
    const configuration = `CN=Configuration,${root}`;
    const all: PartialAttribute[] = [
      { type: 'currentTime', values: [ldapGeneralizedTime(new Date())] },
      { type: 'subschemaSubentry', values: [`CN=Aggregate,CN=Schema,${configuration}`] },
      { type: 'namingContexts', values: [root, configuration, `CN=Schema,${configuration}`] },
      { type: 'defaultNamingContext', values: [root] },
      { type: 'schemaNamingContext', values: [`CN=Schema,${configuration}`] },
      { type: 'configurationNamingContext', values: [configuration] },
      { type: 'rootDomainNamingContext', values: [root] },
      { type: 'supportedControl', values: [...SUPPORTED_CONTROLS] },
      { type: 'supportedLDAPVersion', values: ['3', '2'] },
      { type: 'supportedSASLMechanisms', values: [...SUPPORTED_SASL_MECHANISMS] },
    ];
    const identity = this.ctx.serverIdentity?.();
    if (identity) {
      all.push({ type: 'dnsHostName', values: [`${identity.hostname}.${identity.dnsName}`] });
      if (identity.site) {
        all.push({ type: 'serverName', values: [`CN=${identity.hostname},CN=Servers,CN=${identity.site},CN=Sites,${configuration}`] });
      }
    }
    return all;
  }

  private noSuchObjectText(baseDn: DistinguishedName): string {
    let ancestor: DistinguishedName | null = baseDn;
    while (ancestor !== null && ancestor.length > 0) {
      ancestor = ancestor.slice(1);
      if (ancestor.length > 0 && this.ctx.tree.getByDn(ancestor)) {
        return `0000208D: NameErr: DSID-03100238, problem 2001 (NO_OBJECT), data 0, best match of:\n\t'${formatDN(ancestor)}'\n`;
      }
    }
    return "0000208D: NameErr: DSID-03100238, problem 2001 (NO_OBJECT), data 0, best match of:\n\t''\n";
  }

  private sortEntries(entries: DirectoryEntry[], keys: readonly SortKey[]): DirectoryEntry[] {
    const valueOf = (entry: DirectoryEntry, attribute: string): string | null => {
      const values = entry.attributes.get(attribute.toLowerCase());
      return values === undefined || values.length === 0 ? null : values[0].toLowerCase();
    };
    return entries
      .map((entry, index) => ({ entry, index }))
      .sort((left, right) => {
        for (const key of keys) {
          const a = valueOf(left.entry, key.attributeType);
          const b = valueOf(right.entry, key.attributeType);
          if (a === b) continue;
          if (a === null) return 1;
          if (b === null) return -1;
          const comparison = a < b ? -1 : 1;
          return key.reverseOrder ? -comparison : comparison;
        }
        return left.index - right.index;
      })
      .map(item => item.entry);
  }

  private referralFor(baseDn: DistinguishedName): string | null {
    if (!this.ctx.otherForestDomainRoots) return null;
    const target = formatDN(baseDn).toLowerCase();
    for (const rootDnStr of this.ctx.otherForestDomainRoots()) {
      const root = rootDnStr.toLowerCase();
      if (target === root || target.endsWith(`,${root}`)) return `ldap:///${formatDN(baseDn)}`;
    }
    return null;
  }

  private tryParseDn(s: string): ReturnType<typeof parseDN> | null {
    try { return parseDN(s); } catch { return null; }
  }

  private bindGssapi(socket: TcpSocket, messageID: number, sasl: SaslCredentials): void {
    this.bound = false;
    const refuse = (): void => {
      this.gssapi = null;
      this.reply(socket, messageID, {
        kind: 'bindResponse', result: ldapResult(LdapResultCode.invalidCredentials, '', INVALID_CREDENTIALS_TEXT),
      });
    };
    const identity = this.ctx.kerberos;
    if (sasl.mechanism !== 'GSSAPI' || identity === undefined) {
      refuse();
      return;
    }
    if (this.gssapi === null) {
      const clock = { nowMicroseconds: (): number => Math.floor((identity.clockMs ?? simulationNowMs)() * 1000) };
      this.gssapi = new GssapiServerExchange({
        serviceKey: stringToKey(identity.serviceSecret, machineSalt(identity.realm, identity.hostName)),
        clock, replayCache: replayCacheOf(identity), offer: GSSAPI_LAYER_OFFER,
      });
    }
    const step = this.gssapi.step(sasl.credentials ?? null);
    if (step.kind === 'failed') {
      refuse();
      return;
    }
    if (step.kind === 'continue') {
      this.reply(socket, messageID, {
        kind: 'bindResponse', result: ldapResult(LdapResultCode.saslBindInProgress), serverSaslCreds: step.credentials,
      });
      return;
    }
    if (step.authzid !== '' && !authorizationIdentityNames(step.peer).includes(step.authzid.toLowerCase())) {
      refuse();
      return;
    }
    this.gssapi = null;
    this.bound = true;
    this.authenticated = true;
    this.reply(socket, messageID, { kind: 'bindResponse', result: ldapResult(LdapResultCode.success) });
    if (step.layer !== null) this.installSaslLayer(step.layer);
  }

  private installSaslLayer(established: EstablishedSecurityLayer): void {
    const layer = new GssSaslLayer(established.context, established.privacy, GSSAPI_LAYER_OFFER.maxBuffer, () => undefined);
    const maxSend = Math.max(1, established.peerMaxBuffer - established.context.wrapOverhead(true));
    this.saslLayer = { layer, maxSend };
  }
}
