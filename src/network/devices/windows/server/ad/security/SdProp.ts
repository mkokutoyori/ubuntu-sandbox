/**
 * SdPropEngine — AdminSDHolder's periodic ACL re-stamping, simplified
 * to this simulator's `adminCount` bookkeeping since no real ACL/
 * security-descriptor model exists yet: every (possibly nested) member
 * of a protected group gets `adminCount=1` — real AD's own well-known
 * quirk of never automatically clearing it again, even once the member
 * is later removed from the group. Real AD runs this every 60 minutes
 * on the PDC Emulator; this simulator triggers it manually (matching
 * the existing convention for other periodic AD processes — see
 * `replication/ReplicationSession.ts`'s own header comment).
 */
import { DirectoryTree, type DirectoryEntry } from '../ldap/DirectoryTree';
import { parseDN, formatDN } from '../ldap/LdapDN';

/** Groups real AD's own AdminSDHolder template protects — the subset this simulator actually seeds by default (Enterprise Admins/Schema Admins are forest-level and not currently seeded). */
export const PROTECTED_GROUPS: readonly string[] = [
  'Domain Admins', 'Administrators', 'Account Operators', 'Backup Operators', 'Server Operators', 'Print Operators',
];

function firstOf(values: string[] | undefined): string { return values?.[0] ?? ''; }

export class SdPropEngine {
  constructor(private readonly tree: DirectoryTree) {}

  private findGroupBySam(sam: string): DirectoryEntry | null {
    const [entry] = this.tree.search(this.tree.getRootDn(), 'sub', { kind: 'equalityMatch', attr: 'sAMAccountName', value: sam })
      .filter(e => (e.attributes.get('objectclass') ?? []).some(v => v.toLowerCase() === 'group'));
    return entry ?? null;
  }

  /** Every (possibly nested) member of `groupEntry`, recursing into member groups, cycle-safe. */
  private collectMembers(groupEntry: DirectoryEntry, seen: Set<string>): DirectoryEntry[] {
    const key = formatDN(groupEntry.dn).toLowerCase();
    if (seen.has(key)) return [];
    seen.add(key);
    const out: DirectoryEntry[] = [];
    for (const memberDnStr of groupEntry.attributes.get('member') ?? []) {
      let entry: DirectoryEntry | null;
      try { entry = this.tree.getByDn(parseDN(memberDnStr)); } catch { entry = null; }
      if (!entry) continue;
      out.push(entry);
      const isGroup = (entry.attributes.get('objectclass') ?? []).some(v => v.toLowerCase() === 'group');
      if (isGroup) out.push(...this.collectMembers(entry, seen));
    }
    return out;
  }

  /** Runs one SDProp pass — returns the sAMAccountName of every member (direct or nested) marked `adminCount=1` this pass. Idempotent: already-marked members are re-included but not re-written. */
  run(): string[] {
    const marked = new Set<string>();
    for (const groupSam of PROTECTED_GROUPS) {
      const group = this.findGroupBySam(groupSam);
      if (!group) continue;
      for (const member of this.collectMembers(group, new Set())) {
        const sam = firstOf(member.attributes.get('samaccountname'));
        if (!sam || marked.has(sam)) continue;
        marked.add(sam);
        if (firstOf(member.attributes.get('admincount')) !== '1') {
          this.tree.modifyEntry(member.dn, [{ op: 'replace', type: 'adminCount', values: ['1'] }]);
        }
      }
    }
    return [...marked];
  }
}
