import { hexPrintLines } from './TcpdumpHex';

type AddressName = (address: string) => string;

const OSPF_HEADER_BYTES = 24;
const LSA_HEADER_BYTES = 20;
const AUTH_MD5_BYTES = 16;
const AUTH_SIMPLE_BYTES = 8;

const TRUNCATED = ' [|ospf2]';

const PACKET_TYPES: Readonly<Record<number, string>> = {
  1: 'Hello', 2: 'Database Description', 3: 'LS-Request', 4: 'LS-Update', 5: 'LS-Ack',
};

const OPTION_TOKENS: ReadonlyArray<readonly [number, string]> = [
  [0x01, 'MultiTopology'], [0x02, 'External'], [0x04, 'Multicast'], [0x08, 'NSSA'], [0x10, 'LLS'],
  [0x20, 'Demand Circuit'], [0x40, 'Opaque'], [0x80, 'Up/Down'],
];

const AUTH_TYPES: Readonly<Record<number, string>> = { 0: 'none', 1: 'simple', 2: 'MD5' };

const ROUTER_FLAG_TOKENS: ReadonlyArray<readonly [number, string]> = [
  [0x01, 'ABR'], [0x02, 'ASBR'], [0x04, 'Virtual'], [0x08, 'Wildcard'], [0x10, 'Nt'], [0x80, 'Host'],
];

const DD_FLAG_TOKENS: ReadonlyArray<readonly [number, string]> = [
  [0x04, 'Init'], [0x02, 'More'], [0x01, 'Master'], [0x08, 'OOBResync'],
];

const LSA_TYPES: Readonly<Record<number, string>> = {
  1: 'Router', 2: 'Network', 3: 'Summary', 4: 'ASBR Summary', 5: 'External', 6: 'Multicast Group', 7: 'NSSA',
  9: 'Link Local Opaque', 10: 'Area Local Opaque', 11: 'Domain Wide Opaque',
};

const TOPOLOGIES: Readonly<Record<number, string>> = { 0: 'default', 1: 'multicast', 2: 'management' };

function u16(bytes: readonly number[], at: number): number {
  return (bytes[at] << 8) | bytes[at + 1];
}

function u24(bytes: readonly number[], at: number): number {
  return (bytes[at] << 16) | (bytes[at + 1] << 8) | bytes[at + 2];
}

function u32(bytes: readonly number[], at: number): number {
  return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
}

function dotted(bytes: readonly number[], at: number): string {
  return `${bytes[at]}.${bytes[at + 1]}.${bytes[at + 2]}.${bytes[at + 3]}`;
}

function hex8(value: number): string {
  return value.toString(16).padStart(8, '0');
}

function bitTokens(tokens: ReadonlyArray<readonly [number, string]>, value: number): string {
  const found = tokens.filter(([bit]) => (value & bit) === bit).map(([, name]) => name);
  return found.length === 0 ? 'none' : found.join(', ');
}

function plural(count: number): string {
  return count === 1 ? '' : 's';
}

function printableByte(byte: number): string {
  let c = byte;
  let text = '';
  if (c > 0x7f) {
    c &= 0x7f;
    text += 'M-';
  }
  if (c < 0x20 || c === 0x7f) {
    c ^= 0x40;
    text += '^';
  }
  return text + String.fromCharCode(c);
}

function nullPaddedText(bytes: readonly number[]): string {
  let text = '';
  for (const byte of bytes) {
    if (byte === 0) break;
    text += printableByte(byte);
  }
  return text;
}

function lsaHeader(bytes: readonly number[], at: number, name: AddressName): { text: string; length: number } | null {
  const length = u16(bytes, at + 18);
  if (length < LSA_HEADER_BYTES) {
    return { text: `\n\t    Bogus length ${length} < header (${LSA_HEADER_BYTES})`, length: -1 };
  }
  const type = bytes[at + 3];
  let text = `\n\t  Advertising Router ${name(dotted(bytes, at + 8))}, seq 0x${hex8(u32(bytes, at + 12))}, `
    + `age ${u16(bytes, at)}s, length ${length - LSA_HEADER_BYTES}`;
  const typeName = LSA_TYPES[type] ?? 'unknown';
  if (type === 9 || type === 10 || type === 11) {
    text += `\n\t    ${typeName} LSA (${type}), Opaque-Type unknown LSA (${bytes[at + 4]}), Opaque-ID ${u24(bytes, at + 5)}`;
  } else {
    text += `\n\t    ${typeName} LSA (${type}), LSA-ID: ${name(dotted(bytes, at + 4))}`;
  }
  text += `\n\t    Options: [${bitTokens(OPTION_TOKENS, bytes[at + 2])}]`;
  return { text, length };
}

function topologyMetrics(bytes: readonly number[], at: number): { text: string; size: number } {
  const count = bytes[at + 1] + 1;
  let text = '';
  for (let index = 0; index < count; index++) {
    const type = index === 0 ? 0 : bytes[at + 4 * index];
    const metric = u16(bytes, at + 4 * index + 2);
    text += `\n\t\ttopology ${TOPOLOGIES[type] ?? 'Unknown'} (${type}), metric ${metric}`;
  }
  return { text, size: 4 * count };
}

function summaryMetric(value: number): string {
  const topology = (value & 0x7f000000) >>> 24;
  return `\n\t\ttopology ${TOPOLOGIES[topology] ?? 'Unknown'} (${topology}) metric ${value & 0x00ffffff}`;
}

function lsa(bytes: readonly number[], at: number, verbose: number, name: AddressName): { text: string; end: number } | null {
  const header = lsaHeader(bytes, at, name);
  if (header === null || header.length < 0) return null;
  const end = at + header.length;
  const body = at + LSA_HEADER_BYTES;
  const type = bytes[at + 3];
  let text = header.text;
  switch (type) {
    case 1: {
      text += `\n\t    Router LSA Options: [${bitTokens(ROUTER_FLAG_TOKENS, bytes[body])}]`;
      let cursor = body + 4;
      for (let remaining = u16(bytes, body + 2); remaining !== 0; remaining--) {
        const linkType = bytes[cursor + 8];
        const id = name(dotted(bytes, cursor));
        const data = name(dotted(bytes, cursor + 4));
        if (linkType === 4) text += `\n\t      Virtual Link: Neighbor Router-ID: ${id}, Interface Address: ${data}`;
        else if (linkType === 1) text += `\n\t      Neighbor Router-ID: ${id}, Interface Address: ${data}`;
        else if (linkType === 2) text += `\n\t      Neighbor Network-ID: ${id}, Interface Address: ${data}`;
        else if (linkType === 3) text += `\n\t      Stub Network: ${id}, Mask: ${data}`;
        else return { text: `${text}\n\t      Unknown Router Link Type (${linkType})`, end };
        const metrics = topologyMetrics(bytes, cursor + 8);
        text += metrics.text;
        cursor += 8 + metrics.size;
      }
      break;
    }
    case 2: {
      text += `\n\t    Mask ${name(dotted(bytes, body))}\n\t    Connected Routers:`;
      for (let cursor = body + 4; cursor < end; cursor += 4) text += `\n\t      ${name(dotted(bytes, cursor))}`;
      break;
    }
    case 3: {
      text += `\n\t    Mask ${name(dotted(bytes, body))}`;
      for (let cursor = body + 4; cursor < end; cursor += 4) text += summaryMetric(u32(bytes, cursor));
      break;
    }
    case 4: {
      for (let cursor = body + 4; cursor < end; cursor += 4) text += summaryMetric(u32(bytes, cursor));
      break;
    }
    case 5:
    case 7: {
      text += `\n\t    Mask ${name(dotted(bytes, body))}`;
      for (let cursor = body + 4; cursor < end; cursor += 12) {
        const value = u32(bytes, cursor);
        const topology = (value & 0x7f000000) >>> 24;
        text += `\n\t\ttopology ${TOPOLOGIES[topology] ?? 'Unknown'} (${topology}), type ${(value & 0x80000000) !== 0 ? 2 : 1}, metric`;
        text += (value & 0x00ffffff) === 0xffffff ? ' infinite' : ` ${value & 0x00ffffff}`;
        if (u32(bytes, cursor + 4) !== 0) text += `, forward ${name(dotted(bytes, cursor + 4))}`;
        if (u32(bytes, cursor + 8) !== 0) text += `, tag ${name(dotted(bytes, cursor + 8))}`;
      }
      break;
    }
    default:
      break;
  }
  if (verbose > 1) text += hexPrintLines(bytes.slice(body, end), '\n\t    ');
  return { text, end };
}

function helloText(bytes: readonly number[], end: number, name: AddressName): string {
  const body = OSPF_HEADER_BYTES;
  let text = `\n\tOptions [${bitTokens(OPTION_TOKENS, bytes[body + 6])}]`;
  text += `\n\t  Hello Timer ${u16(bytes, body + 4)}s, Dead Timer ${u32(bytes, body + 8)}s, `
    + `Mask ${name(dotted(bytes, body))}, Priority ${bytes[body + 7]}`;
  if (u32(bytes, body + 12) !== 0) text += `\n\t  Designated Router ${name(dotted(bytes, body + 12))}`;
  if (u32(bytes, body + 16) !== 0) text += `, Backup Designated Router ${name(dotted(bytes, body + 16))}`;
  const first = body + 20;
  if (first < end) text += '\n\t  Neighbor List:';
  for (let cursor = first; cursor < end; cursor += 4) text += `\n\t    ${name(dotted(bytes, cursor))}`;
  return text;
}

function databaseDescriptionText(bytes: readonly number[], end: number, name: AddressName): string {
  const body = OSPF_HEADER_BYTES;
  let text = `\n\tOptions [${bitTokens(OPTION_TOKENS, bytes[body + 2])}]`;
  text += `, DD Flags [${bitTokens(DD_FLAG_TOKENS, bytes[body + 3])}]`;
  if (u16(bytes, body) !== 0) text += `, MTU: ${u16(bytes, body)}`;
  text += `, Sequence: 0x${hex8(u32(bytes, body + 4))}`;
  for (let cursor = body + 8; cursor < end; cursor += LSA_HEADER_BYTES) {
    const header = lsaHeader(bytes, cursor, name);
    if (header === null) break;
    text += header.text;
    if (header.length < 0) break;
  }
  return text;
}

function requestText(bytes: readonly number[], end: number, name: AddressName): string {
  let text = '';
  for (let cursor = OSPF_HEADER_BYTES; cursor + 12 <= end; cursor += 12) {
    const type = u32(bytes, cursor);
    text += `\n\t  Advertising Router: ${name(dotted(bytes, cursor + 8))}, ${LSA_TYPES[type] ?? 'unknown'} LSA (${type})`;
    if (type === 9 || type === 10 || type === 11) {
      text += `, Opaque-Type: unknown LSA (${bytes[cursor + 4]}), Opaque-ID: ${u24(bytes, cursor + 5)}`;
    } else {
      text += `, LSA-ID: ${name(dotted(bytes, cursor + 4))}`;
    }
  }
  return text;
}

function updateText(bytes: readonly number[], verbose: number, name: AddressName): string | null {
  const count = u32(bytes, OSPF_HEADER_BYTES);
  let text = `, ${count} LSA${plural(count)}`;
  let cursor = OSPF_HEADER_BYTES + 4;
  for (let index = 1; index <= count; index++) {
    text += `\n\t  LSA #${index}`;
    const printed = lsa(bytes, cursor, verbose, name);
    if (printed === null) return null;
    text += printed.text;
    cursor = printed.end;
  }
  return text;
}

function acknowledgementText(bytes: readonly number[], end: number, name: AddressName): string {
  let text = '';
  for (let cursor = OSPF_HEADER_BYTES; cursor + LSA_HEADER_BYTES <= end; cursor += LSA_HEADER_BYTES) {
    const header = lsaHeader(bytes, cursor, name);
    if (header === null) break;
    text += header.text;
    if (header.length < 0) return text;
  }
  return `${text}${TRUNCATED}`;
}

export function ospfText(packet: readonly number[], ipPayloadLength: number, verbose: number, name: AddressName): string {
  if (packet.length < OSPF_HEADER_BYTES) return '[|ospf2]';
  const authType = u16(packet, 14);
  const length = authType === 2 ? ipPayloadLength - AUTH_MD5_BYTES : ipPayloadLength;
  const bytes = authType === 2 ? packet.slice(0, packet.length - AUTH_MD5_BYTES) : packet;
  const type = bytes[1];
  const typeName = PACKET_TYPES[type] ?? `unknown LS-type ${type}`;
  let text = `OSPFv${bytes[0]}, ${typeName}, length ${length}`;
  if (PACKET_TYPES[type] === undefined || verbose === 0) return text;
  const declared = u16(bytes, 2);
  if (length !== declared) text += ` [len ${declared}]`;
  const end = length > declared ? declared : Math.min(length, bytes.length);
  text += `\n\tRouter-ID ${name(dotted(bytes, 4))}`;
  text += u32(bytes, 8) !== 0 ? `, Area ${name(dotted(bytes, 8))}` : ', Backbone Area';
  text += `, Authentication Type: ${AUTH_TYPES[authType] ?? 'unknown'} (${authType})`;
  if (authType === 1) text += `\n\tSimple text password: ${nullPaddedText(bytes.slice(16, 16 + AUTH_SIMPLE_BYTES))}`;
  else if (authType === 2) text += `\n\tKey-ID: ${bytes[18]}, Auth-Length: ${bytes[19]}, Crypto Sequence Number: 0x${hex8(u32(bytes, 20))}`;
  else if (authType !== 0) return text;
  if (bytes[0] !== 2) return `${text} ospf [version ${bytes[0]}]`;
  switch (type) {
    case 1: return text + helloText(bytes, end, name);
    case 2: return text + databaseDescriptionText(bytes, end, name);
    case 3: return text + requestText(bytes, end, name);
    case 4: {
      const update = updateText(bytes, verbose, name);
      return update === null ? `${text}[|ospf2]` : text + update;
    }
    default: return text + acknowledgementText(bytes, end, name);
  }
}

