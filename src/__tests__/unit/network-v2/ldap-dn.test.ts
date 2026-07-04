/**
 * Real DN parsing/formatting/comparison tests (RFC 4514).
 */
import { describe, it, expect } from 'vitest';
import {
  parseDN, formatDN, dnEquals, isImmediateChildOf, isDescendantOf, parentOf, leafValue,
} from '@/network/devices/windows/server/ad/ldap/LdapDN';

describe('parseDN / formatDN', () => {
  it('parses a simple multi-RDN DN', () => {
    const dn = parseDN('CN=bob,CN=Users,DC=lab,DC=local');
    expect(dn).toHaveLength(4);
    expect(dn[0]).toEqual([{ type: 'CN', value: 'bob' }]);
    expect(dn[3]).toEqual([{ type: 'DC', value: 'local' }]);
    expect(formatDN(dn)).toBe('CN=bob,CN=Users,DC=lab,DC=local');
  });

  it('parses multi-valued RDNs (CN=x+OU=y)', () => {
    const dn = parseDN('CN=bob+OU=eng,DC=lab,DC=local');
    expect(dn[0]).toEqual([{ type: 'CN', value: 'bob' }, { type: 'OU', value: 'eng' }]);
  });

  it('handles a value with an internal comma via backslash-escape', () => {
    const dn = parseDN('CN=Smith\\, Bob,CN=Users,DC=lab,DC=local');
    expect(dn[0][0].value).toBe('Smith, Bob');
    expect(formatDN(dn)).toBe('CN=Smith\\, Bob,CN=Users,DC=lab,DC=local');
  });

  it('handles a quoted value', () => {
    const dn = parseDN('CN="Smith, Bob",DC=lab,DC=local');
    expect(dn[0][0].value).toBe('Smith, Bob');
  });

  it('handles a hex-escaped value', () => {
    const dn = parseDN('CN=\\41\\42,DC=lab,DC=local'); // \41\42 = "AB"
    expect(dn[0][0].value).toBe('AB');
  });

  it('trims unescaped leading/trailing spaces around values', () => {
    const dn = parseDN('CN= bob , CN=Users , DC=lab');
    expect(dn[0][0].value).toBe('bob');
    expect(dn[1][0].value).toBe('Users');
  });

  it('round-trips empty DN (root)', () => {
    expect(parseDN('')).toEqual([]);
    expect(formatDN([])).toBe('');
  });

  it('throws on malformed input (missing =)', () => {
    expect(() => parseDN('CNbob,DC=lab')).toThrow();
  });
});

describe('dnEquals', () => {
  it('is case-insensitive on both type and value', () => {
    expect(dnEquals(parseDN('CN=Bob,DC=Lab,DC=Local'), parseDN('cn=bob,dc=lab,dc=local'))).toBe(true);
  });
  it('is false for different DNs', () => {
    expect(dnEquals(parseDN('CN=Bob,DC=lab'), parseDN('CN=Alice,DC=lab'))).toBe(false);
  });
  it('multi-valued RDN order does not matter', () => {
    expect(dnEquals(parseDN('CN=bob+OU=eng,DC=lab'), parseDN('OU=eng+CN=bob,DC=lab'))).toBe(true);
  });
});

describe('isImmediateChildOf / isDescendantOf / parentOf', () => {
  const dc = parseDN('DC=lab,DC=local');
  const users = parseDN('CN=Users,DC=lab,DC=local');
  const bob = parseDN('CN=bob,CN=Users,DC=lab,DC=local');

  it('detects an immediate child', () => {
    expect(isImmediateChildOf(users, dc)).toBe(true);
    expect(isImmediateChildOf(bob, dc)).toBe(false); // grandchild, not immediate
  });

  it('detects a deep descendant (subtree scope)', () => {
    expect(isDescendantOf(bob, dc)).toBe(true);
    expect(isDescendantOf(users, dc)).toBe(true);
    expect(isDescendantOf(dc, dc)).toBe(false); // not a proper descendant of itself
  });

  it('computes the parent DN', () => {
    expect(dnEquals(parentOf(bob)!, users)).toBe(true);
    expect(dnEquals(parentOf(users)!, dc)).toBe(true);
    expect(parentOf([])).toBeNull();
  });
});

describe('leafValue', () => {
  it('extracts the RDN leaf value', () => {
    expect(leafValue(parseDN('CN=bob,CN=Users,DC=lab'))).toBe('bob');
    expect(leafValue([])).toBeNull();
  });
});
