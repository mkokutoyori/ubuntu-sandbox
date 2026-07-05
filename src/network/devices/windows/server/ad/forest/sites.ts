/**
 * Sites — minimal AD replication-topology metadata (PRD-Windows-Server-
 * Advanced.md §5 P6): named sites, each associated with one or more
 * subnets; a DC's site is derived from which subnet its IP falls in.
 * Used only to annotate a replication cycle as "intra-site" or
 * "inter-site" — no real link-cost computation or replication
 * scheduling (§2.2 scope).
 *
 * Stored as ordinary `DirectoryTree` entries under `CN=Sites,CN=
 * Configuration,<domain root>` rather than a parallel data structure
 * (PRD §7 principle #6), so site/subnet definitions replicate to other
 * DCs via the same USN/high-watermark mechanism as everything else
 * (§5 P4) — no separate sync path needed.
 */
import { IPAddress, SubnetMask } from '@/network/core/types';
import { DirectoryTree, type DirectoryEntry } from '../ldap/DirectoryTree';
import { parseDN, formatDN, type DistinguishedName } from '../ldap/LdapDN';

export interface SiteOpResult { ok: boolean; message: string }
export interface SiteInfo { name: string; dn: string }

function firstOf(values: string[] | undefined): string { return values?.[0] ?? ''; }
function hasObjectClass(entry: DirectoryEntry, oc: string): boolean {
  return (entry.attributes.get('objectclass') ?? []).some(v => v.toLowerCase() === oc.toLowerCase());
}
function leafCn(dn: string): string | null {
  const m = /^CN=([^,]+)/i.exec(dn);
  return m ? m[1] : null;
}

function parseCidr(cidr: string): { network: IPAddress; mask: SubnetMask } | null {
  const [addr, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  if (!addr || !Number.isFinite(bits) || bits < 0 || bits > 32) return null;
  const ip = IPAddress.tryParse(addr);
  if (!ip) return null;
  const mask = SubnetMask.fromCIDR(bits);
  return { network: ip.networkAddress(mask), mask };
}

export class SiteRegistry {
  private readonly configDn: DistinguishedName;
  private readonly sitesDn: DistinguishedName;
  private readonly subnetsDn: DistinguishedName;

  constructor(private readonly tree: DirectoryTree) {
    const rootDn = tree.getRootDn();
    this.configDn = [...parseDN('CN=Configuration'), ...rootDn];
    this.sitesDn = [...parseDN('CN=Sites'), ...this.configDn];
    this.subnetsDn = [...parseDN('CN=Subnets'), ...this.sitesDn];
  }

  /** Idempotent: creates any of the Configuration/Sites/Subnets containers this tree doesn't have yet (e.g. after a fresh replication sync from a DC that already has them). */
  private ensureContainers(): void {
    if (!this.tree.getByDn(this.configDn)) this.tree.addEntry(this.configDn, { objectClass: ['top', 'container'], cn: ['Configuration'] });
    if (!this.tree.getByDn(this.sitesDn)) this.tree.addEntry(this.sitesDn, { objectClass: ['top', 'container'], cn: ['Sites'] });
    if (!this.tree.getByDn(this.subnetsDn)) this.tree.addEntry(this.subnetsDn, { objectClass: ['top', 'container'], cn: ['Subnets'] });
  }

  private siteDn(name: string): DistinguishedName { return [...parseDN(`CN=${name}`), ...this.sitesDn]; }
  private subnetDn(cidr: string): DistinguishedName { return [...parseDN(`CN=${cidr}`), ...this.subnetsDn]; }

  newSite(name: string): SiteOpResult {
    this.ensureContainers();
    const res = this.tree.addEntry(this.siteDn(name), { objectClass: ['top', 'site'], cn: [name] });
    return res.ok ? { ok: true, message: '' } : { ok: false, message: `A site named "${name}" already exists.` };
  }

  listSites(): SiteInfo[] {
    this.ensureContainers();
    const container = this.tree.getByDn(this.sitesDn);
    if (!container) return [];
    return [...container.children.values()]
      .filter((e) => hasObjectClass(e, 'site'))
      .map((e) => ({ name: firstOf(e.attributes.get('cn')), dn: formatDN(e.dn) }));
  }

  newSubnet(cidr: string, siteName: string): SiteOpResult {
    this.ensureContainers();
    if (!parseCidr(cidr)) return { ok: false, message: `"${cidr}" is not a valid subnet in CIDR notation.` };
    const site = this.tree.getByDn(this.siteDn(siteName));
    if (!site) return { ok: false, message: `Cannot find a site named "${siteName}".` };
    const res = this.tree.addEntry(this.subnetDn(cidr), {
      objectClass: ['top', 'subnet'], cn: [cidr], siteObject: [formatDN(site.dn)],
    });
    return res.ok ? { ok: true, message: '' } : { ok: false, message: `Subnet "${cidr}" already exists.` };
  }

  /** The name of the site whose subnet contains `ip`, or null if no subnet covers it (real AD's fallback-to-a-guessed-site behavior in that case isn't modeled, per §2.2 scope). */
  siteForIp(ip: string): string | null {
    this.ensureContainers();
    const target = IPAddress.tryParse(ip);
    if (!target) return null;
    const container = this.tree.getByDn(this.subnetsDn);
    if (!container) return null;
    for (const entry of container.children.values()) {
      const parsed = parseCidr(firstOf(entry.attributes.get('cn')));
      if (!parsed) continue;
      if (target.isInSameSubnet(parsed.network, parsed.mask)) {
        return leafCn(firstOf(entry.attributes.get('siteobject')));
      }
    }
    return null;
  }
}
