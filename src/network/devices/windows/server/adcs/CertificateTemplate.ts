/**
 * CertificateTemplate — AD CS's minimal certificate-template catalog
 * (PRD-Windows-Server-Advanced.md §5 P13, §2.1.13): just enough to gate
 * `certreq -submit` by purpose (Extended Key Usage) and validity period —
 * no autoenrollment, no ACL-based enrollment permissions, no versioning.
 */

export interface CertTemplateDef {
  readonly name: string;
  readonly displayName: string;
  /** RFC 5280 §4.2.1.12 Extended Key Usage OIDs this template is allowed to issue for. */
  readonly eku: readonly string[];
  readonly validityDays: number;
}

export const DEFAULT_CERT_TEMPLATES: readonly CertTemplateDef[] = [
  {
    name: 'WebServer', displayName: 'Web Server',
    eku: ['serverAuth'], validityDays: 730,
  },
  {
    name: 'User', displayName: 'User',
    eku: ['clientAuth'], validityDays: 365,
  },
  {
    name: 'ComputerSigned', displayName: 'Computer',
    eku: ['serverAuth', 'clientAuth'], validityDays: 365,
  },
] as const;
