import { simulationNowMs } from '@/network/core/SystemClock';

import { decodeApReq, decodeAuthenticator, decodeEncTicketPart } from '@/network/kerberos/codec';
import { stringToKey, machineSalt, decryptWithUsage, KU_TICKET, KU_AP_REQ_AUTHENTICATOR } from '@/network/kerberos/crypto';
import { KrbErrorCode, type ApReq, type Authenticator, type EncTicketPart } from '@/network/kerberos/types';

export const CLOCK_SKEW_SECONDS = 5 * 60;

export interface KerberosServiceIdentity {
  readonly realm: string;
  readonly serviceSecret: string;
  readonly hostName: string;
  readonly clockMs?: () => number;
}

export class ApReplayCache {
  private readonly seen = new Map<string, number>();

  recordFresh(authenticator: Authenticator, nowSeconds: number): boolean {
    for (const [key, expiry] of this.seen) if (expiry < nowSeconds) this.seen.delete(key);
    const key = `${authenticator.cname.nameString.join('/')}@${authenticator.crealm}|${authenticator.ctime}|${authenticator.cusec}`;
    if (this.seen.has(key)) return false;
    this.seen.set(key, authenticator.ctime + CLOCK_SKEW_SECONDS);
    return true;
  }
}

export interface AcceptedApReq {
  readonly apReq: ApReq;
  readonly ticketPart: EncTicketPart;
  readonly authenticator: Authenticator;
  readonly sessionKey: Uint8Array;
}

export type ApReqOutcome =
  | { readonly ok: true; readonly accepted: AcceptedApReq }
  | { readonly ok: false; readonly errorCode: number };

export function acceptApReq(
  apReqBytes: Uint8Array, serviceKey: Uint8Array, nowSeconds: number, replayCache?: ApReplayCache,
): ApReqOutcome {
  let apReq: ApReq;
  let ticketPart: EncTicketPart;
  let authenticator: Authenticator;
  try {
    apReq = decodeApReq(apReqBytes);
    ticketPart = decodeEncTicketPart(decryptWithUsage(serviceKey, KU_TICKET, apReq.ticket.encPart.cipher));
  } catch {
    return { ok: false, errorCode: KrbErrorCode.KRB_AP_ERR_BAD_INTEGRITY };
  }
  if (ticketPart.endtime < nowSeconds) return { ok: false, errorCode: KrbErrorCode.KRB_AP_ERR_TKT_EXPIRED };
  const sessionKey = ticketPart.key.keyValue;
  try {
    authenticator = decodeAuthenticator(decryptWithUsage(sessionKey, KU_AP_REQ_AUTHENTICATOR, apReq.authenticator.cipher));
  } catch {
    return { ok: false, errorCode: KrbErrorCode.KRB_AP_ERR_BAD_INTEGRITY };
  }
  if (authenticator.cname.nameString.join('/') !== ticketPart.cname.nameString.join('/')) {
    return { ok: false, errorCode: KrbErrorCode.KRB_AP_ERR_BADMATCH };
  }
  if (Math.abs(nowSeconds - authenticator.ctime) > CLOCK_SKEW_SECONDS) return { ok: false, errorCode: KrbErrorCode.KRB_AP_ERR_SKEW };
  if (replayCache !== undefined && !replayCache.recordFresh(authenticator, nowSeconds)) {
    return { ok: false, errorCode: KrbErrorCode.KRB_AP_ERR_REPEAT };
  }
  return { ok: true, accepted: { apReq, ticketPart, authenticator, sessionKey } };
}

export function verifyApReq(
  apReqBytes: Uint8Array, service: KerberosServiceIdentity, nowSeconds: number = Math.floor((service.clockMs ?? simulationNowMs)() / 1000),
): string | null {
  const serviceKey = stringToKey(service.serviceSecret, machineSalt(service.realm, service.hostName));
  const outcome = acceptApReq(apReqBytes, serviceKey, nowSeconds);
  return outcome.ok ? outcome.accepted.ticketPart.cname.nameString.join('/') : null;
}
