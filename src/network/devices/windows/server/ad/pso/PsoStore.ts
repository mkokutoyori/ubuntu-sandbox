/**
 * PsoStore — Password Settings Objects, fine-grained password policy
 * (real AD's `msDS-PasswordSettings`, stored under `CN=Password
 * Settings Container,CN=System,<domain root>`), on the same
 * "sub-registry composed by reference" pattern as `GpoStore`/
 * `SiteRegistry`/`TrustRegistry`. Reuses `GpoAccountPolicy`'s shape for
 * the actual password/lockout fields rather than a parallel type.
 */
import { DirectoryTree, type DirectoryEntry } from '../ldap/DirectoryTree';
import { parseDN, formatDN, type DistinguishedName } from '../ldap/LdapDN';
import type { GpoAccountPolicy, PasswordSettingsObject } from '../AdTypes';

export interface DirOpResult { ok: boolean; message: string }

function firstOf(values: string[] | undefined): string { return values?.[0] ?? ''; }
function hasObjectClass(entry: DirectoryEntry, oc: string): boolean {
  return (entry.attributes.get('objectclass') ?? []).some(v => v.toLowerCase() === oc.toLowerCase());
}

export class PsoStore {
  private readonly containerDn: DistinguishedName;

  constructor(private readonly tree: DirectoryTree) {
    this.containerDn = [...parseDN('CN=Password Settings Container'), ...parseDN('CN=System'), ...tree.getRootDn()];
  }

  private ensureContainer(): void {
    if (!this.tree.getByDn(this.containerDn)) {
      this.tree.addEntry(this.containerDn, { objectClass: ['top', 'container'], cn: ['Password Settings Container'] });
    }
  }

  private cnDn(cn: string): DistinguishedName { return [...parseDN(`CN=${cn}`), ...this.containerDn]; }

  newPso(name: string, precedence: number, settings: GpoAccountPolicy): DirOpResult {
    this.ensureContainer();
    const res = this.tree.addEntry(this.cnDn(name), {
      objectClass: ['top', 'msDS-PasswordSettings'],
      cn: [name],
      'msDS-PasswordSettingsPrecedence': [String(precedence)],
      'msDS-PasswordSettings': [JSON.stringify(settings)],
    });
    return res.ok ? { ok: true, message: '' } : { ok: false, message: `A PSO named "${name}" already exists.` };
  }

  private findPsoEntry(name: string): DirectoryEntry | null {
    return this.tree.getByDn(this.cnDn(name));
  }

  getPso(name: string): PasswordSettingsObject | null {
    const entry = this.findPsoEntry(name);
    return entry ? this.projectPso(entry) : null;
  }

  listPsos(): PasswordSettingsObject[] {
    return this.tree.allDescendants(this.containerDn)
      .filter(e => hasObjectClass(e, 'msDS-PasswordSettings'))
      .map(e => this.projectPso(e));
  }

  private projectPso(entry: DirectoryEntry): PasswordSettingsObject {
    const settingsJson = firstOf(entry.attributes.get('msds-passwordsettings'));
    return {
      name: firstOf(entry.attributes.get('cn')),
      dn: formatDN(entry.dn),
      precedence: Number(firstOf(entry.attributes.get('msds-passwordsettingsprecedence'))) || 0,
      settings: settingsJson ? JSON.parse(settingsJson) : {},
      appliesTo: entry.attributes.get('msds-psoappliesto') ?? [],
    };
  }

  setPsoAppliesTo(name: string, principals: string[]): DirOpResult {
    const entry = this.findPsoEntry(name);
    if (!entry) return { ok: false, message: `Cannot find a PSO with name "${name}".` };
    this.tree.modifyEntry(entry.dn, [{ op: 'replace', type: 'msDS-PSOAppliesTo', values: principals }]);
    return { ok: true, message: '' };
  }

  /** The winning PSO for `subjectEntry` (applying directly or via group membership) — lowest `precedence` wins, matching real AD's all-or-nothing (never merged across PSOs) resolution. `null` if none applies (caller falls back to the domain default account policy). */
  effectivePasswordPolicyFor(subjectEntry: DirectoryEntry): GpoAccountPolicy | null {
    const sam = firstOf(subjectEntry.attributes.get('samaccountname')).toLowerCase();
    const memberOfDns = subjectEntry.attributes.get('memberof') ?? [];
    const groupSams = memberOfDns
      .map(dnStr => { try { return this.tree.getByDn(parseDN(dnStr)); } catch { return null; } })
      .filter((e): e is DirectoryEntry => e !== null)
      .map(e => firstOf(e.attributes.get('samaccountname')).toLowerCase());

    const applicable = this.listPsos().filter(pso => {
      const targets = pso.appliesTo.map(p => p.toLowerCase());
      return targets.includes(sam) || groupSams.some(g => targets.includes(g));
    });
    if (applicable.length === 0) return null;
    applicable.sort((a, b) => a.precedence - b.precedence);
    return applicable[0].settings;
  }
}
