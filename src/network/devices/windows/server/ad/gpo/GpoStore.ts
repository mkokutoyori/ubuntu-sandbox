/**
 * GpoStore — Group Policy Object CRUD/link/RSoP (PRD-Windows-Server.md
 * §5 P10), extracted from `DirectoryStore` onto the same
 * "sub-registry composed by reference" pattern as `SiteRegistry`/
 * `TrustRegistry`/`SchemaPartition`: GPCs are ordinary entries under
 * `CN=Policies,CN=System,<domain root>`, so this stores nothing beyond
 * the shared `DirectoryTree`.
 */
import { DirectoryTree, type DirectoryEntry } from '../ldap/DirectoryTree';
import { parseDN, formatDN, parentOf, type DistinguishedName } from '../ldap/LdapDN';
import type { Gpo, GpoSettings } from '../AdTypes';

export interface DirOpResult { ok: boolean; message: string }

function firstOf(values: string[] | undefined): string { return values?.[0] ?? ''; }
function hasObjectClass(entry: DirectoryEntry, oc: string): boolean {
  return (entry.attributes.get('objectclass') ?? []).some(v => v.toLowerCase() === oc.toLowerCase());
}

export class GpoStore {
  private readonly policiesDn: DistinguishedName;

  constructor(private readonly tree: DirectoryTree) {
    this.policiesDn = [...parseDN('CN=Policies'), ...parseDN('CN=System'), ...tree.getRootDn()];
  }

  private cnDn(cn: string, containerDn: DistinguishedName): DistinguishedName { return [...parseDN(`CN=${cn}`), ...containerDn]; }

  newGpo(name: string): DirOpResult {
    const res = this.tree.addEntry(this.cnDn(name, this.policiesDn), {
      objectClass: ['top', 'container', 'groupPolicyContainer'],
      cn: [name], displayName: [name],
    });
    return res.ok ? { ok: true, message: '' } : { ok: false, message: `A GPO named "${name}" already exists.` };
  }

  private findGpoEntry(name: string): DirectoryEntry | null {
    return this.tree.getByDn(this.cnDn(name, this.policiesDn));
  }

  getGpo(name: string): Gpo | null {
    const entry = this.findGpoEntry(name);
    return entry ? this.projectGpo(entry) : null;
  }

  listGpos(): Gpo[] {
    return this.tree.allDescendants(this.policiesDn)
      .filter(e => hasObjectClass(e, 'groupPolicyContainer'))
      .map(e => this.projectGpo(e));
  }

  private projectGpo(entry: DirectoryEntry): Gpo {
    const accountPolicyJson = firstOf(entry.attributes.get('gpoaccountpolicy'));
    const auditPolicyJson = firstOf(entry.attributes.get('gpoauditpolicy'));
    const userRightsJson = firstOf(entry.attributes.get('gpouserrightsassignment'));
    const logonBannerJson = firstOf(entry.attributes.get('gpologonbanner'));
    const startupScript = firstOf(entry.attributes.get('gpostartupscript'));
    const gpoDn = formatDN(entry.dn);
    return {
      id: firstOf(entry.attributes.get('cn')),
      name: firstOf(entry.attributes.get('displayname')),
      links: this.tree.allDescendants(this.tree.getRootDn())
        .filter(e => (e.attributes.get('gplink') ?? []).some(v => v.toLowerCase() === gpoDn.toLowerCase()))
        .map(e => formatDN(e.dn)),
      settings: {
        accountPolicy: accountPolicyJson ? JSON.parse(accountPolicyJson) : undefined,
        auditPolicy: auditPolicyJson ? JSON.parse(auditPolicyJson) : undefined,
        userRightsAssignment: userRightsJson ? JSON.parse(userRightsJson) : undefined,
        logonBanner: logonBannerJson ? JSON.parse(logonBannerJson) : undefined,
        startupScript: startupScript || undefined,
      },
      securityFiltering: entry.attributes.get('gposecurityfiltering') ?? [],
    };
  }

  setGpoSettings(name: string, settings: GpoSettings): DirOpResult {
    const entry = this.findGpoEntry(name);
    if (!entry) return { ok: false, message: `Cannot find a GPO with name "${name}".` };
    const changes: { op: 'replace'; type: string; values: string[] }[] = [];
    if (settings.accountPolicy !== undefined) changes.push({ op: 'replace', type: 'gpoAccountPolicy', values: [JSON.stringify(settings.accountPolicy)] });
    if (settings.auditPolicy !== undefined) changes.push({ op: 'replace', type: 'gpoAuditPolicy', values: [JSON.stringify(settings.auditPolicy)] });
    if (settings.userRightsAssignment !== undefined) changes.push({ op: 'replace', type: 'gpoUserRightsAssignment', values: [JSON.stringify(settings.userRightsAssignment)] });
    if (settings.logonBanner !== undefined) changes.push({ op: 'replace', type: 'gpoLogonBanner', values: [JSON.stringify(settings.logonBanner)] });
    if (settings.startupScript !== undefined) changes.push({ op: 'replace', type: 'gpoStartupScript', values: [settings.startupScript] });
    this.tree.modifyEntry(entry.dn, changes);
    return { ok: true, message: '' };
  }

  /** `Set-GPPermission`-lite: restricts which security principals (user/group/computer SAMs) this GPO applies to. Empty list reverts to the real-AD default of applying to Authenticated Users. */
  setGpoSecurityFiltering(name: string, principals: string[]): DirOpResult {
    const entry = this.findGpoEntry(name);
    if (!entry) return { ok: false, message: `Cannot find a GPO with name "${name}".` };
    this.tree.modifyEntry(entry.dn, [{ op: 'replace', type: 'gpoSecurityFiltering', values: principals }]);
    return { ok: true, message: '' };
  }

  newGPLink(gpoName: string, targetDn: string): DirOpResult {
    const gpo = this.findGpoEntry(gpoName);
    if (!gpo) return { ok: false, message: `Cannot find a GPO with name "${gpoName}".` };
    let target: DistinguishedName;
    try { target = parseDN(targetDn); } catch { return { ok: false, message: `"${targetDn}" is not a valid distinguished name.` }; }
    const targetEntry = this.tree.getByDn(target);
    if (!targetEntry) return { ok: false, message: `Cannot find an object with distinguished name: '${targetDn}'.` };
    this.tree.modifyEntry(target, [{ op: 'add', type: 'gPLink', values: [formatDN(gpo.dn)] }]);
    return { ok: true, message: '' };
  }

  /**
   * RSoP for `subjectEntry` (a computer, or null for domain-only), real
   * precedence order: domain-linked GPOs first, then GPOs linked to each
   * OU from the top of the OU chain down to the immediate container
   * (more specific — later settings override earlier ones on conflicting
   * keys). Security-filtered-out GPOs (§5 P10 extension) are skipped.
   */
  resultantSetOfPolicy(subjectEntry: DirectoryEntry | null): { appliedGpoNames: string[]; settings: GpoSettings } {
    const domainLinked = this.linkedGposFor(this.tree.getRootDn());
    const ouChainLinked: Gpo[] = [];
    if (subjectEntry) {
      for (const ouDn of this.ouAncestorChain(subjectEntry.dn)) ouChainLinked.push(...this.linkedGposFor(ouDn));
    }
    const ordered = [...domainLinked, ...ouChainLinked].filter(gpo => this.appliesTo(gpo, subjectEntry));
    const merged: GpoSettings = {};
    for (const gpo of ordered) {
      if (gpo.settings.accountPolicy !== undefined) merged.accountPolicy = { ...merged.accountPolicy, ...gpo.settings.accountPolicy };
      if (gpo.settings.auditPolicy !== undefined) merged.auditPolicy = { ...merged.auditPolicy, ...gpo.settings.auditPolicy };
      if (gpo.settings.userRightsAssignment !== undefined) merged.userRightsAssignment = { ...merged.userRightsAssignment, ...gpo.settings.userRightsAssignment };
      if (gpo.settings.logonBanner !== undefined) merged.logonBanner = gpo.settings.logonBanner;
      if (gpo.settings.startupScript !== undefined) merged.startupScript = gpo.settings.startupScript;
    }
    return { appliedGpoNames: ordered.map(g => g.name), settings: merged };
  }

  private appliesTo(gpo: Gpo, subjectEntry: DirectoryEntry | null): boolean {
    if (gpo.securityFiltering.length === 0) return true;
    if (!subjectEntry) return false;
    const sam = firstOf(subjectEntry.attributes.get('samaccountname'));
    const filterLower = gpo.securityFiltering.map(p => p.toLowerCase());
    if (filterLower.includes(sam.toLowerCase())) return true;
    const memberOfDns = subjectEntry.attributes.get('memberof') ?? [];
    const groupSams = memberOfDns
      .map(dnStr => { try { return this.tree.getByDn(parseDN(dnStr)); } catch { return null; } })
      .filter((e): e is DirectoryEntry => e !== null)
      .map(e => firstOf(e.attributes.get('samaccountname')).toLowerCase());
    return groupSams.some(g => filterLower.includes(g));
  }

  /** Every OU containing `dn`, from the top-most (closest to the domain root) down to the immediate parent — excludes the domain root itself (handled separately as `domainLinked`). */
  private ouAncestorChain(dn: DistinguishedName): DistinguishedName[] {
    const rootDn = this.tree.getRootDn();
    const chain: DistinguishedName[] = [];
    let current = parentOf(dn);
    while (current && current.length > rootDn.length) {
      chain.push(current);
      current = parentOf(current);
    }
    return chain.reverse();
  }

  private linkedGposFor(dn: DistinguishedName): Gpo[] {
    const entry = this.tree.getByDn(dn);
    const links = entry?.attributes.get('gplink') ?? [];
    return links
      .map(gpoDn => { try { return this.tree.getByDn(parseDN(gpoDn)); } catch { return null; } })
      .filter((e): e is DirectoryEntry => e !== null)
      .map(e => this.projectGpo(e));
  }
}
