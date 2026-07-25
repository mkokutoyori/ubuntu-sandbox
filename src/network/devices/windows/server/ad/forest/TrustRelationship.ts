/**
 * Trust relationships (PRD-Windows-Server-Advanced.md §5 P9, MS-LSAT's
 * Trusted Domain Object simplified to the single shape this simulator
 * needs): a simple, transitive-or-not, one-way-or-bidirectional trust
 * between this domain's realm and a remote one, backing RFC 4120 §3.3.3
 * cross-realm referrals.
 *
 * Stored as an ordinary `trustedDomain` entry under `CN=System,<domain
 * root>` (same principle as sites, PRD §7 principle #6: no parallel data
 * structure) rather than a new registry, so it replicates to other DCs of
 * *this* domain via the existing USN/high-watermark mechanism (§5 P4).
 * Unlike the forest's shared `SchemaValidator` (§5 P8), a trust spans two
 * genuinely independent directories (possibly different forests
 * entirely) — there is no shared object to reference, so `New-ADTrust`
 * pushes the mirrored, direction-flipped record to the remote domain via
 * a real LDAP `AddRequest` on the connection it already opened to verify
 * reachability/credentials (`WindowsServer.newADTrust`).
 */
import { DirectoryTree, type DirectoryEntry } from '../ldap/DirectoryTree';
import { parseDN, type DistinguishedName } from '../ldap/LdapDN';

export type TrustDirection = 'Inbound' | 'Outbound' | 'Bidirectional';

export interface TrustOpResult { ok: boolean; message: string }

export interface TrustInfo {
  readonly remoteRealm: string;
  readonly direction: TrustDirection;
  readonly transitive: boolean;
}

export interface TrustRecord extends TrustInfo {
  readonly interrealmKey: string;
}

function firstOf(values: string[] | undefined): string { return values?.[0] ?? ''; }

/** The direction the *other* side of the trust should record for the same relationship — 'Bidirectional' is symmetric, 'Inbound'/'Outbound' flip. */
export function mirroredDirection(direction: TrustDirection): TrustDirection {
  if (direction === 'Inbound') return 'Outbound';
  if (direction === 'Outbound') return 'Inbound';
  return 'Bidirectional';
}

export class TrustRegistry {
  private readonly systemDn: DistinguishedName;

  constructor(private readonly tree: DirectoryTree) {
    this.systemDn = [...parseDN('CN=System'), ...tree.getRootDn()];
  }

  private ensureContainer(): void {
    if (!this.tree.getByDn(this.systemDn)) {
      this.tree.addEntry(this.systemDn, { objectClass: ['top', 'container'], cn: ['System'] });
    }
  }

  private trustDn(remoteRealm: string): DistinguishedName {
    return [...parseDN(`CN=${remoteRealm}`), ...this.systemDn];
  }

  addTrust(remoteRealm: string, direction: TrustDirection, transitive: boolean, interrealmKey: string): TrustOpResult {
    this.ensureContainer();
    const res = this.tree.addEntry(this.trustDn(remoteRealm), {
      objectClass: ['top', 'trustedDomain'],
      cn: [remoteRealm],
      trustPartner: [remoteRealm],
      trustDirection: [direction],
      trustAttributes: [transitive ? 'transitive' : 'nonTransitive'],
      trustAuthIncoming: [interrealmKey],
    });
    return res.ok ? { ok: true, message: '' } : { ok: false, message: `A trust with "${remoteRealm}" already exists.` };
  }

  getTrust(remoteRealm: string): TrustRecord | null {
    this.ensureContainer();
    const entry = this.tree.getByDn(this.trustDn(remoteRealm));
    if (!entry) return null;
    return this.project(entry);
  }

  /** `netdom trust /Remove` (docs/PRD-Netdom.md §2.1 P9) — the symmetric inverse of `addTrust`. */
  removeTrust(remoteRealm: string): TrustOpResult {
    this.ensureContainer();
    const res = this.tree.deleteEntry(this.trustDn(remoteRealm));
    return res.ok ? { ok: true, message: '' } : { ok: false, message: `Cannot find a trust with identity: '${remoteRealm}'.` };
  }

  /** `netdom trust /Reset` (docs/PRD-Netdom.md §2.1 P9) — regenerates an existing trust's interrealm key in place (same object, `trustAuthIncoming` replaced), rather than dropping and recreating the relationship. */
  resetTrustSecret(remoteRealm: string, newInterrealmKey: string): TrustOpResult {
    this.ensureContainer();
    const dn = this.trustDn(remoteRealm);
    if (!this.tree.getByDn(dn)) return { ok: false, message: `Cannot find a trust with identity: '${remoteRealm}'.` };
    this.tree.modifyEntry(dn, [{ op: 'replace', type: 'trustAuthIncoming', values: [newInterrealmKey] }]);
    return { ok: true, message: '' };
  }

  listTrusts(): TrustInfo[] {
    this.ensureContainer();
    const container = this.tree.getByDn(this.systemDn);
    if (!container) return [];
    return [...container.children.values()]
      .filter((e) => hasObjectClass(e, 'trustedDomain'))
      .map((e) => this.project(e));
  }

  private project(entry: DirectoryEntry): TrustRecord {
    return {
      remoteRealm: firstOf(entry.attributes.get('trustpartner')),
      direction: (firstOf(entry.attributes.get('trustdirection')) || 'Bidirectional') as TrustDirection,
      transitive: firstOf(entry.attributes.get('trustattributes')) === 'transitive',
      interrealmKey: firstOf(entry.attributes.get('trustauthincoming')),
    };
  }
}

function hasObjectClass(entry: DirectoryEntry, oc: string): boolean {
  return (entry.attributes.get('objectclass') ?? []).some(v => v.toLowerCase() === oc.toLowerCase());
}
