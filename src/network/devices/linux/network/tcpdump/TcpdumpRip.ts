import { hexPrintLines } from './TcpdumpHex';

const ROUTE_LENGTH = 20;
const HEADER_LENGTH = 4;
const AUTH_LENGTH = 16;
const ENTRY_HEADER_LENGTH = 4;
const AFI_INET = 2;
const AFI_AUTH = 0xffff;

const COMMANDS: Readonly<Record<number, string>> = {
  1: 'Request', 2: 'Response', 3: 'Trace on', 4: 'Trace off', 5: 'Poll', 6: 'Poll Entry',
};

const ADDRESS_FAMILIES: Readonly<Record<number, string>> = {
  2: 'IPv4', 6: 'NS', 7: 'ISO', 16: 'Appletalk', 23: 'IPX', 24: 'IPv6', 28: 'IPv6', 30: 'IPv6',
};

function u16(bytes: readonly number[], at: number): number {
  return (bytes[at] << 8) | bytes[at + 1];
}

function u32(bytes: readonly number[], at: number): number {
  return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
}

function address(bytes: readonly number[], at: number): string {
  return `${bytes[at]}.${bytes[at + 1]}.${bytes[at + 2]}.${bytes[at + 3]}`;
}

function maskToPrefixLength(mask: number): number {
  for (let prefix = 32; prefix >= 0; prefix--) {
    const candidate = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    if (candidate === mask) return prefix;
  }
  return -1;
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

function unknownData(bytes: readonly number[], ident: string): string {
  return hexPrintLines(bytes, ident);
}

function familyName(family: number, fallback: (value: number) => string): string {
  return ADDRESS_FAMILIES[family] ?? fallback(family);
}

function entryV1(bytes: readonly number[], at: number, remaining: number): { text: string; size: number } | null {
  if (remaining < ROUTE_LENGTH) return null;
  const family = u16(bytes, at);
  if (family !== AFI_INET && family !== 0) {
    return {
      text: `\n\t AFI ${familyName(family, (value) => `Unknown (${value})`)}, `
        + unknownData(bytes.slice(at + ENTRY_HEADER_LENGTH, at + ROUTE_LENGTH), '\n\t  '),
      size: ROUTE_LENGTH,
    };
  }
  if (u16(bytes, at + 2) !== 0 || u32(bytes, at + 8) !== 0 || u32(bytes, at + 12) !== 0) {
    return { text: unknownData(bytes.slice(at, at + ROUTE_LENGTH), '\n\t  '), size: ROUTE_LENGTH };
  }
  const destination = address(bytes, at + 4);
  const metric = u32(bytes, at + 16);
  return {
    text: family === 0 ? `\n\t  AFI 0, ${destination}, metric: ${metric}` : `\n\t  ${destination}, metric: ${metric}`,
    size: ROUTE_LENGTH,
  };
}

function entryV2(bytes: readonly number[], at: number, remaining: number): { text: string; size: number } | null {
  if (remaining < ENTRY_HEADER_LENGTH) return null;
  const family = u16(bytes, at);
  if (family === AFI_AUTH) {
    const authType = u16(bytes, at + 2);
    const body = at + ENTRY_HEADER_LENGTH;
    const left = remaining - ENTRY_HEADER_LENGTH;
    if (authType === 2) {
      return { text: `\n\t  Simple Text Authentication data: ${nullPaddedText(bytes.slice(body, body + AUTH_LENGTH))}`, size: ROUTE_LENGTH };
    }
    if (authType === 3) {
      if (left < AUTH_LENGTH) return null;
      return {
        text: '\n\t  Auth header:'
          + ` Packet Len ${u16(bytes, body)},`
          + ` Key-ID ${bytes[body + 2]},`
          + ` Auth Data Len ${bytes[body + 3]},`
          + ` SeqNo ${u32(bytes, body + 4)},`
          + ` MBZ ${u32(bytes, body + 8)},`
          + ` MBZ ${u32(bytes, body + 12)}`,
        size: ROUTE_LENGTH,
      };
    }
    if (authType === 1) {
      return { text: `\n\t  Auth trailer:${unknownData(bytes.slice(body, body + left), '\n\t  ')}`, size: ENTRY_HEADER_LENGTH + left };
    }
    return {
      text: `\n\t  Unknown (${authType}) Authentication data:${unknownData(bytes.slice(body, body + left), '\n\t  ')}`,
      size: ENTRY_HEADER_LENGTH + left,
    };
  }
  if (family !== AFI_INET && family !== 0) {
    return {
      text: `\n\t  AFI ${familyName(family, (value) => `Unknown (${value})`)}`
        + unknownData(bytes.slice(at + ENTRY_HEADER_LENGTH, at + ROUTE_LENGTH), '\n\t  '),
      size: ROUTE_LENGTH,
    };
  }
  if (remaining < ROUTE_LENGTH) return null;
  const prefix = maskToPrefixLength(u32(bytes, at + 8));
  const router = u32(bytes, at + 12);
  const afi = family === 0 ? '0' : familyName(family, String);
  return {
    text: `\n\t  AFI ${afi}, ${address(bytes, at + 4).padStart(15)}/${String(prefix).padEnd(2)}, `
      + `tag 0x${u16(bytes, at + 2).toString(16).padStart(4, '0')}, metric: ${u32(bytes, at + 16)}, `
      + `next-hop: ${router !== 0 ? address(bytes, at + 12) : 'self'}`,
    size: ROUTE_LENGTH,
  };
}

export function ripText(bytes: readonly number[], length: number, verbose: number): string {
  const available = Math.min(bytes.length, length);
  if (available < HEADER_LENGTH) return '[|rip]';
  const version = bytes[1];
  let text = `${verbose >= 1 ? '\n\t' : ''}RIPv${version}`;
  if (version === 0) return text + unknownData(bytes.slice(0, length), '\n\t');
  const command = bytes[0];
  text += `, ${COMMANDS[command] ?? `unknown command (${command})`}, length: ${length}`;
  if (verbose < 1) return text;
  let remaining = available - HEADER_LENGTH;
  if (command === 1 || command === 2) {
    if (version !== 1 && version !== 2) return `${text}, unknown version`;
    text += `, routes: ${Math.floor(length / ROUTE_LENGTH)}${version === 2 ? ' or less' : ''}`;
    let at = HEADER_LENGTH;
    while (remaining !== 0) {
      const entry = version === 1 ? entryV1(bytes, at, remaining) : entryV2(bytes, at, remaining);
      if (entry === null) return `${text}[|rip]`;
      if (remaining < entry.size) return `${text} [remaining entries length ${remaining} < ${entry.size}] (invalid)`;
      text += entry.text;
      at += entry.size;
      remaining -= entry.size;
    }
  } else if (command !== 4 && command !== 5 && command !== 6 && verbose <= 1) {
    text += unknownData(bytes.slice(0, length), '\n\t');
  }
  if (verbose > 1) text += unknownData(bytes.slice(0, length), '\n\t');
  return text;
}
