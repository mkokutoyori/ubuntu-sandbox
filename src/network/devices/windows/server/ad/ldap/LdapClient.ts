/**
 * LdapClient — outbound LDAP dialer (RFC 4511 §5): real TCP/389 dial
 * through the device's `TcpStack`, real BER-encoded LDAPMessage PDUs sent
 * as raw `Uint8Array`s. Intended for AD cmdlets and domain join (P6) to
 * use instead of direct method calls into another device's `DirectoryTree`.
 */

import type { TcpStack, TcpSocket } from '@/network/tcp/TcpStack';
import {
  type LdapMessage, type ProtocolOp, type PartialAttribute, type LdapResult, type LdapControl,
  encodeLdapMessage, decodeLdapMessages, LdapResultCode,
  START_TLS_OID, PAGED_RESULTS_CONTROL_OID, encodePagedResultsValue, decodePagedResultsValue,
} from './LdapMessage';
import type { LdapFilter } from './LdapFilter';
import type { SearchScope, ModOperation } from './DirectoryTree';
import type { TlsClientConfig, TlsClientSession } from '@/network/tls/TlsClientSession';
import { encryptApplicationData, decryptApplicationData } from '@/network/http/https/ApplicationDataCipher';
import { encodeRecords, decodeRecords } from '@/network/http/https/TlsRecordWire';
import { driveClientHandshake } from './ldapStartTls';
import { attributeFromWire } from './LdapWireSyntax';

export interface LdapConnectResult { ok: boolean; error?: string; client?: LdapClient; reason?: 'refused' | 'unroutable' | 'unanswered' }
export interface LdapSearchResultItem { dn: string; attributes: PartialAttribute[] }
export interface LdapOpResult { ok: boolean; result: LdapResult }
export interface LdapCompareResult extends LdapOpResult { compareResult?: 'true' | 'false' }
export interface LdapSearchOutcome {
  ok: boolean; result: LdapResult; entries: LdapSearchResultItem[];
  /** RFC 4511 §4.5.2 continuation references — non-empty when the search targets a DN outside this DC's own domain but within a known forest domain (§5 P8/P9). */
  references: string[];
  /** RFC 2696 paged results — the cookie for the next page, if the result set has more entries than fit in one page. */
  nextCookie?: Uint8Array;
}

const NO_RESPONSE = (kind: string): LdapResult => ({ resultCode: LdapResultCode.operationsError, matchedDN: '', diagnosticMessage: `no ${kind} received` });

export class LdapClient {
  private nextMessageId = 1;
  private tls: TlsClientSession | null = null;
  private tlsSendSeq = 0;
  private tlsRecvSeq = 0;

  constructor(private readonly socket: TcpSocket) {}

  /** Sends one request and synchronously collects every reply the server pushes back before returning (search yields N entries + 1 done). Transparently encrypted once `startTls` has established a session. */
  private roundTrip(op: ProtocolOp, controls?: LdapControl[]): LdapMessage[] {
    return this.exchange(this.nextMessageId++, op, controls).replies;
  }

  exchange(messageID: number, op: ProtocolOp, controls?: readonly LdapControl[]): { replies: LdapMessage[]; closed: boolean } {
    const replies: LdapMessage[] = [];
    let pending = new Uint8Array(0);
    const unsubscribe = this.socket.onData((data) => {
      if (!(data instanceof Uint8Array)) return;
      try {
        const plaintext = this.tls ? this.decryptIncoming(data) : data;
        const joined = new Uint8Array(pending.length + plaintext.length);
        joined.set(pending, 0);
        joined.set(plaintext, pending.length);
        const { messages, bytesConsumed } = decodeLdapMessages(joined);
        pending = joined.slice(bytesConsumed);
        for (const message of messages) replies.push(message);
      } catch { /* ignore malformed */ }
    });
    const bytes = encodeLdapMessage({ messageID, protocolOp: op, controls: controls === undefined ? undefined : [...controls] });
    this.socket.send(this.tls ? this.encryptOutgoing(bytes) : bytes);
    unsubscribe();
    return { replies, closed: this.socket.state !== 'established' };
  }

  get isEncrypted(): boolean {
    return this.tls !== null;
  }

  attachTls(config: TlsClientConfig): { ok: true } | { ok: false; reason: string | null } {
    this.rawSuspended = true;
    const session = driveClientHandshake(this.socket, config);
    this.rawSuspended = false;
    if (session === null) return { ok: false, reason: null };
    this.tls = session;
    return { ok: true };
  }

  private rawInbox: Uint8Array = new Uint8Array(0);
  private rawSubscription: (() => void) | null = null;
  private rawSuspended = false;

  openRawLink(): void {
    if (this.rawSubscription !== null) return;
    this.rawSubscription = this.socket.onData((data) => {
      if (!(data instanceof Uint8Array) || this.rawSuspended) return;
      let plaintext: Uint8Array;
      try {
        plaintext = this.tls ? this.decryptIncoming(data) : data;
      } catch {
        return;
      }
      const joined = new Uint8Array(this.rawInbox.length + plaintext.length);
      joined.set(this.rawInbox, 0);
      joined.set(plaintext, this.rawInbox.length);
      this.rawInbox = joined;
    });
  }

  rawWrite(bytes: Uint8Array): boolean {
    if (this.socket.state !== 'established') return false;
    this.socket.send(this.tls ? this.encryptOutgoing(bytes) : bytes);
    return true;
  }

  rawRead(want: number): { kind: 'data'; bytes: Uint8Array } | { kind: 'eof' } | { kind: 'again' } {
    if (this.rawInbox.length > 0) {
      const taken = this.rawInbox.slice(0, want);
      this.rawInbox = this.rawInbox.slice(taken.length);
      return { kind: 'data', bytes: taken };
    }
    return this.socket.state === 'established' ? { kind: 'again' } : { kind: 'eof' };
  }

  rawReadable(): boolean {
    return this.rawInbox.length > 0 || this.socket.state !== 'established';
  }

  get localEndpoint(): string {
    const address = this.socket.localIp;
    return address.includes(':') ? `IP=[${address}]:${this.socket.localPort}` : `IP=${address}:${this.socket.localPort}`;
  }

  closeRawLink(): void {
    this.rawSubscription?.();
    this.rawSubscription = null;
    this.socket.close();
  }

  get peerAddress(): string {
    return this.socket.remoteIp;
  }

  private encryptOutgoing(bytes: Uint8Array): Uint8Array {
    const { records, nextSeq } = encryptApplicationData(this.tls!.clientTraffic(), this.tlsSendSeq, bytes);
    this.tlsSendSeq = nextSeq;
    return encodeRecords(records);
  }

  private decryptIncoming(wire: Uint8Array): Uint8Array {
    const { plaintext, nextSeq } = decryptApplicationData(this.tls!.serverTraffic(), this.tlsRecvSeq, decodeRecords(wire));
    this.tlsRecvSeq = nextSeq;
    return plaintext;
  }

  /** RFC 4511 §4.14.1 StartTLS — negotiates the extended operation, then drives a real TLS 1.3 handshake over this same connection; every operation after a successful call is transparently encrypted. */
  startTls(config: TlsClientConfig): LdapOpResult {
    const [reply] = this.roundTrip({ kind: 'extendedRequest', requestName: START_TLS_OID });
    if (!reply || reply.protocolOp.kind !== 'extendedResponse') return { ok: false, result: NO_RESPONSE('extendedResponse') };
    if (reply.protocolOp.result.resultCode !== LdapResultCode.success) return { ok: false, result: reply.protocolOp.result };
    const tls = driveClientHandshake(this.socket, config);
    if (!tls) {
      return { ok: false, result: { resultCode: LdapResultCode.operationsError, matchedDN: '', diagnosticMessage: 'TLS handshake failed' } };
    }
    this.tls = tls;
    return { ok: true, result: reply.protocolOp.result };
  }

  bind(name: string, password: string): LdapOpResult {
    const [reply] = this.roundTrip({ kind: 'bindRequest', version: 3, name, password });
    if (!reply || reply.protocolOp.kind !== 'bindResponse') return { ok: false, result: NO_RESPONSE('bindResponse') };
    return { ok: reply.protocolOp.result.resultCode === LdapResultCode.success, result: reply.protocolOp.result };
  }

  /** RFC 4511 §4.2 SASL bind — `credentials` is the mechanism-specific token (a real Kerberos AP-REQ for `GSSAPI`, PRD-Windows-Server-Advanced.md §5 P3). */
  bindSasl(mechanism: string, credentials: Uint8Array): LdapOpResult {
    const [reply] = this.roundTrip({ kind: 'bindRequest', version: 3, name: '', password: '', sasl: { mechanism, credentials } });
    if (!reply || reply.protocolOp.kind !== 'bindResponse') return { ok: false, result: NO_RESPONSE('bindResponse') };
    return { ok: reply.protocolOp.result.resultCode === LdapResultCode.success, result: reply.protocolOp.result };
  }

  /** `paging` (RFC 2696) requests one page of up to `size` entries; pass the previous call's `nextCookie` to fetch the following page. Omit for an ordinary unpaginated search (unchanged from before §5 P11). */
  search(
    baseObject: string, scope: SearchScope, filter: LdapFilter, attributes: string[] = [],
    paging?: { size: number; cookie?: Uint8Array },
  ): LdapSearchOutcome {
    const controls: LdapControl[] | undefined = paging ? [{
      controlType: PAGED_RESULTS_CONTROL_OID, criticality: false,
      controlValue: encodePagedResultsValue({ size: paging.size, cookie: paging.cookie ?? new Uint8Array(0) }),
    }] : undefined;
    const replies = this.roundTrip({
      kind: 'searchRequest', baseObject, scope, derefAliases: 0,
      sizeLimit: 0, timeLimit: 0, typesOnly: false, filter, attributes,
    }, controls);
    const entries: LdapSearchResultItem[] = [];
    const references: string[] = [];
    let done: LdapResult = NO_RESPONSE('searchResultDone');
    let nextCookie: Uint8Array | undefined;
    for (const reply of replies) {
      if (reply.protocolOp.kind === 'searchResultEntry') entries.push({ dn: reply.protocolOp.objectName, attributes: reply.protocolOp.attributes.map(attributeFromWire) });
      else if (reply.protocolOp.kind === 'searchResultReference') references.push(...reply.protocolOp.uris);
      else if (reply.protocolOp.kind === 'searchResultDone') {
        done = reply.protocolOp.result;
        const pagedControl = reply.controls?.find(c => c.controlType === PAGED_RESULTS_CONTROL_OID);
        if (pagedControl?.controlValue) {
          const { cookie } = decodePagedResultsValue(pagedControl.controlValue);
          if (cookie.length > 0) nextCookie = cookie;
        }
      }
    }
    return { ok: done.resultCode === LdapResultCode.success, result: done, entries, references, nextCookie };
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

  /** RFC 4511 §4.9 ModifyDNRequest — renames/moves `entry` (`Move-ADObject`/`Rename-ADObject`'s underlying wire operation). */
  modifyDN(entry: string, newRdn: string, deleteOldRdn: boolean, newSuperior?: string): LdapOpResult {
    const [reply] = this.roundTrip({ kind: 'modifyDNRequest', entry, newRdn, deleteOldRdn, newSuperior });
    if (!reply || reply.protocolOp.kind !== 'modifyDNResponse') return { ok: false, result: NO_RESPONSE('modifyDNResponse') };
    return { ok: reply.protocolOp.result.resultCode === LdapResultCode.success, result: reply.protocolOp.result };
  }

  /** RFC 4511 §4.11 AbandonRequest — fire-and-forget, never answered (a real server never replies, per the RFC). */
  abandon(targetMessageId: number): void {
    const messageID = this.nextMessageId++;
    const bytes = encodeLdapMessage({ messageID, protocolOp: { kind: 'abandonRequest', messageID: targetMessageId } });
    this.socket.send(this.tls ? this.encryptOutgoing(bytes) : bytes);
  }

  unbind(): void {
    this.socket.send(encodeLdapMessage({ messageID: this.nextMessageId++, protocolOp: { kind: 'unbindRequest' } }));
    this.socket.close();
  }
}

/** Dial TCP/389 on `targetIp` and wrap the socket in an `LdapClient`. Does not bind — call `.bind()` next. */
export function dialLdap(tcpStack: TcpStack, targetIp: string, port = 389): LdapConnectResult {
  const socket = tcpStack.connect(targetIp, port);
  if (!socket || socket.state !== 'established') {
    const reason = !socket ? 'unroutable' : socket.closeReason === 'rst' ? 'refused' : 'unanswered';
    return { ok: false, error: "A local error occurred (Can't contact LDAP server)", reason };
  }
  return { ok: true, client: new LdapClient(socket) };
}
