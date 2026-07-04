/**
 * LdapClient — outbound LDAP dialer (RFC 4511 §5): real TCP/389 dial
 * through the device's `TcpStack`, real BER-encoded LDAPMessage PDUs sent
 * as raw `Uint8Array`s. Intended for AD cmdlets and domain join (P6) to
 * use instead of direct method calls into another device's `DirectoryTree`.
 */

import type { TcpStack, TcpSocket } from '@/network/tcp/TcpStack';
import {
  type LdapMessage, type ProtocolOp, type PartialAttribute, type LdapResult,
  encodeLdapMessage, decodeLdapMessage, LdapResultCode,
} from './LdapMessage';
import type { LdapFilter } from './LdapFilter';
import type { SearchScope, ModOperation } from './DirectoryTree';

export interface LdapConnectResult { ok: boolean; error?: string; client?: LdapClient }
export interface LdapSearchResultItem { dn: string; attributes: PartialAttribute[] }
export interface LdapOpResult { ok: boolean; result: LdapResult }
export interface LdapCompareResult extends LdapOpResult { compareResult?: 'true' | 'false' }
export interface LdapSearchOutcome { ok: boolean; result: LdapResult; entries: LdapSearchResultItem[] }

const NO_RESPONSE = (kind: string): LdapResult => ({ resultCode: LdapResultCode.operationsError, matchedDN: '', diagnosticMessage: `no ${kind} received` });

export class LdapClient {
  private nextMessageId = 1;

  constructor(private readonly socket: TcpSocket) {}

  /** Sends one request and synchronously collects every reply the server pushes back before returning (search yields N entries + 1 done). */
  private roundTrip(op: ProtocolOp): LdapMessage[] {
    const messageID = this.nextMessageId++;
    const replies: LdapMessage[] = [];
    const unsubscribe = this.socket.onData((data) => {
      if (!(data instanceof Uint8Array)) return;
      try { replies.push(decodeLdapMessage(data)); } catch { /* ignore malformed */ }
    });
    this.socket.send(encodeLdapMessage({ messageID, protocolOp: op }));
    unsubscribe();
    return replies;
  }

  bind(name: string, password: string): LdapOpResult {
    const [reply] = this.roundTrip({ kind: 'bindRequest', version: 3, name, password });
    if (!reply || reply.protocolOp.kind !== 'bindResponse') return { ok: false, result: NO_RESPONSE('bindResponse') };
    return { ok: reply.protocolOp.result.resultCode === LdapResultCode.success, result: reply.protocolOp.result };
  }

  search(baseObject: string, scope: SearchScope, filter: LdapFilter, attributes: string[] = []): LdapSearchOutcome {
    const replies = this.roundTrip({
      kind: 'searchRequest', baseObject, scope, derefAliases: 0,
      sizeLimit: 0, timeLimit: 0, typesOnly: false, filter, attributes,
    });
    const entries: LdapSearchResultItem[] = [];
    let done: LdapResult = NO_RESPONSE('searchResultDone');
    for (const reply of replies) {
      if (reply.protocolOp.kind === 'searchResultEntry') entries.push({ dn: reply.protocolOp.objectName, attributes: reply.protocolOp.attributes });
      else if (reply.protocolOp.kind === 'searchResultDone') done = reply.protocolOp.result;
    }
    return { ok: done.resultCode === LdapResultCode.success, result: done, entries };
  }

  add(entry: string, attributes: PartialAttribute[]): LdapOpResult {
    const [reply] = this.roundTrip({ kind: 'addRequest', entry, attributes });
    if (!reply || reply.protocolOp.kind !== 'addResponse') return { ok: false, result: NO_RESPONSE('addResponse') };
    return { ok: reply.protocolOp.result.resultCode === LdapResultCode.success, result: reply.protocolOp.result };
  }

  modify(object: string, changes: { operation: ModOperation; modification: PartialAttribute }[]): LdapOpResult {
    const [reply] = this.roundTrip({ kind: 'modifyRequest', object, changes });
    if (!reply || reply.protocolOp.kind !== 'modifyResponse') return { ok: false, result: NO_RESPONSE('modifyResponse') };
    return { ok: reply.protocolOp.result.resultCode === LdapResultCode.success, result: reply.protocolOp.result };
  }

  delete(entry: string): LdapOpResult {
    const [reply] = this.roundTrip({ kind: 'delRequest', entry });
    if (!reply || reply.protocolOp.kind !== 'delResponse') return { ok: false, result: NO_RESPONSE('delResponse') };
    return { ok: reply.protocolOp.result.resultCode === LdapResultCode.success, result: reply.protocolOp.result };
  }

  compare(entry: string, attributeDesc: string, assertionValue: string): LdapCompareResult {
    const [reply] = this.roundTrip({ kind: 'compareRequest', entry, attributeDesc, assertionValue });
    if (!reply || reply.protocolOp.kind !== 'compareResponse') return { ok: false, result: NO_RESPONSE('compareResponse') };
    const code = reply.protocolOp.result.resultCode;
    const compareResult = code === LdapResultCode.compareTrue ? 'true' : code === LdapResultCode.compareFalse ? 'false' : undefined;
    return { ok: compareResult !== undefined, result: reply.protocolOp.result, compareResult };
  }

  unbind(): void {
    this.socket.send(encodeLdapMessage({ messageID: this.nextMessageId++, protocolOp: { kind: 'unbindRequest' } }));
    this.socket.close();
  }
}

/** Dial TCP/389 on `targetIp` and wrap the socket in an `LdapClient`. Does not bind — call `.bind()` next. */
export function dialLdap(tcpStack: TcpStack, targetIp: string): LdapConnectResult {
  const socket = tcpStack.connect(targetIp, 389);
  if (!socket || socket.state !== 'established') {
    return { ok: false, error: "A local error occurred (Can't contact LDAP server)" };
  }
  return { ok: true, client: new LdapClient(socket) };
}
