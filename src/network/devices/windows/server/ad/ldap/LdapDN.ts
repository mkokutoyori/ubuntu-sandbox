/**
 * LdapDN — real Distinguished Name parsing/formatting/comparison,
 * RFC 4514. Handles multi-valued RDNs (`CN=x+OU=y`), backslash escapes
 * (`\,` `\+` `\"` `\\` `\<` `\>` `\;` and `\XX` hex pairs), and quoted
 * values. AD attribute matching is case-insensitive, so comparisons
 * fold case on both the attribute type and value.
 */

import { parseDn as parseLdapDn } from '@/network/ldap/openldap/ldapDn';

export interface AttributeTypeAndValue {
  readonly type: string;
  readonly value: string;
}

/** One RDN — usually one AVA, but `+`-joined multi-valued RDNs are real LDAP. */
export type Rdn = readonly AttributeTypeAndValue[];

export type DistinguishedName = readonly Rdn[];

const SPECIAL_CHARS = new Set([',', '+', '"', '\\', '<', '>', ';']);

/** Escape a value per RFC 4514 §2.4 for use inside a formatted DN. */
export function escapeDNValue(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    const isLeading = i === 0;
    const isTrailing = i === value.length - 1;
    if (SPECIAL_CHARS.has(ch)) { out += '\\' + ch; continue; }
    if (ch === ' ' && (isLeading || isTrailing)) { out += '\\ '; continue; }
    if (ch === '#' && isLeading) { out += '\\#'; continue; }
    out += ch;
  }
  return out;
}

/** Parse a formatted DN string ("CN=bob,CN=Users,DC=lab,DC=local") into structured RDNs. */
export function parseDN(dn: string): DistinguishedName {
  const parsed = parseLdapDn(dn.trim());
  if (parsed === null) throw new Error(`LdapDN: malformed DN "${dn}"`);
  const decoder = new TextDecoder();
  return parsed.map((rdn) => rdn.map((ava) => ({ type: ava.attribute, value: decoder.decode(ava.value) })));
}

export function formatDN(dn: DistinguishedName): string {
  return dn.map(rdn => rdn.map(ava => `${ava.type}=${escapeDNValue(ava.value)}`).join('+')).join(',');
}

function rdnEquals(a: Rdn, b: Rdn): boolean {
  if (a.length !== b.length) return false;
  const norm = (rdn: Rdn) => [...rdn].map(x => `${x.type.toLowerCase()}=${x.value.toLowerCase()}`).sort();
  const na = norm(a), nb = norm(b);
  return na.every((v, i) => v === nb[i]);
}

/** Case-insensitive DN equality (AD's default attribute matching). */
export function dnEquals(a: DistinguishedName, b: DistinguishedName): boolean {
  if (a.length !== b.length) return false;
  return a.every((rdn, i) => rdnEquals(rdn, b[i]));
}

/** True when `child` is `parent` with exactly one more (leaf-most) RDN prepended. */
export function isImmediateChildOf(child: DistinguishedName, parent: DistinguishedName): boolean {
  if (child.length !== parent.length + 1) return false;
  return dnEquals(child.slice(1), parent);
}

/** True when `descendant` is `ancestor` with one or more RDNs prepended (whole-subtree scope). */
export function isDescendantOf(descendant: DistinguishedName, ancestor: DistinguishedName): boolean {
  if (descendant.length <= ancestor.length) return false;
  return dnEquals(descendant.slice(descendant.length - ancestor.length), ancestor);
}

export function parentOf(dn: DistinguishedName): DistinguishedName | null {
  return dn.length <= 1 ? (dn.length === 1 ? [] : null) : dn.slice(1);
}

/** The leaf (leftmost) RDN's first attribute value — e.g. "bob" from "CN=bob,...". */
export function leafValue(dn: DistinguishedName): string | null {
  return dn[0]?.[0]?.value ?? null;
}
