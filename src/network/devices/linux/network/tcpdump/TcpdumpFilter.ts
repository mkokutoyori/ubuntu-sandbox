import { IPAddress, SubnetMask, IP_PROTO_ICMP, IP_PROTO_TCP, IP_PROTO_UDP } from '@/network/core/types';
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

const ALWAYS: CapturePredicate = () => true;

function isInt(token: string): boolean {
  return /^\d+$/.test(token);
}

function portValid(token: string): number | null {
  if (!isInt(token)) return null;
  const n = parseInt(token, 10);
  if (n < 0 || n > 65535) return null;
  return n;
}

class Parser {
  private pos = 0;
  constructor(private readonly tokens: string[]) {}

  parse(): FilterResult {
    if (this.tokens.length === 0) return { ok: true, predicate: ALWAYS };
    const result = this.parseOr();
    if (!result.ok) return result;
    if (this.pos < this.tokens.length) {
      return { ok: false, message: `tcpdump: error: syntax error in filter expression near '${this.tokens[this.pos]}'` };
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
      return { ok: false, message: 'tcpdump: error: syntax error, unexpected end of filter expression' };
    }
    if (token === '(') {
      this.next();
      const inner = this.parseOr();
      if (!inner.ok) return inner;
      if (this.peek() !== ')') {
        return { ok: false, message: 'tcpdump: error: syntax error, unbalanced parentheses in filter expression' };
      }
      this.next();
      return inner;
    }
    if (token === ')') {
      return { ok: false, message: 'tcpdump: error: syntax error, unbalanced parentheses in filter expression' };
    }
    return this.parseExpression();
  }

  private parseExpression(): FilterResult {
    let dir: 'src' | 'dst' | null = null;
    if (this.peek() === 'src' || this.peek() === 'dst') {
      const lookahead = this.tokens[this.pos + 1];
      if (lookahead === 'port' || lookahead === 'net' || lookahead === 'host' || (lookahead && !isKeyword(lookahead))) {
        dir = this.next() as 'src' | 'dst';
      }
    }

    const token = this.next();
    if (token === undefined) {
      return { ok: false, message: 'tcpdump: error: syntax error in filter expression' };
    }

    switch (token) {
      case 'ip':
        return this.maybeQualifiedIp('ipv4');
      case 'ip6':
        return { ok: true, predicate: (f) => f.l3 === 'ipv6' };
      case 'arp':
        return { ok: true, predicate: (f) => f.l3 === 'arp' };
      case 'tcp':
        return this.protoOrPort((f) => f.l4 === 'tcp', dir);
      case 'udp':
        return this.protoOrPort((f) => f.l4 === 'udp', dir);
      case 'icmp':
        return this.maybeSlice((f) => f.l4 === 'icmp');
      case 'icmp6':
        return { ok: true, predicate: (f) => f.l4 === 'icmp6' };
      case 'vlan':
        return this.parseVlan();
      case 'multicast':
      case 'broadcast':
        return { ok: true, predicate: ALWAYS };
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
      case 'range':
        return this.parsePortrange(dir);
      default:
        return this.parseBareValue(token, dir);
    }
  }

  private maybeQualifiedIp(_kind: 'ipv4'): FilterResult {
    if (this.peek() === 'multicast' || this.peek() === 'broadcast') {
      this.next();
      return { ok: true, predicate: (f) => f.l3 === 'ipv4' };
    }
    if (this.peek() && this.peek()!.startsWith('ip[')) {
      return { ok: true, predicate: (f) => f.l3 === 'ipv4' };
    }
    return { ok: true, predicate: (f) => f.l3 === 'ipv4' };
  }

  private protoOrPort(base: CapturePredicate, dir: 'src' | 'dst' | null): FilterResult {
    if (this.peek() === 'port') {
      this.next();
      const port = this.parsePort(dir);
      if (!port.ok) return port;
      const p = port.predicate;
      return { ok: true, predicate: (f) => base(f) && p(f) };
    }
    if (this.peek() === 'dst' || this.peek() === 'src') {
      const d = this.next() as 'src' | 'dst';
      if (this.peek() === 'port') {
        this.next();
        if (this.peek() === 'range') {
          this.next();
          const pr = this.parsePortrange(d);
          if (!pr.ok) return pr;
          const p = pr.predicate;
          return { ok: true, predicate: (f) => base(f) && p(f) };
        }
        const port = this.parsePort(d);
        if (!port.ok) return port;
        const p = port.predicate;
        return { ok: true, predicate: (f) => base(f) && p(f) };
      }
      return { ok: false, message: 'tcpdump: error: syntax error in filter expression' };
    }
    return this.maybeSlice(base);
  }

  private maybeSlice(base: CapturePredicate): FilterResult {
    return { ok: true, predicate: base };
  }

  private parseVlan(): FilterResult {
    const nxt = this.peek();
    if (nxt !== undefined && nxt !== 'and' && nxt !== 'or' && nxt !== '&&' && nxt !== '||' && nxt !== ')') {
      if (!isInt(nxt)) {
        return { ok: false, message: `tcpdump: error: invalid vlan id '${nxt}'` };
      }
      const id = parseInt(this.next()!, 10);
      if (id < 0 || id > 4094) {
        return { ok: false, message: `tcpdump: error: vlan id ${id} out of range (0-4094)` };
      }
    }
    return { ok: true, predicate: () => false };
  }

  private parseSize(kind: 'less' | 'greater'): FilterResult {
    const value = this.next();
    if (value === undefined || !isInt(value)) {
      return { ok: false, message: `tcpdump: error: invalid length '${value ?? ''}'` };
    }
    const n = parseInt(value, 10);
    if (kind === 'less') return { ok: true, predicate: (f) => f.length <= n };
    return { ok: true, predicate: (f) => f.length >= n };
  }

  private parseProto(): FilterResult {
    const value = this.next();
    if (value === undefined) {
      return { ok: false, message: 'tcpdump: error: missing protocol number after proto' };
    }
    if (isInt(value)) {
      const n = parseInt(value, 10);
      return {
        ok: true,
        predicate: (f) => f.ipProtocol === n
          || (n === IP_PROTO_ICMP && f.l4 === 'icmp')
          || (n === IP_PROTO_TCP && f.l4 === 'tcp')
          || (n === IP_PROTO_UDP && f.l4 === 'udp'),
      };
    }
    const named: Record<string, number> = { icmp: IP_PROTO_ICMP, tcp: IP_PROTO_TCP, udp: IP_PROTO_UDP };
    if (value in named) {
      const n = named[value];
      return { ok: true, predicate: (f) => f.ipProtocol === n };
    }
    return { ok: false, message: `tcpdump: error: unknown protocol '${value}'` };
  }

  private parseEther(): FilterResult {
    let which: 'src' | 'dst' | 'host' = 'host';
    if (this.peek() === 'src' || this.peek() === 'dst' || this.peek() === 'host') {
      which = this.next() as 'src' | 'dst' | 'host';
    }
    const mac = this.next();
    if (mac === undefined || !MAC_RE.test(mac)) {
      return { ok: false, message: `tcpdump: error: invalid ethernet address '${mac ?? ''}'` };
    }
    const m = mac.toLowerCase();
    if (which === 'src') return { ok: true, predicate: (f) => f.srcMac.toLowerCase() === m };
    if (which === 'dst') return { ok: true, predicate: (f) => f.dstMac.toLowerCase() === m };
    return { ok: true, predicate: (f) => f.srcMac.toLowerCase() === m || f.dstMac.toLowerCase() === m };
  }

  private parseHost(dir: 'src' | 'dst' | null): FilterResult {
    const value = this.next();
    if (value === undefined) {
      return { ok: false, message: 'tcpdump: error: missing host address after host' };
    }
    if (value.includes(':')) {
      return { ok: true, predicate: (f) => f.srcIp === value || f.dstIp === value };
    }
    if (!IPAddress.isValid(value)) {
      return { ok: false, message: `tcpdump: error: invalid host address '${value}'` };
    }
    return { ok: true, predicate: hostPredicate(value, dir) };
  }

  private parseNet(dir: 'src' | 'dst' | null): FilterResult {
    const value = this.next();
    if (value === undefined) {
      return { ok: false, message: 'tcpdump: error: syntax error: missing network after net' };
    }
    let network: string;
    let mask: SubnetMask;
    if (value.includes('/')) {
      const [addr, cidrStr] = value.split('/');
      if (!IPAddress.isValid(addr) || !isInt(cidrStr)) {
        return { ok: false, message: `tcpdump: error: invalid network '${value}'` };
      }
      const cidr = parseInt(cidrStr, 10);
      if (cidr < 0 || cidr > 32) {
        return { ok: false, message: `tcpdump: error: invalid prefix length ${cidr}` };
      }
      network = addr;
      mask = SubnetMask.fromCIDR(cidr);
    } else if (this.peek() === 'mask') {
      this.next();
      const maskStr = this.next();
      if (!IPAddress.isValid(value) || maskStr === undefined || !IPAddress.isValid(maskStr)) {
        return { ok: false, message: `tcpdump: error: invalid network mask '${maskStr ?? ''}'` };
      }
      network = value;
      mask = new SubnetMask(maskStr);
    } else {
      if (!IPAddress.isValid(value)) {
        return { ok: false, message: `tcpdump: error: invalid network '${value}'` };
      }
      network = value;
      mask = SubnetMask.fromCIDR(24);
    }
    return { ok: true, predicate: netPredicate(network, mask, dir) };
  }

  private parsePort(dir: 'src' | 'dst' | null): FilterResult {
    const value = this.next();
    if (value === undefined) {
      return { ok: false, message: 'tcpdump: error: missing port number after port' };
    }
    const port = portValid(value);
    if (port === null) {
      if (!isInt(value)) {
        return { ok: false, message: `tcpdump: error: unknown port '${value}'` };
      }
      return { ok: false, message: `tcpdump: error: port ${value} out of range` };
    }
    if (dir === 'src') return { ok: true, predicate: (f) => f.srcPort === port };
    if (dir === 'dst') return { ok: true, predicate: (f) => f.dstPort === port };
    return { ok: true, predicate: (f) => f.srcPort === port || f.dstPort === port };
  }

  private parsePortrange(dir: 'src' | 'dst' | null): FilterResult {
    const value = this.next();
    if (value === undefined) {
      return { ok: false, message: 'tcpdump: error: missing range after portrange' };
    }
    const m = /^(\d+)-(\d+)$/.exec(value);
    if (!m) {
      return { ok: false, message: `tcpdump: error: invalid port range '${value}'` };
    }
    const lo = parseInt(m[1], 10);
    const hi = parseInt(m[2], 10);
    if (lo > 65535 || hi > 65535 || lo > hi) {
      return { ok: false, message: `tcpdump: error: invalid port range '${value}'` };
    }
    const inRange = (p: number | undefined) => p !== undefined && p >= lo && p <= hi;
    if (dir === 'src') return { ok: true, predicate: (f) => inRange(f.srcPort) };
    if (dir === 'dst') return { ok: true, predicate: (f) => inRange(f.dstPort) };
    return { ok: true, predicate: (f) => inRange(f.srcPort) || inRange(f.dstPort) };
  }

  private parseBareValue(token: string, dir: 'src' | 'dst' | null): FilterResult {
    if (token.startsWith('ip[') || token.startsWith('icmp[') || token.startsWith('tcp[') || token.startsWith('udp[')) {
      return this.parseByteSlice(token);
    }
    if (IPAddress.isValid(token)) {
      return { ok: true, predicate: hostPredicate(token, dir) };
    }
    if (token.includes(':') && token.includes('::')) {
      return { ok: true, predicate: (f) => f.srcIp === token || f.dstIp === token };
    }
    return { ok: false, message: `tcpdump: error: syntax error in filter expression near '${token}'` };
  }

  private parseByteSlice(token: string): FilterResult {
    const m = /^[a-z0-9]+\[(\d+)(?::\d+)?\]$|^[a-z0-9]+\[([a-z]+)\]$/.exec(token);
    if (m && m[1] !== undefined) {
      const offset = parseInt(m[1], 10);
      if (offset > 1500) {
        return { ok: false, message: `tcpdump: error: byte offset ${offset} out of bounds` };
      }
    }
    while (this.peek() !== undefined) {
      const t = this.peek()!;
      if (t === 'and' || t === 'or' || t === '&&' || t === '||' || t === ')') break;
      this.next();
    }
    return { ok: true, predicate: ALWAYS };
  }
}

function hostPredicate(ip: string, dir: 'src' | 'dst' | null): CapturePredicate {
  if (dir === 'src') return (f) => f.srcIp === ip || f.arpSenderIp === ip;
  if (dir === 'dst') return (f) => f.dstIp === ip || f.arpTargetIp === ip;
  return (f) =>
    f.srcIp === ip || f.dstIp === ip || f.arpSenderIp === ip || f.arpTargetIp === ip;
}

function netPredicate(network: string, mask: SubnetMask, dir: 'src' | 'dst' | null): CapturePredicate {
  const net = new IPAddress(network).networkAddress(mask);
  const matches = (ip?: string) => {
    if (!ip) return false;
    const parsed = IPAddress.tryParse(ip);
    if (!parsed) return false;
    return parsed.networkAddress(mask).equals(net);
  };
  if (dir === 'src') return (f) => matches(f.srcIp) || matches(f.arpSenderIp);
  if (dir === 'dst') return (f) => matches(f.dstIp) || matches(f.arpTargetIp);
  return (f) => matches(f.srcIp) || matches(f.dstIp) || matches(f.arpSenderIp) || matches(f.arpTargetIp);
}

const KEYWORDS = new Set([
  'ip', 'ip6', 'arp', 'tcp', 'udp', 'icmp', 'icmp6', 'vlan', 'multicast', 'broadcast',
  'less', 'greater', 'proto', 'ether', 'host', 'net', 'port', 'portrange', 'range', 'mask',
  'and', 'or', 'not', '&&', '||', '!', '(', ')', 'src', 'dst',
]);

function isKeyword(token: string): boolean {
  return KEYWORDS.has(token);
}

export function compileFilter(tokens: string[]): FilterResult {
  return new Parser(tokens).parse();
}
