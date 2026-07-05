/**
 * Cross-realm Kerberos referrals (RFC 4120 §3.3.3, PRD-Windows-Server-
 * Advanced.md §5 P9): when a client's TGS-REQ asks its own realm's KDC for
 * a ticket whose target realm differs from the local one, and a trust to
 * that realm exists (`TrustRelationship.ts`), the KDC returns an
 * inter-realm TGT — a `Ticket` whose `sname` is `krbtgt/<remoteRealm>`,
 * encrypted under the interrealm key both realms' trust records share
 * (`deriveInterrealmKey`) — instead of KDC_ERR_S_PRINCIPAL_UNKNOWN. The
 * client then presents that ticket to the remote realm's own KDC exactly
 * like an ordinary TGT to obtain the real service ticket.
 */
import type { TcpStack } from '@/network/tcp/TcpStack';
import { stringToKey } from './crypto';
import { principalName, PrincipalNameType, type PrincipalName, type Ticket } from './types';
import { dialKdc, type TgsExchangeResult } from './KerberosClient';

/** Both realms must derive the identical interrealm encryption key from the shared trust secret regardless of which side is "local" — order-independent salt. */
export function deriveInterrealmKey(secret: string, realmA: string, realmB: string): string {
  const pair = [realmA.toUpperCase(), realmB.toUpperCase()].sort().join(':');
  return stringToKey(secret, `interrealm:${pair}`);
}

/** The special inter-realm TGT principal name, `krbtgt/<remoteRealm>` (RFC 4120 §3.3.3). */
export function referralPrincipal(remoteRealm: string): PrincipalName {
  return principalName(PrincipalNameType.NT_SRV_INST, 'krbtgt', remoteRealm);
}

/** Whether a returned `sname` is an inter-realm referral TGT rather than the actually-requested service. */
export function isReferralPrincipal(name: PrincipalName): boolean {
  return name.nameString[0] === 'krbtgt' && name.nameString.length > 1;
}

/**
 * The full two-hop cross-realm TGS exchange: first asks the local realm's
 * KDC (`localKdcAddress`) for `serviceName` in `remoteRealm` — if the
 * local KDC has no trust path there, this fails cleanly with whatever
 * `KrbError` it returned (typically `KDC_ERR_POLICY`). Otherwise the
 * local KDC's reply is a referral TGT, which is then presented to the
 * remote realm's own KDC (`remoteKdcAddress`) to get the real ticket.
 */
export function crossRealmTgsExchange(
  tcpStack: TcpStack, localKdcAddress: string, remoteKdcAddress: string,
  tgt: Ticket, tgtSessionKey: string, cname: PrincipalName, crealm: string,
  remoteRealm: string, serviceName: string,
): TgsExchangeResult {
  const localConn = dialKdc(tcpStack, localKdcAddress);
  if (!localConn.ok || !localConn.client) return { ok: false, eText: localConn.error };
  const referral = localConn.client.tgsExchange(tgt, tgtSessionKey, cname, crealm, serviceName, remoteRealm);
  if (!referral.ok || !referral.ticket || !referral.sessionKey || !referral.encKdcRepPart) return referral;
  if (!isReferralPrincipal(referral.encKdcRepPart.sname)) return referral; // already the real service ticket

  const remoteConn = dialKdc(tcpStack, remoteKdcAddress);
  if (!remoteConn.ok || !remoteConn.client) return { ok: false, eText: remoteConn.error };
  return remoteConn.client.tgsExchange(referral.ticket, referral.sessionKey, cname, crealm, serviceName, remoteRealm);
}
