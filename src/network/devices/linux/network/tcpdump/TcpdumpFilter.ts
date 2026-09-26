import { IPAddress, IP_PROTO_ICMP, IP_PROTO_TCP, IP_PROTO_UDP } from '@/network/core/types';
import { isMulticastIpv4 } from '@/network/core/ip';
import type { CaptureFrame } from './CaptureFrame';

export type CapturePredicate = (f: CaptureFrame) => boolean;

export interface FilterOk {
  ok: true;
  predicate: CapturePredicate;
}
export interface FilterErr {
  ok: false;
  message: string;
}
export type FilterResult = FilterOk | FilterErr;

const MAC_RE = /^[0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){5}$/;

const SYNTAX_ERROR = "tcpdump: can't parse filter expression: syntax error";
const MAXIMUM_VLAN_TAG = 4095;
const MAXIMUM_PORT = 65535;

export interface FilterNames {
  servicePort(name: string, protocol?: 'tcp' | 'udp'): number | null;
  hostAddress(name: string): string | null;
  protocolNumber(name: string): number | null;
  networkNumber(name: string): string | null;
}

function syntaxError(): FilterErr {
  return { ok: false, message: SYNTAX_ERROR };
}

function failure(message: string): FilterErr {
  return { ok: false, message: `tcpdump: ${message}` };
}

interface NetworkNumber {
  value: number;
  bits: number;
}

const DOTTED_NUMBER = /^\d+(\.\d+){0,3}$/;

function networkNumberOf(token: string): NetworkNumber | null {
  if (!DOTTED_NUMBER.test(token)) return null;
  const parts = token.split('.');
  if (parts.some((p) => Number(p) > 255)) return null;
  let value = 0;
  for (const part of parts) value = value * 256 + Number(part);
  return { value: value * 2 ** (8 * (4 - parts.length)), bits: 8 * parts.length };
}

function dottedOf(value: number): string {
  return [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256).join('.');
}

function maskValueOf(bits: number): number {
  return bits === 0 ? 0 : (0xffffffff - (2 ** (32 - bits) - 1));
}

const ALWAYS: CapturePredicate = () => true;

function isMulticastMac(mac: string | undefined): boolean {
  if (!mac) return false;
  const firstByte = parseInt(mac.split(':')[0] ?? '00', 16);
  return (firstByte & 0x01) === 1;
}

function isBroadcastMac(mac: string | undefined): boolean {
  return (mac ?? '').toLowerCase() === 'ff:ff:ff:ff:ff:ff';
}

function isMulticastIp(ip: string | undefined): boolean {
  if (!ip) return false;
  if (ip.includes(':')) return ip.toLowerCase().startsWith('ff');
  return isMulticastIpv4(ip);
}

function isBroadcastIp(ip: string | undefined): boolean {
  return ip === '255.255.255.255';
}

const IS_MULTICAST: CapturePredicate = (f) => isMulticastMac(f.dstMac) || isMulticastIp(f.dstIp);
const IS_BROADCAST: CapturePredicate = (f) => isBroadcastMac(f.dstMac) || isBroadcastIp(f.dstIp);

function isInt(token: string): boolean {
  return /^\d+$/.test(token);
}

class Parser {
  private pos = 0;
  constructor(private readonly tokens: string[], private readonly names?: FilterNames) {}

  parse(): FilterResult {
    if (this.tokens.length === 0) return { ok: true, predicate: ALWAYS };
    const result = this.parseOr();
    if (!result.ok) return result;
    if (this.pos < this.tokens.length) {
      return syntaxError();
    }
    return result;
  }

  private peek(): string | undefined {
    return this.tokens[this.pos];
  }

  private next(): string | undefined {
    return this.tokens[this.pos++];
  }

  private parseOr(): FilterResult {
    let left = this.parseAnd();
    if (!left.ok) return left;
    while (this.peek() === 'or' || this.peek() === '||') {
      this.next();
      const right = this.parseAnd();
      if (!right.ok) return right;
      const l = left.predicate;
      const r = right.predicate;
      left = { ok: true, predicate: (f) => l(f) || r(f) };
    }
    return left;
  }

  private parseAnd(): FilterResult {
    let left = this.parseNot();
    if (!left.ok) return left;
    while (this.peek() === 'and' || this.peek() === '&&') {
      this.next();
      const right = this.parseNot();
      if (!right.ok) return right;
      const l = left.predicate;
      const r = right.predicate;
      left = { ok: true, predicate: (f) => l(f) && r(f) };
    }
    return left;
  }

  private parseNot(): FilterResult {
    if (this.peek() === 'not' || this.peek() === '!') {
      this.next();
      const inner = this.parseNot();
      if (!inner.ok) return inner;
      const p = inner.predicate;
      return { ok: true, predicate: (f) => !p(f) };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): FilterResult {
    const token = this.peek();
    if (token === undefined) {
      return syntaxError();
    }
    if (token === '(') {
      this.next();
      const inner = this.parseOr();
      if (!inner.ok) return inner;
      if (this.peek() !== ')') {
        return syntaxError();
      }
      this.next();
      return inner;
    }
    if (token === ')') {
      return syntaxError();
    }
    return this.parseExpression();
  }

  private parseExpression(): FilterResult {
    let dir: 'src' | 'dst' | null = null;
    if (this.peek() === 'src' || this.peek() === 'dst') {
      const lookahead = this.tokens[this.pos + 1];
      if (lookahead === 'port' || lookahead === 'portrange' || lookahead === 'net' || lookahead === 'host' || (lookahead && !isKeyword(lookahead))) {
        dir = this.next() as 'src' | 'dst';
      }
    }

    const token = this.next();
    if (token === undefined) {
      return syntaxError();
    }

    switch (token) {
      case 'ip':
        return this.maybeQualifiedIp('ipv4');
      case 'ip6':
        return { ok: true, predicate: (f) => f.l3 === 'ipv6' };
      case 'arp':
        return { ok: true, predicate: (f) => f.l3 === 'arp' };
      case 'tcp':
        return this.protoOrPort((f) => f.l4 === 'tcp', dir, 'tcp');
      case 'udp':
        return this.protoOrPort((f) => f.l4 === 'udp', dir, 'udp');
      case 'icmp':
        return this.maybeSlice((f) => f.l4 === 'icmp');
      case 'icmp6':
        return { ok: true, predicate: (f) => f.l4 === 'icmp6' };
      case 'vlan':
        return this.parseVlan();
      case 'multicast':
        return { ok: true, predicate: IS_MULTICAST };
      case 'broadcast':
        return { ok: true, predicate: IS_BROADCAST };
      case 'less':
        return this.parseSize('less');
      case 'greater':
        return this.parseSize('greater');
      case 'proto':
        return this.parseProto();
      case 'ether':
        return this.parseEther();
      case 'host':
        return this.parseHost(dir);
      case 'net':
        return this.parseNet(dir);
      case 'port':
        return this.parsePort(dir);
      case 'portrange':
        return this.parsePortrange(dir);
      default:
        return this.parseBareValue(token, dir);
    }
  }

  private maybeQualifiedIp(_kind: 'ipv4'): FilterResult {
    if (this.peek() === 'multicast') {
      this.next();
      return { ok: true, predicate: (f) => f.l3 === 'ipv4' && IS_MULTICAST(f) };
    }
    if (this.peek() === 'broadcast') {
      this.next();
      return { ok: true, predicate: (f) => f.l3 === 'ipv4' && IS_BROADCAST(f) };
    }
    const next = this.peek();
    if (next === 'proto' || next === 'host' || next === 'net' || next === 'src' || next === 'dst') {
      const qualified = this.parseExpression();
      if (!qualified.ok) return qualified;
      const q = qualified.predicate;
      return { ok: true, predicate: (f) => f.l3 === 'ipv4' && q(f) };
    }
    return { ok: true, predicate: (f) => f.l3 === 'ipv4' };
  }

  private protoOrPort(base: CapturePredicate, dir: 'src' | 'dst' | null, protocol: 'tcp' | 'udp'): FilterResult {
    let direction = dir;
    const qualified = this.peek() === 'src' || this.peek() === 'dst';
    const after = qualified ? this.tokens[this.pos + 1] : this.peek();
    if (after !== 'port' && after !== 'portrange') {
      return qualified ? syntaxError() : this.maybeSlice(base);
    }
    if (qualified) direction = this.next() as 'src' | 'dst';
    const keyword = this.next();
    const ports = keyword === 'port'
      ? this.parsePort(direction, protocol)
      : this.parsePortrange(direction, protocol);
    if (!ports.ok) return ports;
    const p = ports.predicate;
    return { ok: true, predicate: (f) => base(f) && p(f) };
  }

  private maybeSlice(base: CapturePredicate): FilterResult {
    return { ok: true, predicate: base };
  }

  private parseVlan(): FilterResult {
    const nxt = this.peek();
    if (nxt !== undefined && nxt !== 'and' && nxt !== 'or' && nxt !== '&&' && nxt !== '||' && nxt !== ')') {
      if (!isInt(nxt)) return syntaxError();
      const id = parseInt(this.next()!, 10);
      if (id > MAXIMUM_VLAN_TAG) {
        return failure(`VLAN tag ${id} greater than maximum ${MAXIMUM_VLAN_TAG}`);
      }
      return { ok: true, predicate: (f) => f.vlanId === id };
    }
    return { ok: true, predicate: (f) => f.vlanId !== undefined };
  }

  private parseSize(kind: 'less' | 'greater'): FilterResult {
    const value = this.next();
    if (value === undefined || !isInt(value)) return syntaxError();
    const n = parseInt(value, 10);
    if (kind === 'less') return { ok: true, predicate: (f) => f.length <= n };
    return { ok: true, predicate: (f) => f.length >= n };
  }

  private parseProto(): FilterResult {
    const value = this.next();
    if (value === undefined || isKeyword(value)) return syntaxError();
    let n: number | null;
    if (isInt(value)) {
      n = parseInt(value, 10);
    } else {
      const name = value.startsWith('\\') ? value.slice(1) : value;
      n = this.names?.protocolNumber(name) ?? null;
      if (n === null) return failure(`unknown ip proto '${name}'`);
    }
    const protocol = n;
    return {
      ok: true,
      predicate: (f) => f.ipProtocol === protocol
        || (protocol === IP_PROTO_ICMP && f.l4 === 'icmp')
        || (protocol === IP_PROTO_TCP && f.l4 === 'tcp')
        || (protocol === IP_PROTO_UDP && f.l4 === 'udp'),
    };
  }

  private parseEther(): FilterResult {
    let which: 'src' | 'dst' | 'host' = 'host';
    if (this.peek() === 'src' || this.peek() === 'dst' || this.peek() === 'host') {
      which = this.next() as 'src' | 'dst' | 'host';
    }
    const mac = this.next();
    if (mac === undefined || isKeyword(mac)) return syntaxError();
    if (!MAC_RE.test(mac)) {
      return failure(mac.includes(':') ? `bogus ethernet address ${mac}` : `unknown ether host: ${mac}`);
    }
    const m = mac.toLowerCase();
    if (which === 'src') return { ok: true, predicate: (f) => f.srcMac.toLowerCase() === m };
    if (which === 'dst') return { ok: true, predicate: (f) => f.dstMac.toLowerCase() === m };
    return { ok: true, predicate: (f) => f.srcMac.toLowerCase() === m || f.dstMac.toLowerCase() === m };
  }

  private parseHost(dir: 'src' | 'dst' | null): FilterResult {
    const value = this.next();
    if (value === undefined || isKeyword(value)) return syntaxError();
    return this.hostByName(value, dir);
  }

  private hostByName(value: string, dir: 'src' | 'dst' | null): FilterResult {
    if (value.includes(':')) {
      return { ok: true, predicate: (f) => f.srcIp === value || f.dstIp === value };
    }
    if (DOTTED_NUMBER.test(value)) {
      const number = networkNumberOf(value);
      if (number === null) return failure(`invalid IPv4 address '${value}'`);
      return { ok: true, predicate: netPredicate(dottedOf(number.value), maskValueOf(number.bits), dir) };
    }
    const address = this.names?.hostAddress(value) ?? null;
    if (address === null) return failure(`unknown host '${value}'`);
    return { ok: true, predicate: hostPredicate(address, dir) };
  }

  private parseNet(dir: 'src' | 'dst' | null): FilterResult {
    const value = this.next();
    if (value === undefined || isKeyword(value)) return syntaxError();
    const [addressText, lengthText] = value.split('/');
    const numeric = DOTTED_NUMBER.test(addressText);
    const named = numeric ? null : this.names?.networkNumber(addressText) ?? null;
    if (!numeric && named === null) return failure(`unknown network '${addressText}'`);
    const number = networkNumberOf(named ?? addressText);
    if (number === null) return failure(`invalid IPv4 address '${addressText}'`);
    let bits = number.bits;
    let maskValue = maskValueOf(bits);
    let shown = value;
    if (lengthText !== undefined) {
      if (!isInt(lengthText)) return syntaxError();
      bits = parseInt(lengthText, 10);
      if (bits > 32) return failure('mask length must be <= 32');
      maskValue = maskValueOf(bits);
    } else if (this.peek() === 'mask') {
      this.next();
      const maskText = this.next();
      if (maskText === undefined || isKeyword(maskText)) return syntaxError();
      if (!DOTTED_NUMBER.test(maskText)) return syntaxError();
      const maskNumber = networkNumberOf(maskText);
      if (maskNumber === null) return failure(`invalid IPv4 address '${maskText}'`);
      maskValue = maskNumber.value;
      shown = `${value} mask ${maskText}`;
    }
    const networkValue = number.value;
    if (((networkValue & ~maskValue) >>> 0) !== 0) {
      return failure(lengthText !== undefined
        ? `non-network bits set in "${addressText}/${bits}"`
        : `non-network bits set in "${shown}"`);
    }
    return { ok: true, predicate: netPredicate(dottedOf(networkValue), maskValue >>> 0, dir) };
  }

  private parsePort(dir: 'src' | 'dst' | null, protocol?: 'tcp' | 'udp'): FilterResult {
    const value = this.next();
    if (value === undefined || isKeyword(value)) return syntaxError();
    const port = this.portNumberOf(value, protocol);
    if (typeof port === 'string') return failure(port);
    if (dir === 'src') return { ok: true, predicate: (f) => f.srcPort === port };
    if (dir === 'dst') return { ok: true, predicate: (f) => f.dstPort === port };
    return { ok: true, predicate: (f) => f.srcPort === port || f.dstPort === port };
  }

  private portNumberOf(value: string, protocol?: 'tcp' | 'udp'): number | string {
    if (isInt(value)) {
      const n = parseInt(value, 10);
      return n > MAXIMUM_PORT ? `illegal port number ${n} > ${MAXIMUM_PORT}` : n;
    }
    const named = this.names?.servicePort(value, protocol) ?? null;
    return named === null ? `unknown port '${value}'` : named;
  }

  private parsePortrange(dir: 'src' | 'dst' | null, protocol?: 'tcp' | 'udp'): FilterResult {
    const value = this.next();
    if (value === undefined || isKeyword(value)) return syntaxError();
    const bounds = /^([^-]+)-([^-]+)$/.exec(value);
    if (!bounds) return failure(`unknown port in range '${value}'`);
    const first = this.portNumberOf(bounds[1], protocol);
    const second = this.portNumberOf(bounds[2], protocol);
    if (typeof first === 'string' && !isInt(bounds[1])) return failure(`unknown port in range '${value}'`);
    if (typeof second === 'string' && !isInt(bounds[2])) return failure(`unknown port in range '${value}'`);
    if (typeof first === 'string') return failure(first);
    if (typeof second === 'string') return failure(second);
    const lo = Math.min(first, second);
    const hi = Math.max(first, second);
    const inRange = (p: number | undefined) => p !== undefined && p >= lo && p <= hi;
    if (dir === 'src') return { ok: true, predicate: (f) => inRange(f.srcPort) };
    if (dir === 'dst') return { ok: true, predicate: (f) => inRange(f.dstPort) };
    return { ok: true, predicate: (f) => inRange(f.srcPort) || inRange(f.dstPort) };
  }

  private parseBareValue(token: string, dir: 'src' | 'dst' | null): FilterResult {
    if (/^(ip|arp|tcp|udp|icmp)\[/.test(token)) return this.parseByteSlice(token);
    if (isKeyword(token) || /[[\]&|=<>!]/.test(token)) return syntaxError();
    return this.hostByName(token, dir);
  }

  private parseByteSlice(token: string): FilterResult {
    const spec = parseByteSliceSpec(token);
    if (spec === null) return syntaxError();

    let mask: number | null = null;
    if (this.peek() === '&') {
      this.next();
      const maskTok = this.next();
      const maskVal = maskTok === undefined ? null : resolveByteSliceValue(maskTok);
      if (maskVal === null) return syntaxError();
      mask = maskVal;
    }

    const cmpTok = this.peek();
    if (cmpTok === undefined || !COMPARATORS.has(cmpTok)) {
      return { ok: true, predicate: (f) => readByteSliceValue(f, spec) !== null };
    }
    this.next();
    const value = this.parseByteSliceValue();
    if (value === null) return syntaxError();
    return {
      ok: true,
      predicate: (f) => {
        const raw = readByteSliceValue(f, spec);
        if (raw === null) return false;
        return compareByteSliceValue(mask !== null ? raw & mask : raw, cmpTok, value);
      },
    };
  }

  private parseByteSliceValue(): number | null {
    if (this.peek() === '(') {
      this.next();
      const orTok = this.next();
      if (orTok === undefined) return null;
      let combined = 0;
      for (const part of orTok.split('|')) {
        const v = resolveByteSliceValue(part);
        if (v === null) return null;
        combined |= v;
      }
      if (this.peek() !== ')') return null;
      this.next();
      return combined;
    }
    const tok = this.next();
    return tok === undefined ? null : resolveByteSliceValue(tok);
  }
}

interface ByteSliceSpec {
  proto: 'ip' | 'arp' | 'tcp' | 'udp' | 'icmp';
  offset: number;
  length: number;
}

const SYMBOLIC_FIELD_OFFSET: Record<string, { proto: ByteSliceSpec['proto']; offset: number }> = {
  tcpflags: { proto: 'tcp', offset: 13 },
  icmptype: { proto: 'icmp', offset: 0 },
  icmpcode: { proto: 'icmp', offset: 1 },
};

const BPF_NAMED_CONSTANTS: Record<string, number> = {
  'tcp-fin': 0x01,
  'tcp-syn': 0x02,
  'tcp-rst': 0x04,
  'tcp-push': 0x08,
  'tcp-ack': 0x10,
  'tcp-urg': 0x20,
  'icmp-echoreply': 0,
  'icmp-unreach': 3,
  'icmp-sourcequench': 4,
  'icmp-redirect': 5,
  'icmp-echo': 8,
  'icmp-routeradvert': 9,
  'icmp-routersolicit': 10,
  'icmp-timxceed': 11,
  'icmp-paramprob': 12,
  'icmp-tstamp': 13,
  'icmp-tstampreply': 14,
};

const COMPARATORS = new Set(['=', '==', '!=', '<', '>', '<=', '>=']);

function parseByteSliceSpec(token: string): ByteSliceSpec | null {
  const numeric = /^(ip|arp|tcp|udp|icmp)\[(\d+)(?::([124]))?\]$/.exec(token);
  if (numeric) {
    return {
      proto: numeric[1] as ByteSliceSpec['proto'],
      offset: parseInt(numeric[2], 10),
      length: numeric[3] ? parseInt(numeric[3], 10) : 1,
    };
  }
  const symbolic = /^(ip|arp|tcp|udp|icmp)\[([a-z]+)\]$/.exec(token);
  if (symbolic) {
    const field = SYMBOLIC_FIELD_OFFSET[symbolic[2]];
    if (!field || field.proto !== symbolic[1]) return null;
    return { proto: field.proto, offset: field.offset, length: 1 };
  }
  return null;
}

function resolveByteSliceValue(token: string): number | null {
  if (token in BPF_NAMED_CONSTANTS) return BPF_NAMED_CONSTANTS[token];
  if (/^0x[0-9a-fA-F]+$/.test(token)) return parseInt(token, 16);
  if (/^\d+$/.test(token)) return parseInt(token, 10);
  return null;
}

function byteSliceProtoMatches(frame: CaptureFrame, proto: ByteSliceSpec['proto']): boolean {
  if (proto === 'ip') return frame.l3 === 'ipv4' || frame.l3 === 'ipv6';
  if (proto === 'arp') return frame.l3 === 'arp';
  if (proto === 'icmp') return frame.l4 === 'icmp' || frame.l4 === 'icmp6';
  return frame.l4 === proto;
}

function readByteSliceValue(frame: CaptureFrame, spec: ByteSliceSpec): number | null {
  if (!byteSliceProtoMatches(frame, spec.proto)) return null;
  const base = spec.proto === 'ip' || spec.proto === 'arp'
    ? frame.rawLinkOffset
    : frame.rawLinkOffset + (frame.ipHeaderLen ?? 20);
  const abs = base + spec.offset;
  if (abs < 0 || abs + spec.length > frame.raw.length) return null;
  let value = 0;
  for (let i = 0; i < spec.length; i++) value = (value << 8) | frame.raw[abs + i];
  return value >>> 0;
}

function compareByteSliceValue(actual: number, comparator: string, expected: number): boolean {
  switch (comparator) {
    case '=':
    case '==': return actual === expected;
    case '!=': return actual !== expected;
    case '<': return actual < expected;
    case '>': return actual > expected;
    case '<=': return actual <= expected;
    case '>=': return actual >= expected;
    default: return false;
  }
}

function hostPredicate(ip: string, dir: 'src' | 'dst' | null): CapturePredicate {
  if (dir === 'src') return (f) => f.srcIp === ip || f.arpSenderIp === ip;
  if (dir === 'dst') return (f) => f.dstIp === ip || f.arpTargetIp === ip;
  return (f) =>
    f.srcIp === ip || f.dstIp === ip || f.arpSenderIp === ip || f.arpTargetIp === ip;
}

function ipv4Value(ip: string | undefined): number | null {
  if (!ip || !IPAddress.isValid(ip)) return null;
  return networkNumberOf(ip)?.value ?? null;
}

function netPredicate(network: string, mask: number, dir: 'src' | 'dst' | null): CapturePredicate {
  const net = ipv4Value(network)!;
  const matches = (ip?: string) => {
    const value = ipv4Value(ip);
    return value !== null && ((value & mask) >>> 0) === net;
  };
  if (dir === 'src') return (f) => matches(f.srcIp) || matches(f.arpSenderIp);
  if (dir === 'dst') return (f) => matches(f.dstIp) || matches(f.arpTargetIp);
  return (f) => matches(f.srcIp) || matches(f.dstIp) || matches(f.arpSenderIp) || matches(f.arpTargetIp);
}

const KEYWORDS = new Set([
  'ip', 'ip6', 'arp', 'tcp', 'udp', 'icmp', 'icmp6', 'vlan', 'multicast', 'broadcast',
  'less', 'greater', 'proto', 'ether', 'host', 'net', 'port', 'portrange', 'mask',
  'and', 'or', 'not', '&&', '||', '!', '(', ')', 'src', 'dst',
]);

function isKeyword(token: string): boolean {
  return KEYWORDS.has(token);
}

export function compileFilter(tokens: string[], names?: FilterNames): FilterResult {
  return new Parser(tokens, names).parse();
}
