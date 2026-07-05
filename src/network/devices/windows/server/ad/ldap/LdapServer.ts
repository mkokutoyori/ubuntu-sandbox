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
import { parseDN, formatDN } from './LdapDN';
import {
  type LdapMessage, type ProtocolOp, type PartialAttribute, type LdapResult, type SaslCredentials,
  encodeLdapMessage, decodeLdapMessage, ldapResult, LdapResultCode,
} from './LdapMessage';
import { decodeApReq, decodeAuthenticator, decodeEncTicketPart } from '@/network/kerberos/codec';
import { stringToKey, decryptWithUsage, KU_TICKET, KU_AP_REQ_AUTHENTICATOR } from '@/network/kerberos/crypto';

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

  constructor(private readonly ctx: LdapServerContext) {}

  register(socket: TcpSocket): void {
    socket.onData((data) => {
      if (!(data instanceof Uint8Array)) return;
      let msg: LdapMessage;
      try { msg = decodeLdapMessage(data); } catch { return; }
      this.handle(socket, msg);
    });
  }

  private reply(socket: TcpSocket, messageID: number, protocolOp: ProtocolOp): void {
    socket.send(encodeLdapMessage({ messageID, protocolOp }));
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
        const baseDn = this.tryParseDn(op.baseObject);
        if (!baseDn) { this.reply(socket, msg.messageID, { kind: 'searchResultDone', result: ldapResult(LdapResultCode.invalidDNSyntax) }); return; }
        const entries = this.ctx.tree.search(baseDn, op.scope, op.filter);
        for (const entry of entries) {
          this.reply(socket, msg.messageID, {
            kind: 'searchResultEntry',
            objectName: formatDN(entry.dn),
            attributes: entryToAttributes(entry, op.attributes),
          });
        }
        this.reply(socket, msg.messageID, { kind: 'searchResultDone', result: ldapResult(LdapResultCode.success) });
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
        const res = this.ctx.tree.modifyEntry(dn, op.changes.map(c => ({ op: c.operation, type: c.modification.type, values: c.modification.values })));
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
      // bindResponse/searchResultEntry/searchResultDone/modifyResponse/addResponse/delResponse/compareResponse
      // never arrive as inbound requests — a real DC never receives its own response CHOICEs.
      default:
        return;
    }
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
