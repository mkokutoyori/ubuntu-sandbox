/**
 * AD CS — reactive event taxonomy (PRD-Windows-Server-Advanced.md §5 P23),
 * transverse to §5 P13: `certreq -submit`/`Get-Certificate` issuance
 * publishes through this topic, mirroring the established `kerberos.*`/
 * `replication.*` `events.ts` convention (§5 P12). No `adcs.certificate.
 * revoked` topic: this simulator never implements `Revoke-Certificate`/CRL
 * (§2.2 non-objectifs) — an event for a lifecycle stage that doesn't exist
 * would be hollow observability, not real fidelity.
 */

export interface AdcsCertificateIssuedPayload {
  /** Device id of the CA that issued this certificate. */
  deviceId: string;
  subject: string;
  templateName: string;
  serialNumber: string;
}

export type AdcsDomainEvent =
  | { topic: 'adcs.certificate.issued'; payload: AdcsCertificateIssuedPayload };
