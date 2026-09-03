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
  encodeLdapMessage, decodeLdapMessage, ldapResult, LdapResultCode,
  START_TLS_OID, PAGED_RESULTS_CONTROL_OID, encodePagedResultsValue, decodePagedResultsValue,
} from './LdapMessage';
import { decodeApReq, decodeAuthenticator, decodeEncTicketPart } from '@/network/kerberos/codec';
import { stringToKey, decryptWithUsage, KU_TICKET, KU_AP_REQ_AUTHENTICATOR } from '@/network/kerberos/crypto';
import type { TlsServerConfig } from '@/network/tls/TlsServerSession';
import { TlsServerSession } from '@/network/tls/TlsServerSession';
import { encryptApplicationData, decryptApplicationData } from '@/network/http/https/ApplicationDataCipher';
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
export interface LdapKerberosContext {
  realm: string;
  serviceSecret: string;
}

export interface LdapServerContext {
  tree: DirectoryTree;
  auth: LdapBindCheck;
  kerberos?: LdapKerberosContext;
  /** RFC 4511 §4.14.1 StartTLS — omitted (`undefined`) means `extendedRequest` is refused with `protocolError`, same as before this phase (PRD-Windows-Server-Advanced.md §5 P11). */
  startTls?: TlsServerConfig;
  /**
   * RFC 4511 §4.1.10/§4.5.2 referrals (§5 P11, useful for §5 P8/P9's
   * multi-domain forest): DN-root strings (e.g.
   * `"DC=child,DC=lab,DC=local"`) of every *other* domain in this DC's
   * forest, so a search whose base lies there returns a
   * `searchResultReference` instead of an empty success.
   */
  otherForestDomainRoots?: () => string[];
}

const MEMBER_ATTRIBUTE = 'member';

function expiringLinkTtl(attributeDescription: string): number | null {
  const match = /^member;ttl=(\d+)$/i.exec(attributeDescription.trim());
  return match ? parseInt(match[1], 10) : null;
}

const CLOCK_SKEW_SECONDS = 5 * 60;

function treeMessageToResultCode(message: string): number {
  if (message.startsWith('noSuchObject')) return LdapResultCode.noSuchObject;
  if (message.startsWith('entryAlreadyExists')) return LdapResultCode.entryAlreadyExists;
  if (message.startsWith('notAllowedOnNonLeaf')) return LdapResultCode.notAllowedOnNonLeaf;
  if (message.startsWith('namingViolation')) return LdapResultCode.namingViolation;
  return LdapResultCode.operationsError;
}

function entryToAttributes(entry: DirectoryEntry, wanted: string[]): PartialAttribute[] {
  const all = [...entry.attributes.entries()].map(([type, values]) => ({ type, values }));
  if (wanted.length === 0 || wanted.includes('*')) return all;
  const wantedLower = new Set(wanted.map(w => w.toLowerCase()));
  return all.filter(a => wantedLower.has(a.type.toLowerCase()));
}

const NOT_BOUND: LdapResult = { resultCode: LdapResultCode.operationsError, matchedDN: '', diagnosticMessage: 'operation requires a successful bind' };

export class LdapServerHandler {
  private bound = false;
  /** Non-null once an `extendedRequest` StartTLS has been accepted — `result === null` while the handshake itself is still in progress (§5 P11). */
  private tls: TlsServerSession | null = null;
  private tlsSendSeq = 0;
  private tlsRecvSeq = 0;
  /** Whether the *inbound* message currently being handled arrived as TLS application data — read by `reply()` so its response goes back the same way. */
  private replyEncrypted = false;

  constructor(private readonly ctx: LdapServerContext) {}

  register(socket: TcpSocket): void {
    socket.onData((data) => {
      if (!(data instanceof Uint8Array)) return;
      if (this.tls && this.tls.result === null) {
        stepServerHandshake(this.tls, socket, data);
        return;
      }
      if (this.tls && this.tls.result === 'accept') {
        let msg: LdapMessage;
        try {
          const { plaintext, nextSeq } = decryptApplicationData(this.tls.clientApplicationTrafficSecret!, this.tlsRecvSeq, decodeRecords(data));
          this.tlsRecvSeq = nextSeq;
          msg = decodeLdapMessage(plaintext);
        } catch { return; }
        this.replyEncrypted = true;
        this.handle(socket, msg);
        return;
      }
      let msg: LdapMessage;
      try { msg = decodeLdapMessage(data); } catch { return; }
      this.replyEncrypted = false;
      this.handle(socket, msg);
    });
  }

  private reply(socket: TcpSocket, messageID: number, protocolOp: ProtocolOp, controls?: LdapControl[]): void {
    const bytes = encodeLdapMessage({ messageID, protocolOp, controls });
    if (this.replyEncrypted && this.tls && this.tls.result === 'accept') {
      const { records, nextSeq } = encryptApplicationData(this.tls.serverApplicationTrafficSecret!, this.tlsSendSeq, bytes);
      this.tlsSendSeq = nextSeq;
      socket.send(encodeRecords(records));
      return;
    }
    socket.send(bytes);
  }

  private handle(socket: TcpSocket, msg: LdapMessage): void {
    const op = msg.protocolOp;
    switch (op.kind) {
      case 'bindRequest': {
        if (op.sasl) {
          this.bound = this.checkSaslBind(op.sasl);
          this.reply(socket, msg.messageID, {
            kind: 'bindResponse',
            result: this.bound ? ldapResult(LdapResultCode.success) : ldapResult(LdapResultCode.invalidCredentials),
          });
          return;
        }
        const anonymous = op.name === '' && op.password === '';
        this.bound = anonymous || this.ctx.auth.checkBind(op.name, op.password);
        this.reply(socket, msg.messageID, {
          kind: 'bindResponse',
          result: this.bound ? ldapResult(LdapResultCode.success) : ldapResult(LdapResultCode.invalidCredentials),
        });
        return;
      }
      case 'unbindRequest':
        socket.close();
        return;
      case 'searchRequest': {
        if (!this.bound) { this.reply(socket, msg.messageID, { kind: 'searchResultDone', result: NOT_BOUND }); return; }
        if (op.baseObject.trim() === '' && op.scope === 'base') {
          this.reply(socket, msg.messageID, {
            kind: 'searchResultEntry', objectName: '',
            attributes: this.rootDseAttributes(op.attributes),
          });
          this.reply(socket, msg.messageID, { kind: 'searchResultDone', result: ldapResult(LdapResultCode.success) });
          return;
        }
        const baseDn = this.tryParseDn(op.baseObject);
        if (!baseDn) { this.reply(socket, msg.messageID, { kind: 'searchResultDone', result: ldapResult(LdapResultCode.invalidDNSyntax) }); return; }

        {
          // Checked before `isWithinTree`: a child domain's root
          // (`DC=child,DC=lab,DC=local`) is itself a longer, more specific
          // suffix than this DC's own root (`DC=lab,DC=local`) — which is
          // *also* technically a trailing suffix of it. The explicit
          // forest-domain match must win, or a search meant for the child
          // domain would be silently (and wrongly) treated as local.
          const referralUri = this.referralFor(baseDn);
          if (referralUri) {
            this.reply(socket, msg.messageID, { kind: 'searchResultReference', uris: [referralUri] });
            this.reply(socket, msg.messageID, { kind: 'searchResultDone', result: ldapResult(LdapResultCode.referral) });
            return;
          }
        }

        const entries = this.ctx.tree.search(baseDn, op.scope, op.filter);
        const { page, responseControls } = this.paginate(entries, msg.controls);
        for (const entry of page) {
          this.reply(socket, msg.messageID, {
            kind: 'searchResultEntry',
            objectName: formatDN(entry.dn),
            attributes: entryToAttributes(entry, op.attributes),
          });
        }
        this.reply(socket, msg.messageID, { kind: 'searchResultDone', result: ldapResult(LdapResultCode.success) }, responseControls);
        return;
      }
      case 'addRequest': {
        if (!this.bound) { this.reply(socket, msg.messageID, { kind: 'addResponse', result: NOT_BOUND }); return; }
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
        if (!this.bound) { this.reply(socket, msg.messageID, { kind: 'modifyResponse', result: NOT_BOUND }); return; }
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
        if (!this.bound) { this.reply(socket, msg.messageID, { kind: 'delResponse', result: NOT_BOUND }); return; }
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
        if (!this.bound) { this.reply(socket, msg.messageID, { kind: 'compareResponse', result: NOT_BOUND }); return; }
        const dn = this.tryParseDn(op.entry);
        if (!dn) { this.reply(socket, msg.messageID, { kind: 'compareResponse', result: ldapResult(LdapResultCode.invalidDNSyntax) }); return; }
        const outcome = this.ctx.tree.compare(dn, op.attributeDesc, op.assertionValue);
        const result = outcome === 'noSuchObject' ? ldapResult(LdapResultCode.noSuchObject)
          : outcome === 'true' ? ldapResult(LdapResultCode.compareTrue) : ldapResult(LdapResultCode.compareFalse);
        this.reply(socket, msg.messageID, { kind: 'compareResponse', result });
        return;
      }
      case 'modifyDNRequest': {
        if (!this.bound) { this.reply(socket, msg.messageID, { kind: 'modifyDNResponse', result: NOT_BOUND }); return; }
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
  private rootDseAttributes(requested: string[]): PartialAttribute[] {
    const root = formatDN(this.ctx.tree.getRootDn());
    const configuration = `CN=Configuration,${root}`;
    const all: PartialAttribute[] = [
      { type: 'namingContexts', values: [root, configuration, `CN=Schema,${configuration}`] },
      { type: 'defaultNamingContext', values: [root] },
      { type: 'configurationNamingContext', values: [configuration] },
      { type: 'schemaNamingContext', values: [`CN=Schema,${configuration}`] },
      { type: 'subschemaSubentry', values: [`CN=Aggregate,CN=Schema,${configuration}`] },
      { type: 'supportedLDAPVersion', values: ['3'] },
    ];
    if (requested.length === 0) return all;
    const wanted = new Set(requested.map(a => a.toLowerCase()));
    return wanted.has('*') ? all : all.filter(a => wanted.has(a.type.toLowerCase()));
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

  /**
   * RFC 4511 §4.2 SASL bind, GSSAPI mechanism only: the `credentials` are
   * a real Kerberos AP-REQ (PRD-Windows-Server-Advanced.md §5 P3) — decrypt
   * the presented ticket with krbtgt's key, then the Authenticator with
   * the ticket's session key, and check the Authenticator's principal/
   * clock skew. No SASL security-layer negotiation (integrity/
   * confidentiality) is modeled — a single round-trip either grants or
   * refuses the bind.
   */
  private checkSaslBind(sasl: SaslCredentials): boolean {
    if (sasl.mechanism !== 'GSSAPI' || !this.ctx.kerberos) return false;
    const { realm, serviceSecret } = this.ctx.kerberos;
    try {
      const apReq = decodeApReq(sasl.credentials);
      const serviceKey = stringToKey(serviceSecret, realm);
      const ticketPart = decodeEncTicketPart(decryptWithUsage(serviceKey, KU_TICKET, apReq.ticket.encPart.cipher));
      if (ticketPart.endtime < Math.floor(Date.now() / 1000)) return false;

      const ticketSessionKey = new TextDecoder().decode(ticketPart.key.keyValue);
      const authenticator = decodeAuthenticator(decryptWithUsage(ticketSessionKey, KU_AP_REQ_AUTHENTICATOR, apReq.authenticator.cipher));
      const sameCname = authenticator.cname.nameString.join('/') === ticketPart.cname.nameString.join('/');
      const withinSkew = Math.abs(Math.floor(Date.now() / 1000) - authenticator.ctime) <= CLOCK_SKEW_SECONDS;
      return sameCname && withinSkew;
    } catch {
      return false;
    }
  }
}
