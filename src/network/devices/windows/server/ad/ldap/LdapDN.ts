/**
 * LdapDN — real Distinguished Name parsing/formatting/comparison,
 * RFC 4514. Handles multi-valued RDNs (`CN=x+OU=y`), backslash escapes
 * (`\,` `\+` `\"` `\\` `\<` `\>` `\;` and `\XX` hex pairs), and quoted
 * values. AD attribute matching is case-insensitive, so comparisons
 * fold case on both the attribute type and value.
 */

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

/** Parse one escaped/quoted attribute value, returning the unescaped value and the position after it. */
function parseValue(s: string, start: number): { value: string; next: number } {
  let i = start;
  let out = '';
  if (s[i] === '"') {
    i++;
    while (i < s.length && s[i] !== '"') {
      if (s[i] === '\\' && i + 1 < s.length) { out += s[i + 1]; i += 2; }
      else { out += s[i]; i++; }
    }
    if (s[i] !== '"') throw new Error(`LdapDN: unterminated quoted value in "${s}"`);
    i++; // closing quote
    return { value: out, next: i };
  }
  while (i < s.length && s[i] !== ',' && s[i] !== '+') {
    if (s[i] === '\\') {
      const hex = s.slice(i + 1, i + 3);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) { out += String.fromCharCode(parseInt(hex, 16)); i += 3; continue; }
      if (i + 1 < s.length) { out += s[i + 1]; i += 2; continue; }
      throw new Error(`LdapDN: dangling escape in "${s}"`);
    }
    out += s[i];
    i++;
  }
  return { value: out.trim(), next: i };
}

/** Find the `=` that ends an attribute-type token, stopping at an unescaped `,`/`+` (malformed) or end of string. */
function findUnescapedEquals(s: string, start: number): number {
  for (let i = start; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === '=') return i;
    if (s[i] === ',' || s[i] === '+') return -1;
  }
  return -1;
}

/** Parse a formatted DN string ("CN=bob,CN=Users,DC=lab,DC=local") into structured RDNs. */
export function parseDN(dn: string): DistinguishedName {
  const trimmed = dn.trim();
  if (trimmed === '') return [];
  const rdns: Rdn[] = [];
  let i = 0;
  while (i < trimmed.length) {
    const avas: AttributeTypeAndValue[] = [];
    for (;;) {
      const eq = findUnescapedEquals(trimmed, i);
      if (eq === -1) throw new Error(`LdapDN: malformed RDN (missing '=') in "${dn}"`);
      const type = trimmed.slice(i, eq).trim();
      if (!type) throw new Error(`LdapDN: empty attribute type in "${dn}"`);
      const { value, next } = parseValue(trimmed, eq + 1);
      avas.push({ type, value });
      i = next;
      if (trimmed[i] === '+') { i++; continue; }
      break;
    }
    rdns.push(avas);
    if (trimmed[i] === ',') { i++; continue; }
    if (i < trimmed.length) throw new Error(`LdapDN: unexpected character at position ${i} in "${dn}"`);
    break;
  }
  return rdns;
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
