import { IPv6Address } from '@/network/core/types';
import { transportChecksum, WIRE_PROTOCOLS } from './CaptureWire';
import { hexPrintLines } from './TcpdumpHex';

const TYPE_NAMES: Readonly<Record<number, string>> = {
  1: 'destination unreachable', 2: 'packet too big', 3: 'time exceeded in-transit', 4: 'parameter problem',
  128: 'echo request', 129: 'echo reply', 130: 'multicast listener query', 131: 'multicast listener report',
  132: 'multicast listener done', 133: 'router solicitation', 134: 'router advertisement',
  135: 'neighbor solicitation', 136: 'neighbor advertisement', 137: 'redirect', 138: 'router renumbering',
  141: 'inverse neighbor solicitation', 142: 'inverse neighbor advertisement', 143: 'multicast listener report v2',
  144: 'ha discovery request', 145: 'ha discovery reply', 146: 'mobile router solicitation',
  147: 'mobile router advertisement', 139: 'node information query', 140: 'node information reply',
  200: 'mtrace message', 201: 'mtrace response', 155: 'RPL',
};

const OPTION_NAMES: Readonly<Record<number, string>> = {
  1: 'source link-address', 2: 'destination link-address', 3: 'prefix info', 4: 'redirected header', 5: 'mtu',
  25: 'rdnss', 31: 'dnssl', 7: 'advertisement interval', 8: 'homeagent information', 24: 'route info',
};

const DST_UNREACH_NAMES: Readonly<Record<number, string>> = {
  0: 'unreachable route', 1: ' unreachable prohibited', 2: 'beyond scope', 3: 'unreachable address', 4: 'unreachable port',
};

const LENGTH_AFTER_TYPE = new Set([133, 134, 136, 135, 137, 145, 147]);
const ROUTER_PREFERENCE = ['medium', 'high', 'rsv', 'low'];
const ICMP6_HEADER_BYTES = 8;
const NEIGHBOR_SOLICIT_BYTES = 24;
const NEIGHBOR_ADVERT_BYTES = 24;
const ROUTER_SOLICIT_BYTES = 8;
const ROUTER_ADVERT_BYTES = 16;
const REDIRECT_BYTES = 40;

export interface Icmp6Context {
  readonly verbose: number;
  readonly sourceIp: string;
  readonly destinationIp: string;
  readonly fragmented: boolean;
  readonly host: (address: string) => string;
  readonly port: (port: number, protocol: 'tcp' | 'udp') => string;
}

function be16(bytes: readonly number[], at: number): number {
  return (bytes[at] << 8) | bytes[at + 1];
}

function be32(bytes: readonly number[], at: number): number {
  return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
}

function addressAt(bytes: readonly number[], at: number, context: Icmp6Context): string {
  const hextets: number[] = [];
  for (let i = 0; i < 8; i++) hextets.push(be16(bytes, at + i * 2));
  return context.host(new IPv6Address(hextets).toString().replace(/%.*$/, ''));
}

function flagNames(value: number, table: ReadonlyArray<readonly [number, string]>): string {
  const names = table.filter(([bit]) => (value & bit) !== 0).map(([, name]) => name);
  return names.length === 0 ? 'none' : names.join(', ');
}

function lifetime(value: number): string {
  return value === 0xffffffff ? 'infinity' : `${value}s`;
}

function hexLines(bytes: readonly number[], ident: string): string {
  return hexPrintLines(bytes, ident);
}

function optionsText(message: readonly number[], from: number, context: Icmp6Context): string {
  let text = '';
  let cursor = from;
  while (cursor < message.length) {
    const type = message[cursor];
    const units = message[cursor + 1];
    if (units === undefined || units === 0 || cursor + (units << 3) > message.length) return `${text} [|icmp6]`;
    const size = units << 3;
    text += `\n\t  ${OPTION_NAMES[type] ?? 'unknown'} option (${type}), length ${size} (${units}): `;
    const body = message.slice(cursor + 2, cursor + size);
    let handled = true;
    switch (type) {
      case 1: case 2: text += body.map(b => b.toString(16).padStart(2, '0')).join(':'); break;
      case 3:
        text += `${addressAt(message, cursor + 16, context)}/${message[cursor + 2]}${units !== 4 ? 'badlen' : ''}, Flags [${flagNames(message[cursor + 3], [[0x80, 'onlink'], [0x40, 'auto'], [0x20, 'router']])}], valid time ${lifetime(be32(message, cursor + 4))}`;
        text += `, pref. time ${lifetime(be32(message, cursor + 8))}`;
        break;
      case 4: text += hexLines(message.slice(cursor, cursor + size), '\n\t    '); break;
      case 5: text += ` ${be32(message, cursor + 4)}${units !== 1 ? 'bad option length' : ''}`; break;
      case 25: {
        text += ` lifetime ${be32(message, cursor + 4)}s,`;
        for (let i = 0; i < (units - 1) / 2; i++) text += ` addr: ${addressAt(message, cursor + 8 + i * 16, context)}`;
        break;
      }
      case 7: text += ` ${be32(message, cursor + 4)}ms`; break;
      case 8: text += ` preference ${be16(message, cursor + 4)}, lifetime ${be16(message, cursor + 6)}`; break;
      case 24: {
        const prefix = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        const bytes = units === 1 ? 0 : units === 2 ? 8 : 16;
        for (let i = 0; i < bytes; i++) prefix[i] = message[cursor + 8 + i];
        const hextets: number[] = [];
        for (let i = 0; i < 8; i++) hextets.push((prefix[i * 2] << 8) | prefix[i * 2 + 1]);
        text += ` ${context.host(new IPv6Address(hextets).toString())}/${message[cursor + 2]}`;
        text += `, pref=${ROUTER_PREFERENCE[(message[cursor + 3] & 0x18) >> 3]}`;
        text += `, lifetime=${lifetime(be32(message, cursor + 4))}`;
        break;
      }
      default:
        handled = false;
        if (context.verbose <= 1) return text + hexLines(body, '\n\t  ');
    }
    if (!handled && context.verbose <= 1) return text;
    if (context.verbose > 1) text += hexLines(body, '\n\t    ');
    cursor += size;
  }
  return text;
}

export function icmp6Checksum(message: readonly number[], sourceIp: string, destinationIp: string): { stored: number; sum: number } {
  const copy = message.slice();
  const stored = be16(copy, 2);
  copy[2] = 0;
  copy[3] = 0;
  return { stored, sum: transportChecksum(sourceIp, destinationIp, WIRE_PROTOCOLS.icmpv6, copy) };
}

export function icmp6Text(message: readonly number[], context: Icmp6Context): string {
  if (message.length === 0) return 'ICMP6, length 0 (invalid)';
  const length = message.length;
  let text = '';
  if (context.verbose > 0 && !context.fragmented) {
    const { stored, sum } = icmp6Checksum(message, context.sourceIp, context.destinationIp);
    text += sum === stored
      ? '[icmp6 sum ok] '
      : `[bad icmp6 cksum 0x${stored.toString(16).padStart(4, '0')} -> 0x${sum.toString(16).padStart(4, '0')}!] `;
  }
  const type = message[0];
  text += `ICMP6, ${TYPE_NAMES[type] ?? `unknown icmp6 type (${type})`}`;
  if (context.verbose > 0 && LENGTH_AFTER_TYPE.has(type)) text += `, length ${length}`;
  {
    switch (type) {
      case 1: {
        const code = message[1];
        text += `, ${DST_UNREACH_NAMES[code] ?? `unknown unreach code (${code})`}`;
        if (code === 0 || code === 1 || code === 3) text += ` ${addressAt(message, 32, context)}`;
        else if (code === 2) text += ` ${addressAt(message, 32, context)}, source address ${addressAt(message, 16, context)}`;
        else if (code === 4) {
          const next = message[14];
          const port = be16(message, 48);
          if (next === 6 || next === 17) text += `, ${addressAt(message, 32, context)} ${next === 6 ? 'tcp' : 'udp'} port ${context.port(port, next === 6 ? 'tcp' : 'udp')}`;
          else text += `, ${addressAt(message, 32, context)} protocol ${next} port ${port} unreachable`;
        } else if (context.verbose <= 1) {
          return text + hexLines(message, '\n\t');
        }
        break;
      }
      case 2: text += `, mtu ${be32(message, 4)}`; break;
      case 3:
        if (message[1] === 0) text += ` for ${addressAt(message, 32, context)}`;
        else if (message[1] === 1) text += ' (reassembly)';
        else text += `, unknown code (${message[1]})`;
        break;
      case 4: {
        const where = be32(message, 4);
        const named = ['erroneous', 'next header', 'option', 'incomplete header chain'][message[1]];
        text += named === undefined ? `, code-#${message[1]}` : `, ${named} - octet ${where}`;
        break;
      }
      case 128: case 129: text += `, id ${be16(message, 4)}, seq ${be16(message, 6)}`; break;
      case 133:
        if (context.verbose > 0) text += optionsText(message, ROUTER_SOLICIT_BYTES, context);
        break;
      case 134:
        if (context.verbose > 0) {
          const flags = message[5];
          text += `\n\thop limit ${message[4]}, Flags [${flagNames(flags, [[0x80, 'managed'], [0x40, 'other stateful'], [0x20, 'home agent'], [0x02, 'ipv6 only']])}]`;
          text += `, pref ${ROUTER_PREFERENCE[(flags & 0x18) >> 3]}, router lifetime ${be16(message, 6)}s, reachable time ${be32(message, 8)}ms, retrans timer ${be32(message, 12)}ms`;
          text += optionsText(message, ROUTER_ADVERT_BYTES, context);
        }
        break;
      case 135:
        text += `, who has ${addressAt(message, 8, context)}`;
        if (context.verbose > 0) text += optionsText(message, NEIGHBOR_SOLICIT_BYTES, context);
        break;
      case 136:
        text += `, tgt is ${addressAt(message, 8, context)}`;
        if (context.verbose > 0) {
          text += `, Flags [${flagNames(be32(message, 4), [[0x80000000, 'router'], [0x40000000, 'solicited'], [0x20000000, 'override']])}]`;
          text += optionsText(message, NEIGHBOR_ADVERT_BYTES, context);
        }
        break;
      case 137:
        text += `, ${addressAt(message, 24, context)} to ${addressAt(message, 8, context)}`;
        if (context.verbose > 0) text += optionsText(message, REDIRECT_BYTES, context);
        break;
      default:
        text += `, length ${length}`;
        if (context.verbose <= 1) text += hexLines(message, '\n\t');
        return text;
    }
  }
  if (context.verbose === 0) text += `, length ${length}`;
  return text;
}

export const ICMP6_HEADER_LENGTH = ICMP6_HEADER_BYTES;
