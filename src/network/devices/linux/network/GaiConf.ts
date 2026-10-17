import { IPAddress, IPv6Address } from '../../../core/types';
import {
  DEFAULT_IPV4_SCOPES, GLIBC_LABELS, GLIBC_PRECEDENCES,
  type DestinationPolicy, type Ipv4Scope, type PrefixValue,
} from '../../../layers/internet/DestinationSelection';

export const GAI_CONF_PATH = '/etc/gai.conf';

export const GAI_CONF_FACTORY = `# Configuration for getaddrinfo(3).
#
# So far only configuration for the destination address sorting is needed.
# RFC 3484 governs the sorting.  But the RFC also says that system
# administrators should be able to overwrite the defaults.  This can be
# achieved here.
#
# All lines have an initial identifier specifying the option followed by
# up to two values.  Information specified in this file replaces the
# default information.  Complete absence of data of one kind causes the
# appropriate default information to be used.  The supported commands include:
#
# reload  <yes|no>
#    If set to yes, each getaddrinfo(3) call will check whether this file
#    changed and if necessary reload.  This option should not really be
#    used.  There are possible runtime problems.  The default is no.
#
# label   <mask>   <value>
#    Add another rule to the RFC 3484 label table.  See section 2.1 in
#    RFC 3484.  The default is:
#
#label ::1/128       0
#label ::/0          1
#label 2002::/16     2
#label ::/96         3
#label ::ffff:0:0/96 4
#label fec0::/10     5
#label fc00::/7      6
#label 2001:0::/32   7
#
#    This default differs from the tables given in RFC 3484 by handling
#    (now obsolete) site-local IPv6 addresses and Unique Local Addresses.
#    The reason for this difference is that these addresses are never
#    NATed while IPv4 site-local addresses most probably are.  Given
#    the precedence of IPv6 over IPv4 (see below) on machines having only
#    site-local IPv4 and IPv6 addresses a lookup for a global address would
#    see the IPv6 be preferred.  The result is a long delay because the
#    site-local IPv6 addresses cannot be used while the IPv4 address is
#    (at least for the foreseeable future) NATed.  We also treat Teredo
#    tunnels special.
#
# precedence  <mask>   <value>
#    Add another rule to the RFC 3484 precedence table.  See section 2.1
#    and 10.3 in RFC 3484.  The default is:
#
#precedence  ::1/128       50
#precedence  ::/0          40
#precedence  2002::/16     30
#precedence ::/96          20
#precedence ::ffff:0:0/96  10
#
#    For sites which prefer IPv4 connections change the last line to
#
#precedence ::ffff:0:0/96  100

#
# scopev4  <mask>  <value>
#    Add another rule to the RFC 6724 scope table for IPv4 addresses.
#    By default the scope IDs described in section 3.2 in RFC 6724 are
#    used.  Changing these defaults should hardly ever be necessary.
#    The defaults are equivalent to:
#
#scopev4 ::ffff:169.254.0.0/112  2
#scopev4 ::ffff:127.0.0.0/104    2
#scopev4 ::ffff:0.0.0.0/96       14
`;

const INT_MAX = 2147483647n;
const ULONG_MAX = (1n << 64n) - 1n;
const CATCH_ALL_LABEL = 1;
const CATCH_ALL_PRECEDENCE = 40;
const CATCH_ALL_SCOPE = 14;

interface GaiLine {
  readonly command: string;
  readonly first: string;
  readonly second: string;
}

function splitLine(raw: string): GaiLine | null {
  const hash = raw.indexOf('#');
  const line = hash < 0 ? raw : raw.slice(0, hash);
  const words = line.split(/[ \t\n\v\f\r]+/).filter((word) => word !== '');
  if (words.length === 0) return null;
  return { command: words[0], first: words[1] ?? '', second: words[2] ?? '' };
}

function strtoul(text: string): bigint | null {
  if (text === '') return 0n;
  const match = /^([+-]?)([0-9]+)$/.exec(text);
  if (match === null) return null;
  const magnitude = BigInt(match[2]);
  if (magnitude > ULONG_MAX) return null;
  if (match[1] === '-') return magnitude === 0n ? 0n : (ULONG_MAX + 1n - magnitude) % (ULONG_MAX + 1n);
  return magnitude;
}

function inetPton6(text: string): IPv6Address | null {
  return text.includes('%') ? null : IPv6Address.tryParse(text);
}

function prefixAndValue(first: string, second: string, maxBits: number): { prefix: IPv6Address; bits: number; value: number } | null {
  const slash = first.indexOf('/');
  const head = slash < 0 ? first : first.slice(0, slash);
  const prefix = inetPton6(head);
  if (prefix === null) return null;
  const bits = slash < 0 ? BigInt(maxBits) : strtoul(first.slice(slash + 1));
  if (bits === null || bits > BigInt(maxBits)) return null;
  const value = strtoul(second);
  if (value === null || value > INT_MAX) return null;
  return { prefix, bits: Number(bits), value: Number(value) };
}

function isIpv4Mapped(address: IPv6Address): boolean {
  const hextets = address.getHextets();
  return hextets.slice(0, 5).every((hextet) => hextet === 0) && hextets[5] === 0xffff;
}

function parseIpv4Dotted(text: string): IPAddress | null {
  return /^[0-9]{1,3}(\.[0-9]{1,3}){3}$/.test(text) ? IPAddress.tryParse(text) : null;
}

function scopeEntry(first: string, second: string): Ipv4Scope | null {
  const slash = first.indexOf('/');
  const head = slash < 0 ? first : first.slice(0, slash);
  const mapped = inetPton6(head);
  if (mapped !== null) {
    if (!isIpv4Mapped(mapped)) return null;
    const bits = slash < 0 ? 128n : strtoul(first.slice(slash + 1));
    const value = strtoul(second);
    if (bits === null || bits < 96n || bits > 128n || value === null || value > INT_MAX) return null;
    const hextets = mapped.getHextets();
    const address = new IPAddress(`${hextets[6] >> 8}.${hextets[6] & 0xff}.${hextets[7] >> 8}.${hextets[7] & 0xff}`);
    return { address, length: Number(bits) - 96, scope: Number(value) };
  }
  const dotted = parseIpv4Dotted(head);
  if (dotted === null) return null;
  const bits = slash < 0 ? 32n : strtoul(first.slice(slash + 1));
  const value = strtoul(second);
  if (bits === null || bits > 32n || value === null || value > INT_MAX) return null;
  return { address: dotted, length: Number(bits), scope: Number(value) };
}

function byLongestPrefix<T extends { readonly length: number }>(entries: T[]): T[] {
  return [...entries].sort((left, right) => right.length - left.length);
}

function tableOf(
  entries: PrefixValue[], builtIn: readonly PrefixValue[], catchAllValue: number,
): readonly PrefixValue[] {
  if (entries.length === 0) return builtIn;
  const complete = entries.some((entry) => entry.length === 0)
    ? entries
    : [...entries, { prefix: new IPv6Address('::'), length: 0, value: catchAllValue }];
  return byLongestPrefix(complete);
}

function scopesOf(entries: Ipv4Scope[]): readonly Ipv4Scope[] {
  if (entries.length === 0) return DEFAULT_IPV4_SCOPES;
  const complete = entries.some((entry) => entry.length === 0)
    ? entries
    : [...entries, { address: new IPAddress('0.0.0.0'), length: 0, scope: CATCH_ALL_SCOPE }];
  return byLongestPrefix(complete);
}

export function parseGaiConf(text: string): DestinationPolicy {
  const labels: PrefixValue[] = [];
  const precedences: PrefixValue[] = [];
  const scopes: Ipv4Scope[] = [];
  for (const raw of text.split('\n')) {
    const line = splitLine(raw);
    if (line === null) continue;
    if (line.command === 'label' || line.command === 'precedence') {
      const parsed = prefixAndValue(line.first, line.second, 128);
      if (parsed === null) continue;
      (line.command === 'label' ? labels : precedences).push({ prefix: parsed.prefix, length: parsed.bits, value: parsed.value });
    } else if (line.command === 'scopev4') {
      const scope = scopeEntry(line.first, line.second);
      if (scope !== null) scopes.push(scope);
    }
  }
  return {
    labels: tableOf(labels, GLIBC_LABELS, CATCH_ALL_LABEL),
    precedences: tableOf(precedences, GLIBC_PRECEDENCES, CATCH_ALL_PRECEDENCE),
    ipv4Scopes: scopesOf(scopes),
    ipv4CommonPrefix: 'same-subnet',
  };
}
