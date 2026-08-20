/**
 * Kerberos — reactive event taxonomy (PRD-Windows-Server-Advanced.md §5
 * P12), transverse to §5 P1-P11: the AS exchange, the TGS exchange
 * (ordinary service tickets, cross-realm referrals §5 P9, and S4U2Proxy
 * constrained delegation §5 P10) all publish through this single
 * discriminated union, mirroring the established `dhcp.*`/`ospf.*`
 * `events.ts` convention.
 */

export interface KerberosKdcRef {
  /** Device id of the KDC handling this exchange. */
  deviceId: string;
  realm: string;
}

export interface KerberosAsSucceededPayload extends KerberosKdcRef {
  cname: string;
}
export interface KerberosAsFailedPayload extends KerberosKdcRef {
  cname: string;
  errorCode: number;
}

export interface KerberosTgsSucceededPayload extends KerberosKdcRef {
  cname: string;
  serviceName: string;
  /** Set when this reply is an RFC 4120 §3.3.3 inter-realm referral TGT rather than the final service ticket. */
  referral: boolean;
}
export interface KerberosTgsFailedPayload extends KerberosKdcRef {
  cname: string;
  serviceName: string;
  errorCode: number;
}

export interface KerberosDelegationGrantedPayload extends KerberosKdcRef {
  /** The delegating service's own computer account (the S4U2Proxy requester). */
  delegatingService: string;
  /** The user identity carried by the evidence ticket — whose behalf the delegated ticket is issued for. */
  onBehalfOf: string;
  targetService: string;
}
export interface KerberosDelegationDeniedPayload extends KerberosKdcRef {
  delegatingService: string;
  targetService: string;
}

export type KerberosDomainEvent =
  | { topic: 'kerberos.as.succeeded'; payload: KerberosAsSucceededPayload }
  | { topic: 'kerberos.as.failed'; payload: KerberosAsFailedPayload }
  | { topic: 'kerberos.tgs.succeeded'; payload: KerberosTgsSucceededPayload }
  | { topic: 'kerberos.tgs.failed'; payload: KerberosTgsFailedPayload }
  | { topic: 'kerberos.delegation.granted'; payload: KerberosDelegationGrantedPayload }
  | { topic: 'kerberos.delegation.denied'; payload: KerberosDelegationDeniedPayload };
