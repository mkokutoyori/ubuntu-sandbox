/**
 * KerberosClient — outbound AS-exchange dialer for TCP/88 (RFC 4120 §3.1/
 * §7.2.1): real TCP dial through the device's `TcpStack`, real BER-encoded
 * KDC-REQ/KDC-REP/KRB-ERROR PDUs sent as raw `Uint8Array`s (mirrors
 * `LdapClient`'s dial/round-trip pattern for TCP/389).
 *
 * PRD-Windows-Server-Advanced.md §5 P1/P2 — the AS exchange (§3.1): sends
 * AS-REQ without pre-auth, expects KDC_ERR_PREAUTH_REQUIRED, retries with
 * PA-ENC-TIMESTAMP derived from the user's password, and decrypts the
 * resulting AS-REP; and the TGS exchange (§3.3): presents the TGT plus a
 * fresh Authenticator (PA-TGS-REQ) to obtain a service ticket.
 */
import type { TcpStack, TcpSocket } from '@/network/tcp/TcpStack';
import {
  encodeKdcReq, decodeKdcRep, decodeKrbError, isKrbError,
  encodeEncryptedData, encodePaEncTsEnc, decodeEncKdcRepPart,
  encodeAuthenticator, encodeApReq,
} from './codec';
import {
  principalName, PrincipalNameType, PA_ENC_TIMESTAMP, PA_TGS_REQ, KrbErrorCode,
  type KdcReq, type Ticket, type EncKdcRepPart, type PrincipalName,
} from './types';
import {
  AES256_CTS_HMAC_SHA1_96, stringToKey, encryptWithUsage, decryptWithUsage,
  KU_PA_ENC_TIMESTAMP, KU_AS_REP_ENC_PART, KU_TGS_REQ_AUTHENTICATOR, KU_TGS_REP_ENC_PART,
} from './crypto';

/**
 * RFC 4120 §5.5.1 — builds an AP-REQ presenting `ticket` (already obtained,
 * e.g. from an AS or TGS exchange) plus a fresh Authenticator encrypted
 * under `sessionKey` with the given key-usage number. Shared by the TGS
 * exchange (usage 7, `KU_TGS_REQ_AUTHENTICATOR`) and any direct
 * application-server AP-REQ such as LDAP's GSSAPI SASL bind (usage 11,
 * `KU_AP_REQ_AUTHENTICATOR`, PRD-Windows-Server-Advanced.md §5 P3).
 */
export function buildApReq(ticket: Ticket, sessionKey: string, cname: PrincipalName, crealm: string, usage: number): Uint8Array {
  const authenticatorCipher = encryptWithUsage(
    sessionKey, usage,
    encodeAuthenticator({ crealm, cname, ctime: Math.floor(Date.now() / 1000), cusec: 0 }),
  );
  return encodeApReq({ apOptions: 0, ticket, authenticator: { etype: AES256_CTS_HMAC_SHA1_96, cipher: authenticatorCipher } });
}

export interface KerberosConnectResult { ok: boolean; error?: string; client?: KerberosClient }

export interface AsExchangeResult {
  ok: boolean;
  errorCode?: number;
  eText?: string;
  sessionKey?: string;
  ticket?: Ticket;
  encKdcRepPart?: EncKdcRepPart;
}

export type TgsExchangeResult = AsExchangeResult;

// A real Kerberos client requests a `till` far beyond any realistic KDC
// policy maximum (Windows itself typically asks for the ASN.1 "never
// expires" sentinel) — the KDC's own ticket-lifetime policy, not the
// client's request, is what actually governs the granted endtime.
const TICKET_REQUEST_LIFETIME_SECONDS = 24 * 3600;

export class KerberosClient {
  private nextNonce = 1;

  constructor(private readonly socket: TcpSocket) {}

  private roundTrip(bytes: Uint8Array): Uint8Array | null {
    let reply: Uint8Array | null = null;
    const unsubscribe = this.socket.onData((data) => {
      if (data instanceof Uint8Array) reply = data;
    });
    this.socket.send(bytes);
    unsubscribe();
    return reply;
  }

  /** RFC 4120 §3.1 — the full AS exchange for `username`/`password` against `realm`, requesting a ticket for `serviceName` (defaults to the realm's own krbtgt, i.e. a plain TGT). */
  asExchange(username: string, password: string, realm: string, serviceName: string = 'krbtgt'): AsExchangeResult {
    const cname = principalName(PrincipalNameType.NT_PRINCIPAL, username);
    const sname = principalName(PrincipalNameType.NT_SRV_INST, serviceName, realm);
    const nonce = this.nextNonce++;
    const till = Math.floor(Date.now() / 1000) + TICKET_REQUEST_LIFETIME_SECONDS;
    const baseReq: KdcReq = {
      msgType: 'AS-REQ', padata: [],
      reqBody: { kdcOptions: 0, cname, realm, sname, till, nonce, etype: [AES256_CTS_HMAC_SHA1_96] },
    };

    const firstReply = this.roundTrip(encodeKdcReq(baseReq));
    if (!firstReply) return { ok: false, eText: 'no reply from KDC' };
    if (!isKrbError(firstReply)) return this.finishFromRep(firstReply, password, realm, nonce);

    const firstErr = decodeKrbError(firstReply);
    if (firstErr.errorCode !== KrbErrorCode.KDC_ERR_PREAUTH_REQUIRED) {
      return { ok: false, errorCode: firstErr.errorCode, eText: firstErr.eText };
    }

    const clientKey = stringToKey(password, realm);
    const tsCipher = encryptWithUsage(clientKey, KU_PA_ENC_TIMESTAMP, encodePaEncTsEnc(Math.floor(Date.now() / 1000)));
    const paValue = encodeEncryptedData({ etype: AES256_CTS_HMAC_SHA1_96, cipher: tsCipher });
    const reqWithPa: KdcReq = { ...baseReq, padata: [{ type: PA_ENC_TIMESTAMP, value: paValue }] };

    const secondReply = this.roundTrip(encodeKdcReq(reqWithPa));
    if (!secondReply) return { ok: false, eText: 'no reply from KDC' };
    if (isKrbError(secondReply)) {
      const err = decodeKrbError(secondReply);
      return { ok: false, errorCode: err.errorCode, eText: err.eText };
    }
    return this.finishFromRep(secondReply, password, realm, nonce);
  }

  private finishFromRep(bytes: Uint8Array, password: string, realm: string, nonce: number): AsExchangeResult {
    const clientKey = stringToKey(password, realm);
    return this.decodeRep(bytes, clientKey, KU_AS_REP_ENC_PART, nonce);
  }

  private decodeRep(bytes: Uint8Array, key: string, usage: number, nonce: number): AsExchangeResult {
    const rep = decodeKdcRep(bytes);
    const plaintext = decryptWithUsage(key, usage, rep.encPart.cipher);
    const encKdcRepPart = decodeEncKdcRepPart(plaintext);
    if (encKdcRepPart.nonce !== nonce) return { ok: false, eText: 'nonce mismatch (possible replay)' };
    return {
      ok: true, ticket: rep.ticket, encKdcRepPart,
      sessionKey: new TextDecoder().decode(encKdcRepPart.key.keyValue),
    };
  }

  /**
   * RFC 4120 §3.3 — the TGS exchange: presents `tgt` (already-obtained
   * ticket) plus a fresh Authenticator built from `tgtSessionKey`/`cname`/
   * `crealm`, requesting a service ticket for `serviceName` (a computer
   * account's bare name, e.g. `SRV1` for a `HOST/SRV1`-style SPN).
   *
   * `targetRealm` (PRD-Windows-Server-Advanced.md §5 P9) is the realm the
   * desired service lives in — defaults to `crealm` (the ordinary same-
   * realm case, unchanged from P2). Passing a *different* realm asks this
   * KDC for a ticket into a foreign realm; if a trust permits it, the KDC
   * returns an inter-realm referral TGT instead of a KDC_ERR_S_PRINCIPAL_
   * UNKNOWN (see `kerberos/crossRealm.ts`).
   */
  tgsExchange(
    tgt: Ticket, tgtSessionKey: string, cname: PrincipalName, crealm: string, serviceName: string,
    targetRealm: string = crealm,
  ): TgsExchangeResult {
    const sname = principalName(PrincipalNameType.NT_SRV_HST, serviceName);
    const nonce = this.nextNonce++;
    const till = Math.floor(Date.now() / 1000) + TICKET_REQUEST_LIFETIME_SECONDS;
    const paValue = buildApReq(tgt, tgtSessionKey, cname, crealm, KU_TGS_REQ_AUTHENTICATOR);

    const req: KdcReq = {
      msgType: 'TGS-REQ', padata: [{ type: PA_TGS_REQ, value: paValue }],
      reqBody: { kdcOptions: 0, realm: targetRealm, sname, till, nonce, etype: [AES256_CTS_HMAC_SHA1_96] },
    };
    const reply = this.roundTrip(encodeKdcReq(req));
    if (!reply) return { ok: false, eText: 'no reply from KDC' };
    if (isKrbError(reply)) {
      const err = decodeKrbError(reply);
      return { ok: false, errorCode: err.errorCode, eText: err.eText };
    }
    return this.decodeRep(reply, tgtSessionKey, KU_TGS_REP_ENC_PART, nonce);
  }

  /**
   * MS-SFU's S4U2Proxy (PRD-Windows-Server-Advanced.md §5 P10, RFC 4120
   * §5.4.1's additional-tickets): a *service* already holding its own TGT
   * (`serviceTgt`/`serviceTgtSessionKey`/`serviceCname`/`serviceCrealm`)
   * asks its realm's KDC for a ticket to `targetServiceName` on behalf of
   * a user who already authenticated to it, proven by presenting
   * `evidenceTicket` — the service ticket that user's own AP-REQ carried.
   * If `msDS-AllowedToDelegateTo` on the service's computer account lists
   * `targetServiceName`, the KDC returns a ticket whose `cname`/`crealm`
   * are the *user's*, not the service's — exactly as if the user had
   * requested it directly.
   */
  s4u2Proxy(
    serviceTgt: Ticket, serviceTgtSessionKey: string, serviceCname: PrincipalName, serviceCrealm: string,
    evidenceTicket: Ticket, targetServiceName: string,
  ): TgsExchangeResult {
    const sname = principalName(PrincipalNameType.NT_SRV_HST, targetServiceName);
    const nonce = this.nextNonce++;
    const till = Math.floor(Date.now() / 1000) + TICKET_REQUEST_LIFETIME_SECONDS;
    const paValue = buildApReq(serviceTgt, serviceTgtSessionKey, serviceCname, serviceCrealm, KU_TGS_REQ_AUTHENTICATOR);

    const req: KdcReq = {
      msgType: 'TGS-REQ', padata: [{ type: PA_TGS_REQ, value: paValue }],
      reqBody: {
        kdcOptions: 0, realm: serviceCrealm, sname, till, nonce, etype: [AES256_CTS_HMAC_SHA1_96],
        additionalTickets: [evidenceTicket],
      },
    };
    const reply = this.roundTrip(encodeKdcReq(req));
    if (!reply) return { ok: false, eText: 'no reply from KDC' };
    if (isKrbError(reply)) {
      const err = decodeKrbError(reply);
      return { ok: false, errorCode: err.errorCode, eText: err.eText };
    }
    return this.decodeRep(reply, serviceTgtSessionKey, KU_TGS_REP_ENC_PART, nonce);
  }
}

/** Dial TCP/88 on `targetIp` and wrap the socket in a `KerberosClient`. */
export function dialKdc(tcpStack: TcpStack, targetIp: string): KerberosConnectResult {
  const socket = tcpStack.connect(targetIp, 88);
  if (!socket || socket.state !== 'established') {
    return { ok: false, error: "A local error occurred (Can't contact KDC)" };
  }
  return { ok: true, client: new KerberosClient(socket) };
}
