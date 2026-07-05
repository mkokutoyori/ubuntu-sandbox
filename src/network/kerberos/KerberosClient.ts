/**
 * KerberosClient — outbound AS-exchange dialer for TCP/88 (RFC 4120 §3.1/
 * §7.2.1): real TCP dial through the device's `TcpStack`, real BER-encoded
 * KDC-REQ/KDC-REP/KRB-ERROR PDUs sent as raw `Uint8Array`s (mirrors
 * `LdapClient`'s dial/round-trip pattern for TCP/389).
 *
 * PRD-Windows-Server-Advanced.md §5 P1 — AS exchange only (no TGS-REQ yet,
 * that's §5 P2): sends AS-REQ without pre-auth, expects
 * KDC_ERR_PREAUTH_REQUIRED, retries with PA-ENC-TIMESTAMP derived from the
 * user's password, and decrypts the resulting AS-REP.
 */
import type { TcpStack, TcpSocket } from '@/network/tcp/TcpStack';
import {
  encodeKdcReq, decodeKdcRep, decodeKrbError, isKrbError,
  encodeEncryptedData, encodePaEncTsEnc, decodeEncKdcRepPart,
} from './codec';
import {
  principalName, PrincipalNameType, PA_ENC_TIMESTAMP, KrbErrorCode,
  type KdcReq, type Ticket, type EncKdcRepPart,
} from './types';
import { AES256_CTS_HMAC_SHA1_96, stringToKey, encryptWithUsage, decryptWithUsage, KU_PA_ENC_TIMESTAMP, KU_AS_REP_ENC_PART } from './crypto';

export interface KerberosConnectResult { ok: boolean; error?: string; client?: KerberosClient }

export interface AsExchangeResult {
  ok: boolean;
  errorCode?: number;
  eText?: string;
  sessionKey?: string;
  ticket?: Ticket;
  encKdcRepPart?: EncKdcRepPart;
}

const TICKET_REQUEST_LIFETIME_SECONDS = 8 * 3600;

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
    const rep = decodeKdcRep(bytes);
    const clientKey = stringToKey(password, realm);
    const plaintext = decryptWithUsage(clientKey, KU_AS_REP_ENC_PART, rep.encPart.cipher);
    const encKdcRepPart = decodeEncKdcRepPart(plaintext);
    if (encKdcRepPart.nonce !== nonce) return { ok: false, eText: 'nonce mismatch (possible replay)' };
    return {
      ok: true, ticket: rep.ticket, encKdcRepPart,
      sessionKey: new TextDecoder().decode(encKdcRepPart.key.keyValue),
    };
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
