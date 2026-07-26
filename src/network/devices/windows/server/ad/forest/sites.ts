/**
 * Sites — minimal AD replication-topology metadata (PRD-Windows-Server-
 * Advanced.md §5 P6): named sites, each associated with one or more
 * subnets; a DC's site is derived from which subnet its IP falls in,
 * or from an explicit admin override (`Move-ADDirectoryServer`, stored
 * on the DC's own computer object — see `DirectoryStore.assignServerToSite`)
 * when the DC's address doesn't match any subnet of its intended site —
 * precisely the scenario `Move-ADDirectoryServer -Site` exists for in
 * real AD. Used only to annotate a replication cycle as "intra-site" or
 * "inter-site" — no real link-cost computation, no ISTG/KCC election
 * (PRD-Repadmin.md §0.2 explicitly keeps `/kcc`, `/bridgeheads`,
 * `/istg`, `/siteoptions` out of scope; site links here are honest
 * admin-set bookkeeping only — cost/frequency/schedule are stored and
 * reported, never consulted to actually pace or route replication).
 *
 * Stored as ordinary `DirectoryTree` entries under `CN=Sites,CN=
 * Configuration,<domain root>` rather than a parallel data structure
 * (PRD §7 principle #6), so site/subnet/site-link definitions replicate
 * to other DCs via the same USN/high-watermark mechanism as everything
 * else (§5 P4) — no separate sync path needed. DC↔site assignment itself
 * deliberately does *not* live here as a structural entry (see
 * `DirectoryStore.assignServerToSite`'s header for why).
 */
import { IPAddress, SubnetMask } from '@/network/core/types';
import { DirectoryTree, type DirectoryEntry } from '../ldap/DirectoryTree';
import { parseDN, formatDN, type DistinguishedName } from '../ldap/LdapDN';

export interface SiteOpResult { ok: boolean; message: string }
export interface SiteInfo { name: string; dn: string; description: string }
export interface SubnetInfo { cidr: string; dn: string; site: string; description: string }

export type SiteLinkTransport = 'IP' | 'SMTP';
export interface SiteLinkInfo {
  name: string; dn: string;
  sitesIncluded: string[];
  cost: number;
  replicationFrequencyInMinutes: number;
  interSiteTransportProtocol: SiteLinkTransport;
  description: string;
}

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

export const DEFAULT_SITE_LINK_NAME = 'DEFAULTIPSITELINK';

export class SiteRegistry {
  private readonly configDn: DistinguishedName;
  private readonly sitesDn: DistinguishedName;
  private readonly subnetsDn: DistinguishedName;
  private readonly linksDn: DistinguishedName;

  constructor(private readonly tree: DirectoryTree) {
    const rootDn = tree.getRootDn();
    this.configDn = [...parseDN('CN=Configuration'), ...rootDn];
    this.sitesDn = [...parseDN('CN=Sites'), ...this.configDn];
    this.subnetsDn = [...parseDN('CN=Subnets'), ...this.sitesDn];
    this.linksDn = [...parseDN('CN=IP'), ...parseDN('CN=Inter-Site Transports'), ...this.sitesDn];
  }

  /** Idempotent: creates any of the Configuration/Sites/Subnets/Inter-Site Transports containers this tree doesn't have yet (e.g. after a fresh replication sync from a DC that already has them). */
  private ensureContainers(): void {
    if (!this.tree.getByDn(this.configDn)) this.tree.addEntry(this.configDn, { objectClass: ['top', 'container'], cn: ['Configuration'] });
    if (!this.tree.getByDn(this.sitesDn)) this.tree.addEntry(this.sitesDn, { objectClass: ['top', 'container'], cn: ['Sites'] });
    if (!this.tree.getByDn(this.subnetsDn)) this.tree.addEntry(this.subnetsDn, { objectClass: ['top', 'container'], cn: ['Subnets'] });
    if (!this.tree.getByDn(this.linksDn)) {
      const transportsDn = this.linksDn.slice(1);
      if (!this.tree.getByDn(transportsDn)) this.tree.addEntry(transportsDn, { objectClass: ['top', 'container'], cn: ['Inter-Site Transports'] });
      this.tree.addEntry(this.linksDn, { objectClass: ['top', 'container'], cn: ['IP'] });
    }
  }

  private siteDn(name: string): DistinguishedName { return [...parseDN(`CN=${name}`), ...this.sitesDn]; }
  private subnetDn(cidr: string): DistinguishedName { return [...parseDN(`CN=${cidr}`), ...this.subnetsDn]; }
  private siteLinkDn(name: string): DistinguishedName { return [...parseDN(`CN=${name}`), ...this.linksDn]; }

  /** `New-ADReplicationSite -Name <name> [-Description <text>]` — e.g. `Default-First-Site-Name`. */
  newSite(name: string, description = ''): SiteOpResult {
    this.ensureContainers();
    const res = this.tree.addEntry(this.siteDn(name), { objectClass: ['top', 'site'], cn: [name], description: description ? [description] : [] });
    return res.ok ? { ok: true, message: '' } : { ok: false, message: `A site named "${name}" already exists.` };
  }

  /** `Set-ADReplicationSite -Identity <old> -Name <new>` — renaming a site keeps its Subnets/Servers assignments intact (DN of the site entry changes, subnet `siteObject` back-references and server memberships are re-pointed). */
  renameSite(oldName: string, newName: string): SiteOpResult {
    this.ensureContainers();
    const oldDn = this.siteDn(oldName);
    const entry = this.tree.getByDn(oldDn);
    if (!entry) return { ok: false, message: `Cannot find a site named "${oldName}".` };
    const newDn = this.siteDn(newName);
    if (this.tree.getByDn(newDn)) return { ok: false, message: `A site named "${newName}" already exists.` };
    const moved = this.tree.renameEntry(oldDn, `CN=${newName}`, true);
    if (!moved.ok) return { ok: false, message: moved.message || `Unable to rename site "${oldName}".` };
    // Subnets reference their site by DN — re-point every subnet that pointed at the old DN.
    const subnetsContainer = this.tree.getByDn(this.subnetsDn);
    if (subnetsContainer) {
      const oldDnStr = formatDN(oldDn).toLowerCase();
      for (const subnet of subnetsContainer.children.values()) {
        if (firstOf(subnet.attributes.get('siteobject')).toLowerCase() === oldDnStr) {
          this.tree.modifyEntry(subnet.dn, [{ op: 'replace', type: 'siteObject', values: [formatDN(newDn)] }]);
        }
      }
    }
    // The default site link's sitesIncluded list stores plain site names — refresh it too.
    this.ensureDefaultSiteLink();
    return { ok: true, message: '' };
  }

  listSites(): SiteInfo[] {
    this.ensureContainers();
    const container = this.tree.getByDn(this.sitesDn);
    if (!container) return [];
    return [...container.children.values()]
      .filter((e) => hasObjectClass(e, 'site'))
      .map((e) => ({ name: firstOf(e.attributes.get('cn')), dn: formatDN(e.dn), description: firstOf(e.attributes.get('description')) }));
  }

  getSite(name: string): SiteInfo | null {
    const site = this.tree.getByDn(this.siteDn(name));
    return site ? { name: firstOf(site.attributes.get('cn')), dn: formatDN(site.dn), description: firstOf(site.attributes.get('description')) } : null;
  }

  /** `New-ADReplicationSubnet -Name <cidr> -Site <site> [-Description <text>]`. */
  newSubnet(cidr: string, siteName: string, description = ''): SiteOpResult {
    this.ensureContainers();
    if (!parseCidr(cidr)) return { ok: false, message: `"${cidr}" is not a valid subnet in CIDR notation.` };
    const site = this.tree.getByDn(this.siteDn(siteName));
    if (!site) return { ok: false, message: `Cannot find a site named "${siteName}".` };
    const res = this.tree.addEntry(this.subnetDn(cidr), {
      objectClass: ['top', 'subnet'], cn: [cidr], siteObject: [formatDN(site.dn)], description: description ? [description] : [],
    });
    return res.ok ? { ok: true, message: '' } : { ok: false, message: `Subnet "${cidr}" already exists.` };
  }

  listSubnets(): SubnetInfo[] {
    this.ensureContainers();
    const container = this.tree.getByDn(this.subnetsDn);
    if (!container) return [];
    return [...container.children.values()].map((e) => ({
      cidr: firstOf(e.attributes.get('cn')),
      dn: formatDN(e.dn),
      site: leafCn(firstOf(e.attributes.get('siteobject'))) ?? '',
      description: firstOf(e.attributes.get('description')),
    }));
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

  // ─── Site links (bookkeeping only — no scheduling/cost enforcement, PRD-Repadmin.md §0.2) ──

  /** Idempotent: creates `DEFAULTIPSITELINK` (real AD default: Cost 100, every 180 minutes, IP transport) the first time any site exists, and keeps its `sitesIncluded` list current with every site that's since been created. */
  ensureDefaultSiteLink(): void {
    this.ensureContainers();
    const dn = this.siteLinkDn(DEFAULT_SITE_LINK_NAME);
    const sitesIncluded = this.listSites().map(s => s.name);
    const existing = this.tree.getByDn(dn);
    if (!existing) {
      // siteList stores plain site names (unlike subnet's siteObject DN back-reference) — simpler and sufficient since a site link isn't itself a replication target to resolve.
      this.tree.addEntry(dn, {
        objectClass: ['top', 'siteLink'], cn: [DEFAULT_SITE_LINK_NAME],
        cost: ['100'], replInterval: ['180'], transportType: ['IP'],
        siteList: sitesIncluded,
        description: [],
      });
      return;
    }
    this.tree.modifyEntry(dn, [{ op: 'replace', type: 'siteList', values: sitesIncluded }]);
  }

  /** `New-ADReplicationSiteLink -Name <name> -SitesIncluded <sites> [-Cost <n>] [-ReplicationFrequencyInMinutes <n>] [-InterSiteTransportProtocol IP|SMTP] [-Description <text>]`. */
  newSiteLink(
    name: string, sitesIncluded: string[],
    opts: { cost?: number; replicationFrequencyInMinutes?: number; transport?: SiteLinkTransport; description?: string } = {},
  ): SiteOpResult {
    this.ensureContainers();
    const dn = this.siteLinkDn(name);
    if (this.tree.getByDn(dn)) return { ok: false, message: `A site link named "${name}" already exists.` };
    const knownSites = new Set(this.listSites().map(s => s.name.toLowerCase()));
    for (const s of sitesIncluded) {
      if (!knownSites.has(s.toLowerCase())) return { ok: false, message: `Cannot find a site named "${s}".` };
    }
    const res = this.tree.addEntry(dn, {
      objectClass: ['top', 'siteLink'], cn: [name],
      cost: [String(opts.cost ?? 100)],
      replInterval: [String(opts.replicationFrequencyInMinutes ?? 180)],
      transportType: [opts.transport ?? 'IP'],
      siteList: sitesIncluded,
      description: opts.description ? [opts.description] : [],
    });
    return res.ok ? { ok: true, message: '' } : { ok: false, message: `A site link named "${name}" already exists.` };
  }

  private toSiteLinkInfo(e: DirectoryEntry): SiteLinkInfo {
    return {
      name: firstOf(e.attributes.get('cn')),
      dn: formatDN(e.dn),
      sitesIncluded: e.attributes.get('sitelist') ?? [],
      cost: Number(firstOf(e.attributes.get('cost')) || '100'),
      replicationFrequencyInMinutes: Number(firstOf(e.attributes.get('replinterval')) || '180'),
      interSiteTransportProtocol: (firstOf(e.attributes.get('transporttype')) as SiteLinkTransport) || 'IP',
      description: firstOf(e.attributes.get('description')),
    };
  }

  listSiteLinks(): SiteLinkInfo[] {
    this.ensureContainers();
    const container = this.tree.getByDn(this.linksDn);
    if (!container) return [];
    return [...container.children.values()].filter(e => hasObjectClass(e, 'siteLink')).map(e => this.toSiteLinkInfo(e));
  }

  getSiteLink(name: string): SiteLinkInfo | null {
    const entry = this.tree.getByDn(this.siteLinkDn(name));
    return entry ? this.toSiteLinkInfo(entry) : null;
  }

  /** `Set-ADReplicationSiteLink -Identity <name> [-Cost <n>] [-ReplicationFrequencyInMinutes <n>] [-SitesIncluded <sites>] [-Description <text>]`. `-ReplicationSchedule` is accepted by the cmdlet layer but has nothing here to store against — no schedule-window enforcement is modeled (PRD-Repadmin.md §0.2, same boundary as `/kcc`). */
  setSiteLink(
    name: string, patch: { cost?: number; replicationFrequencyInMinutes?: number; sitesIncluded?: string[]; description?: string },
  ): SiteOpResult {
    const dn = this.siteLinkDn(name);
    if (!this.tree.getByDn(dn)) return { ok: false, message: `Cannot find a site link named "${name}".` };
    if (patch.cost !== undefined) this.tree.modifyEntry(dn, [{ op: 'replace', type: 'cost', values: [String(patch.cost)] }]);
    if (patch.replicationFrequencyInMinutes !== undefined) this.tree.modifyEntry(dn, [{ op: 'replace', type: 'replInterval', values: [String(patch.replicationFrequencyInMinutes)] }]);
    if (patch.sitesIncluded !== undefined) this.tree.modifyEntry(dn, [{ op: 'replace', type: 'siteList', values: patch.sitesIncluded }]);
    if (patch.description !== undefined) this.tree.modifyEntry(dn, [{ op: 'replace', type: 'description', values: [patch.description] }]);
    return { ok: true, message: '' };
  }

  /** Whether a site by this name exists — used by `DirectoryStore.assignServerToSite` (Move-ADDirectoryServer) to validate its target before stamping the DC's own computer object; DC↔site assignment itself lives there, not here (see that method's header comment for why). */
  siteExists(name: string): boolean {
    this.ensureContainers();
    return this.tree.getByDn(this.siteDn(name)) !== null;
  }
}
