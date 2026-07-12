/**
 * Contact objects (`New-ADObject -Type contact`, MS-ADTS) — an external
 * person with no logon capability at all: no sAMAccountName, no
 * userAccountControl, no password. Completely absent from this
 * simulator before.
 */
import { describe, it, expect } from 'vitest';
import { DirectoryStore } from '@/network/devices/windows/server/ad/DirectoryStore';

function store(): DirectoryStore { return new DirectoryStore('lab.local', 'LAB', 'P@ssw0rd'); }

describe('DirectoryStore — contacts', () => {
  it('creates a contact with the given attributes', () => {
    const s = store();
    const res = s.newContact('Jane Vendor', { displayName: 'Jane Vendor', mail: 'jane@vendor.example', telephoneNumber: '555-0100' });
    expect(res.ok).toBe(true);

    const contact = s.getContact('Jane Vendor')!;
    expect(contact.displayName).toBe('Jane Vendor');
    expect(contact.mail).toBe('jane@vendor.example');
    expect(contact.telephoneNumber).toBe('555-0100');
    expect(contact.objectSid).toMatch(/^S-1-5-21-/);
    expect(contact.dn).toContain('CN=Jane Vendor');
  });

  it('creates a contact with no optional attributes', () => {
    const s = store();
    const res = s.newContact('John Doe');
    expect(res.ok).toBe(true);
    const contact = s.getContact('John Doe')!;
    expect(contact.displayName).toBe('');
    expect(contact.mail).toBe('');
  });

  it('places a contact in a specific OU', () => {
    const s = store();
    s.newOrgUnit('Vendors');
    const res = s.newContact('Jane Vendor', { ou: 'Vendors' });
    expect(res.ok).toBe(true);
    expect(s.getContact('Jane Vendor')!.ou).toBe('Vendors');
  });

  it('refuses a duplicate contact', () => {
    const s = store();
    s.newContact('Jane Vendor');
    const res = s.newContact('Jane Vendor');
    expect(res.ok).toBe(false);
  });

  it('lists all contacts', () => {
    const s = store();
    s.newContact('Jane Vendor');
    s.newContact('John Doe');
    const cns = s.listContacts().map(c => c.cn).sort();
    expect(cns).toEqual(['Jane Vendor', 'John Doe']);
  });

  it('returns null for an unknown contact', () => {
    const s = store();
    expect(s.getContact('ghost')).toBeNull();
  });

  it('is never returned by listUsers/getUser (no logon capability, not a user object)', () => {
    const s = store();
    s.newContact('Jane Vendor');
    expect(s.getUser('Jane Vendor')).toBeNull();
    expect(s.listUsers().map(u => u.sam)).not.toContain('Jane Vendor');
  });
});
