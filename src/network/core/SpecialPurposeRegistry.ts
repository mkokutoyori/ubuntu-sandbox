export interface SpecialPurposeEntry {
  readonly block: string;
  readonly name: string;
  readonly rfc: string;
  readonly source: boolean;
  readonly destination: boolean;
  readonly forwardable: boolean;
  readonly global: boolean;
  readonly reservedByProtocol: boolean;
}

type Row = readonly [string, string, string, boolean, boolean, boolean, boolean, boolean];

const IPV4_ROWS: readonly Row[] = [
  ['0.0.0.0/8', 'This host on this network', 'RFC1122', true, false, false, false, true],
  ['10.0.0.0/8', 'Private-Use', 'RFC1918', true, true, true, false, false],
  ['100.64.0.0/10', 'Shared Address Space', 'RFC6598', true, true, true, false, false],
  ['127.0.0.0/8', 'Loopback', 'RFC1122', false, false, false, false, true],
  ['169.254.0.0/16', 'Link Local', 'RFC3927', true, true, false, false, true],
  ['172.16.0.0/12', 'Private-Use', 'RFC1918', true, true, true, false, false],
  ['192.0.0.0/24', 'IETF Protocol Assignments', 'RFC6890', false, false, false, false, false],
  ['192.0.0.0/29', 'DS-Lite', 'RFC6333', true, true, true, false, false],
  ['192.0.2.0/24', 'Documentation (TEST-NET-1)', 'RFC5737', false, false, false, false, false],
  ['192.88.99.0/24', '6to4 Relay Anycast', 'RFC3068', true, true, true, true, false],
  ['192.168.0.0/16', 'Private-Use', 'RFC1918', true, true, true, false, false],
  ['198.18.0.0/15', 'Benchmarking', 'RFC2544', true, true, true, false, false],
  ['198.51.100.0/24', 'Documentation (TEST-NET-2)', 'RFC5737', false, false, false, false, false],
  ['203.0.113.0/24', 'Documentation (TEST-NET-3)', 'RFC5737', false, false, false, false, false],
  ['240.0.0.0/4', 'Reserved', 'RFC1112', false, false, false, false, true],
  ['255.255.255.255/32', 'Limited Broadcast', 'RFC919', false, true, false, false, false],
];

const IPV6_ROWS: readonly Row[] = [
  ['::1/128', 'Loopback Address', 'RFC4291', false, false, false, false, true],
  ['::/128', 'Unspecified Address', 'RFC4291', true, false, false, false, true],
  ['64:ff9b::/96', 'IPv4-IPv6 Translat.', 'RFC6052', true, true, true, true, false],
  ['::ffff:0:0/96', 'IPv4-mapped Address', 'RFC4291', false, false, false, false, true],
  ['100::/64', 'Discard-Only Address Block', 'RFC6666', true, true, true, false, false],
  ['2001::/23', 'IETF Protocol Assignments', 'RFC2928', false, false, false, false, false],
  ['2001::/32', 'TEREDO', 'RFC4380', true, true, true, false, false],
  ['2001:2::/48', 'Benchmarking', 'RFC5180', true, true, true, false, false],
  ['2001:db8::/32', 'Documentation', 'RFC3849', false, false, false, false, false],
  ['2001:10::/28', 'ORCHID', 'RFC4843', false, false, false, false, false],
  ['fc00::/7', 'Unique-Local', 'RFC4193', true, true, true, false, false],
  ['fe80::/10', 'Linked-Scoped Unicast', 'RFC4291', true, true, false, false, false],
];

function entryOf(row: Row): SpecialPurposeEntry {
  const [block, name, rfc, source, destination, forwardable, global, reservedByProtocol] = row;
  return { block, name, rfc, source, destination, forwardable, global, reservedByProtocol };
}

interface V4Block { readonly base: number; readonly prefix: number; readonly entry: SpecialPurposeEntry }
interface V6Block { readonly hextets: readonly number[]; readonly prefix: number; readonly entry: SpecialPurposeEntry }

function parseV4(row: Row): V4Block {
  const [address, length] = row[0].split('/');
  const base = address.split('.').reduce((acc, octet) => ((acc << 8) | Number(octet)) >>> 0, 0);
  return { base, prefix: Number(length), entry: entryOf(row) };
}

function expandV6(address: string): number[] {
  const [head, tail] = address.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = tail === undefined || tail === '' ? [] : tail.split(':');
  const fill = tail === undefined ? 0 : 8 - left.length - right.length;
  return [...left, ...Array<string>(fill).fill('0'), ...right].map(h => parseInt(h, 16));
}

function parseV6(row: Row): V6Block {
  const [address, length] = row[0].split('/');
  return { hextets: expandV6(address), prefix: Number(length), entry: entryOf(row) };
}

const V4_BLOCKS = IPV4_ROWS.map(parseV4);
const V6_BLOCKS = IPV6_ROWS.map(parseV6);

export function lookupIpv4SpecialPurpose(address: number): SpecialPurposeEntry | null {
  let best: V4Block | null = null;
  for (const block of V4_BLOCKS) {
    const shift = 32 - block.prefix;
    const matches = shift === 32 ? true : (address >>> shift) === (block.base >>> shift);
    if (matches && (best === null || block.prefix > best.prefix)) best = block;
  }
  return best ? best.entry : null;
}

function v6Matches(hextets: readonly number[], block: V6Block): boolean {
  let remaining = block.prefix;
  for (let i = 0; i < 8 && remaining > 0; i++) {
    const bits = Math.min(16, remaining);
    const mask = (0xffff << (16 - bits)) & 0xffff;
    if ((hextets[i] & mask) !== (block.hextets[i] & mask)) return false;
    remaining -= bits;
  }
  return true;
}

export function lookupIpv6SpecialPurpose(hextets: readonly number[]): SpecialPurposeEntry | null {
  let best: V6Block | null = null;
  for (const block of V6_BLOCKS) {
    if (v6Matches(hextets, block) && (best === null || block.prefix > best.prefix)) best = block;
  }
  return best ? best.entry : null;
}

export const IPV4_SPECIAL_PURPOSE_ENTRIES: readonly SpecialPurposeEntry[] = V4_BLOCKS.map(b => b.entry);
export const IPV6_SPECIAL_PURPOSE_ENTRIES: readonly SpecialPurposeEntry[] = V6_BLOCKS.map(b => b.entry);
