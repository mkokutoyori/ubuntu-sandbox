const MAX_OID_LEN = 128;
const ULONG_MAX = (1n << 64n) - 1n;

interface RootNode {
  readonly label: string;
  readonly subId: bigint;
}

const ROOT_NODES: readonly RootNode[] = [
  { label: 'iso', subId: 1n },
  { label: 'ccitt', subId: 0n },
  { label: 'joint-iso-ccitt', subId: 2n },
];

export type ObjectIdentifierParse =
  | { readonly kind: 'parsed'; readonly oid: string }
  | { readonly kind: 'unknown'; readonly diagnostics: readonly string[] };

type ReadOutcome =
  | { readonly kind: 'read'; readonly subIds: readonly bigint[] }
  | { readonly kind: 'bad'; readonly detail: string };

export function netSnmpMibSearchPath(home: string): string {
  return `${home}/.snmp/mibs:/usr/share/snmp/mibs:/usr/share/snmp/mibs/iana:/usr/share/snmp/mibs/ietf`;
}

export function parseObjectIdentifier(text: string, mibSearchPath: string): ObjectIdentifierParse {
  if (text.includes(':')) return moduleLookupFailure(text, mibSearchPath);
  const read = readObjectIdentifier(text);
  if (read.kind === 'read') return { kind: 'parsed', oid: read.subIds.join('.') };
  const wild = wildRootMatch(text);
  if (wild !== null) return { kind: 'parsed', oid: wild.toString() };
  return { kind: 'unknown', diagnostics: [`${text}: Unknown Object Identifier (${read.detail})`] };
}

function moduleLookupFailure(text: string, mibSearchPath: string): ObjectIdentifierParse {
  const module = /^([0-9A-Za-z-]*):/.exec(text);
  if (!module) return { kind: 'unknown', diagnostics: [`${text}: Unknown Object Identifier`] };
  const named = module[1] === '' ? '' : ` (${module[1]})`;
  return {
    kind: 'unknown',
    diagnostics: [
      `MIB search path: ${mibSearchPath}`,
      `Cannot find module${named}: At line 0 in (none)`,
      `${text}: Unknown Object Identifier`,
    ],
  };
}

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= '0' && char <= '9';
}

function strtoulBase0(token: string): bigint | null {
  let value: bigint;
  if (/^0[xX][0-9a-fA-F]+$/.test(token)) value = BigInt(`0x${token.slice(2)}`);
  else if (/^0[0-7]*$/.test(token)) value = BigInt(`0o${token.slice(1) || '0'}`);
  else if (/^[1-9][0-9]*$/.test(token)) value = BigInt(token);
  else return null;
  return value > ULONG_MAX ? ULONG_MAX : value;
}

function readObjectIdentifier(text: string): ReadOutcome {
  const input = text.startsWith('.') ? text.slice(1) : text;
  const subIds: bigint[] = [];
  const firstEnd = input.indexOf('.');
  const first = firstEnd === -1 ? input : input.slice(0, firstEnd);
  const topDetail = (token: string): string => `Sub-id not found: (top) -> ${token}`;
  let root: RootNode | undefined;
  if (isDigit(first[0])) {
    const value = strtoulBase0(first);
    if (value === null) return { kind: 'bad', detail: topDetail(first) };
    root = ROOT_NODES.find((node) => node.subId === value);
    subIds.push(value);
  } else {
    root = ROOT_NODES.find((node) => node.label === first);
    if (!root) return { kind: 'bad', detail: topDetail(first) };
    subIds.push(root.subId);
  }
  const detailFor = (token: string): string => root ? token : topDetail(token);
  let position: number | null = firstEnd === -1 ? null : firstEnd + 1;
  while (position !== null) {
    const rest = input.slice(position);
    if (isDigit(rest[0])) {
      const end = rest.indexOf('.');
      const token = end === -1 ? rest : rest.slice(0, end);
      const value = strtoulBase0(token);
      if (value === null || subIds.length >= MAX_OID_LEN) return { kind: 'bad', detail: detailFor(token) };
      subIds.push(value);
      position = end === -1 ? null : position + end + 1;
      continue;
    }
    if (rest[0] === '"' || rest[0] === "'") {
      const close = rest.indexOf(rest[0], 1);
      if (rest.length === 1 || close === -1) return { kind: 'bad', detail: detailFor(rest) };
      const octets = new TextEncoder().encode(rest.slice(1, close));
      const encoded = rest[0] === '"' ? [BigInt(octets.length), ...[...octets].map(BigInt)] : [...octets].map(BigInt);
      if (subIds.length + encoded.length > MAX_OID_LEN) return { kind: 'bad', detail: detailFor(rest) };
      subIds.push(...encoded);
      const after = rest[close + 1];
      if (after === undefined) position = null;
      else if (after === '.') position = position + close + 2;
      else return { kind: 'bad', detail: detailFor(rest) };
      continue;
    }
    const end = rest.indexOf('.');
    return { kind: 'bad', detail: detailFor(end === -1 ? rest : rest.slice(0, end)) };
  }
  return { kind: 'read', subIds };
}

function wildRootMatch(pattern: string): bigint | null {
  if (pattern === '') return null;
  let best: RootNode | null = null;
  let bestAt = Number.POSITIVE_INFINITY;
  for (const node of ROOT_NODES) {
    let at: number;
    try {
      at = node.label.search(new RegExp(pattern, 'i'));
    } catch {
      at = -1;
    }
    if (at < 0 || at >= bestAt) continue;
    best = node;
    bestAt = at;
    if (at === 0) break;
  }
  return best?.subId ?? null;
}
