import { DirectoryTree, type DirectoryEntry } from '../ldap/DirectoryTree';
import { parseDN, formatDN, type DistinguishedName } from '../ldap/LdapDN';
import type { AdServiceAccount } from '../AdTypes';

export interface MsaOpResult { ok: boolean; message: string }

function firstOf(values: string[] | undefined): string { return values?.[0] ?? ''; }

function hasObjectClass(entry: DirectoryEntry, oc: string): boolean {
  return (entry.attributes.get('objectclass') ?? []).some(v => v.toLowerCase() === oc.toLowerCase());
}

function compact(attrs: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(attrs).filter(([, v]) => v.length > 0));
}

/** A 120-character random managed password — real AD generates 240 random bytes; simplified here to a random printable string of comparable strength, never chosen by an admin. */
function randomManagedPassword(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
  let out = '';
  for (let i = 0; i < 120; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

/**
 * (Group) Managed Service Accounts (MS-ADTS §3.1.1.8) — accounts whose
 * password is generated and rotated by the DC itself rather than an
 * admin. `principalsAllowedToRetrieveManagedPassword` gates
 * `retrieveManagedPassword`, the one path a remote computer legitimately
 * reads the current password over the wire (a real LDAP search for the
 * constructed `msDS-ManagedPassword` attribute, gated in
 * `LdapServerHandler` — this store only implements the authorization
 * rule itself). Direct membership only (no nested-group expansion), the
 * same simplification already established for `groupsForUser`.
 */
export class ManagedServiceAccountStore {
  constructor(private readonly tree: DirectoryTree) {}

  newServiceAccount(sam: string, containerDn: DistinguishedName, opts: { isGroupManaged: boolean; principals: string[]; objectSid?: string }): MsaOpResult {
    const objectClass = opts.isGroupManaged
      ? ['top', 'person', 'organizationalPerson', 'user', 'computer', 'msDS-GroupManagedServiceAccount']
      : ['top', 'person', 'organizationalPerson', 'user', 'computer', 'msDS-ManagedServiceAccount'];
    const res = this.tree.addEntry([...parseDN(`CN=${sam}`), ...containerDn], compact({
      objectClass,
      cn: [sam],
      sAMAccountName: [`${sam}$`],
      'msDS-ManagedPassword': [randomManagedPassword()],
      'msDS-PasswordLastSet': [String(Math.floor(Date.now() / 1000))],
      'msDS-GroupMSAMembership': opts.principals,
      objectSid: opts.objectSid ? [opts.objectSid] : [],
    }));
    return res.ok ? { ok: true, message: '' } : { ok: false, message: 'An object with that name already exists.' };
  }

  private findBySam(sam: string): DirectoryEntry | null {
    const [entry] = this.tree.search(this.tree.getRootDn(), 'sub', { kind: 'equalityMatch', attr: 'sAMAccountName', value: `${sam}$` })
      .filter(e => hasObjectClass(e, 'msDS-ManagedServiceAccount') || hasObjectClass(e, 'msDS-GroupManagedServiceAccount'));
    return entry ?? null;
  }

  /** Any principal (user/computer) by its plain sAMAccountName, `$`-suffixed or not — for resolving `retrieveManagedPassword`'s requester. */
  private findPrincipalBySam(sam: string): DirectoryEntry | null {
    const [entry] = this.tree.search(this.tree.getRootDn(), 'sub', { kind: 'equalityMatch', attr: 'sAMAccountName', value: sam });
    return entry ?? null;
  }

  getServiceAccount(sam: string): AdServiceAccount | null {
    const entry = this.findBySam(sam);
    return entry ? this.project(entry) : null;
  }

  listServiceAccounts(): AdServiceAccount[] {
    return this.tree.allDescendants(this.tree.getRootDn())
      .filter(e => hasObjectClass(e, 'msDS-ManagedServiceAccount') || hasObjectClass(e, 'msDS-GroupManagedServiceAccount'))
      .map(e => this.project(e));
  }

  private project(entry: DirectoryEntry): AdServiceAccount {
    const containerDn = entry.dn.slice(1);
    return {
      sam: firstOf(entry.attributes.get('samaccountname')),
      dn: formatDN(entry.dn),
      ou: firstOf(entry.attributes.get('ou')) || (containerDn[0]?.[0]?.value ?? ''),
      isGroupManaged: hasObjectClass(entry, 'msDS-GroupManagedServiceAccount'),
      principalsAllowedToRetrieveManagedPassword: entry.attributes.get('msds-groupmsamembership') ?? [],
      managedPassword: firstOf(entry.attributes.get('msds-managedpassword')),
      passwordLastSet: Number(firstOf(entry.attributes.get('msds-passwordlastset'))) || 0,
      objectSid: firstOf(entry.attributes.get('objectsid')),
    };
  }

  /** Real AD rotates automatically every `msDS-ManagedPasswordInterval` (default 30 days) — triggered manually here, same convention as replication/SDProp/UGMC. */
  resetManagedPassword(sam: string): MsaOpResult {
    const entry = this.findBySam(sam);
    if (!entry) return { ok: false, message: `Cannot find an object with identity: '${sam}'.` };
    this.tree.modifyEntry(entry.dn, [
      { op: 'replace', type: 'msDS-ManagedPassword', values: [randomManagedPassword()] },
      { op: 'replace', type: 'msDS-PasswordLastSet', values: [String(Math.floor(Date.now() / 1000))] },
    ]);
    return { ok: true, message: '' };
  }

  setPrincipalsAllowedToRetrieveManagedPassword(sam: string, principals: string[]): MsaOpResult {
    const entry = this.findBySam(sam);
    if (!entry) return { ok: false, message: `Cannot find an object with identity: '${sam}'.` };
    this.tree.modifyEntry(entry.dn, [{ op: 'replace', type: 'msDS-GroupMSAMembership', values: principals }]);
    return { ok: true, message: '' };
  }

  /** `null` unless `requestingPrincipalSam` is directly listed, or a direct member of a group that is listed, in this account's `principalsAllowedToRetrieveManagedPassword`. Never authorizes an anonymous (`null`) requester. */
  retrieveManagedPassword(sam: string, requestingPrincipalSam: string | null): string | null {
    if (!requestingPrincipalSam) return null;
    const entry = this.findBySam(sam);
    if (!entry) return null;
    const allowed = new Set((entry.attributes.get('msds-groupmsamembership') ?? []).map(s => s.toLowerCase()));
    if (allowed.has(requestingPrincipalSam.toLowerCase())) return firstOf(entry.attributes.get('msds-managedpassword'));
    const requester = this.findPrincipalBySam(requestingPrincipalSam);
    if (requester) {
      const groupSams = (requester.attributes.get('memberof') ?? [])
        .map((dnStr) => {
          try { return this.tree.getByDn(parseDN(dnStr)); } catch { return null; }
        })
        .filter((e): e is DirectoryEntry => e !== null)
        .map(e => firstOf(e.attributes.get('samaccountname')).toLowerCase());
      if (groupSams.some(g => allowed.has(g))) return firstOf(entry.attributes.get('msds-managedpassword'));
    }
    return null;
  }
}
