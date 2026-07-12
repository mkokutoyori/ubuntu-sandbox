import { DirectoryTree, type DirectoryEntry } from '../ldap/DirectoryTree';
import { formatDN, parseDN, type DistinguishedName } from '../ldap/LdapDN';
import type { AdContact } from '../AdTypes';

export interface ContactOpResult { ok: boolean; message: string }

function firstOf(values: string[] | undefined): string { return values?.[0] ?? ''; }

function hasObjectClass(entry: DirectoryEntry, oc: string): boolean {
  return (entry.attributes.get('objectclass') ?? []).some(v => v.toLowerCase() === oc.toLowerCase());
}

function compact(attrs: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(attrs).filter(([, v]) => v.length > 0));
}

function dnEqualsOu(dn: DistinguishedName, ou: DistinguishedName): boolean {
  return formatDN(dn).toLowerCase() === formatDN(ou).toLowerCase();
}

function leafOuName(dn: DistinguishedName): string {
  return dn[0]?.[0]?.value ?? '';
}

/** Contact objects (`New-ADObject -Type contact`, MS-ADTS) — an external person with no logon capability at all. */
export class ContactStore {
  constructor(private readonly tree: DirectoryTree, private readonly usersOuDn: DistinguishedName) {}

  newContact(
    cn: string, containerDn: DistinguishedName,
    opts: { displayName?: string; mail?: string; telephoneNumber?: string; objectSid?: string },
  ): ContactOpResult {
    const dn: DistinguishedName = [...parseDN(`CN=${cn}`), ...containerDn];
    const res = this.tree.addEntry(dn, compact({
      objectClass: ['top', 'person', 'organizationalPerson', 'contact'],
      cn: [cn],
      displayName: opts.displayName ? [opts.displayName] : [],
      mail: opts.mail ? [opts.mail] : [],
      telephoneNumber: opts.telephoneNumber ? [opts.telephoneNumber] : [],
      objectSid: opts.objectSid ? [opts.objectSid] : [],
    }));
    return res.ok ? { ok: true, message: '' } : { ok: false, message: 'An object with that name already exists.' };
  }

  private findContactEntry(cn: string): DirectoryEntry | null {
    const [entry] = this.tree.search(this.tree.getRootDn(), 'sub', { kind: 'equalityMatch', attr: 'cn', value: cn })
      .filter(e => hasObjectClass(e, 'contact'));
    return entry ?? null;
  }

  getContact(cn: string): AdContact | null {
    const entry = this.findContactEntry(cn);
    return entry ? this.projectContact(entry) : null;
  }

  listContacts(): AdContact[] {
    return this.tree.allDescendants(this.tree.getRootDn()).filter(e => hasObjectClass(e, 'contact')).map(e => this.projectContact(e));
  }

  private projectContact(entry: DirectoryEntry): AdContact {
    const containerDn = entry.dn.slice(1);
    return {
      cn: firstOf(entry.attributes.get('cn')),
      dn: formatDN(entry.dn),
      ou: dnEqualsOu(containerDn, this.usersOuDn) ? 'Users' : firstOf(entry.attributes.get('ou')) || leafOuName(containerDn),
      displayName: firstOf(entry.attributes.get('displayname')),
      mail: firstOf(entry.attributes.get('mail')),
      telephoneNumber: firstOf(entry.attributes.get('telephonenumber')),
      objectSid: firstOf(entry.attributes.get('objectsid')),
    };
  }
}
