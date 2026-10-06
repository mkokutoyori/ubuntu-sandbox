import { simulationNowMs } from '@/network/core/SystemClock';

import { decodeApReq, decodeAuthenticator, decodeEncTicketPart } from '@/network/kerberos/codec';
import { stringToKey, decryptWithUsage, KU_TICKET, KU_AP_REQ_AUTHENTICATOR } from '@/network/kerberos/crypto';

export const CLOCK_SKEW_SECONDS = 5 * 60;

export interface KerberosServiceIdentity {
  readonly realm: string;
  readonly serviceSecret: string;
  readonly clockMs?: () => number;
}

export function verifyApReq(
  apReqBytes: Uint8Array, service: KerberosServiceIdentity, nowSeconds: number = Math.floor((service.clockMs ?? simulationNowMs)() / 1000),
): string | null {
  try {
    const apReq = decodeApReq(apReqBytes);
    const serviceKey = stringToKey(service.serviceSecret, service.realm);
    const ticketPart = decodeEncTicketPart(decryptWithUsage(serviceKey, KU_TICKET, apReq.ticket.encPart.cipher));
    if (ticketPart.endtime < nowSeconds) return null;
    const ticketSessionKey = new TextDecoder().decode(ticketPart.key.keyValue);
    const authenticator = decodeAuthenticator(
      decryptWithUsage(ticketSessionKey, KU_AP_REQ_AUTHENTICATOR, apReq.authenticator.cipher));
    const principal = ticketPart.cname.nameString.join('/');
    const sameCname = authenticator.cname.nameString.join('/') === principal;
    const withinSkew = Math.abs(nowSeconds - authenticator.ctime) <= CLOCK_SKEW_SECONDS;
    return sameCname && withinSkew ? principal : null;
  } catch {
    return null;
  }
}
