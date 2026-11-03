import type { CaptureFrame } from './CaptureFrame';
import type { CapturePredicate } from './TcpdumpFilter';

export interface RelationOk {
  readonly ok: true;
  readonly predicate: CapturePredicate;
  readonly constant?: boolean;
  readonly next: number;
}

export interface RelationErr {
  readonly ok: false;
  readonly message: string;
}

export type RelationResult = RelationOk | RelationErr;

export class RejectPacket extends Error {
  constructor() {
    super('reject');
  }
}

const SYNTAX_ERROR = "tcpdump: can't parse filter expression: syntax error";
const MAXIMUM_NUMBER = 0xffffffff;
const ETHERTYPE_RARP = 0x8035;
const IPV6_HEADER_BYTES = 40;
const ICMPV6_PROTOCOL = 58;

type SliceProtocol = 'ether' | 'link' | 'ip' | 'ip6' | 'arp' | 'rarp' | 'tcp' | 'udp' | 'icmp' | 'icmp6' | 'igmp' | 'sctp' | 'pim' | 'vrrp' | 'carp' | 'igrp';

const IPV4_PAYLOAD_PROTOCOLS: Readonly<Record<string, number>> = {
  icmp: 1, igmp: 2, igrp: 9, tcp: 6, udp: 17, pim: 103, vrrp: 112, carp: 112, sctp: 132,
};

export const SLICE_PROTOCOLS: ReadonlySet<string> = new Set([
  'ether', 'link', 'ip', 'ip6', 'arp', 'rarp', 'icmp6', ...Object.keys(IPV4_PAYLOAD_PROTOCOLS),
]);

const UNSUPPORTED_INDEX_PROTOCOLS: ReadonlySet<string> = new Set(['ah', 'esp', 'stp', 'ipx', 'iso', 'netbeui', 'aarp']);

const NAMED_CONSTANTS: Readonly<Record<string, number>> = {
  tcpflags: 13,
  'tcp-fin': 0x01, 'tcp-syn': 0x02, 'tcp-rst': 0x04, 'tcp-push': 0x08, 'tcp-ack': 0x10, 'tcp-urg': 0x20, 'tcp-ece': 0x40, 'tcp-cwr': 0x80,
  icmptype: 0, icmpcode: 1,
  'icmp-echoreply': 0, 'icmp-unreach': 3, 'icmp-sourcequench': 4, 'icmp-redirect': 5, 'icmp-echo': 8, 'icmp-routeradvert': 9,
  'icmp-routersolicit': 10, 'icmp-timxceed': 11, 'icmp-paramprob': 12, 'icmp-tstamp': 13, 'icmp-tstampreply': 14,
  'icmp-ireq': 15, 'icmp-ireqreply': 16, 'icmp-maskreq': 17, 'icmp-maskreply': 18,
};

const COMPARATORS: ReadonlySet<string> = new Set(['=', '==', '!=', '<', '>', '<=', '>=']);
const NUMBER_PATTERN = /^(0[xX][0-9a-fA-F]+|[0-9]+)$/;

type BinaryOperator = '+' | '-' | '*' | '/' | '%' | '&' | '|' | '^' | '<<' | '>>';

type Arithmetic =
  | { readonly kind: 'constant'; readonly value: number }
  | { readonly kind: 'length' }
  | { readonly kind: 'load'; readonly protocol: SliceProtocol; readonly offset: Arithmetic; readonly size: 1 | 2 | 4 }
  | { readonly kind: 'negate'; readonly operand: Arithmetic }
  | { readonly kind: 'binary'; readonly operator: BinaryOperator; readonly left: Arithmetic; readonly right: Arithmetic };

const PRECEDENCE: Readonly<Record<string, number>> = { '|': 1, '&': 2, '<<': 3, '>>': 3, '+': 4, '-': 4, '*': 5, '/': 5 };
const UNORDERED_OPERATORS: ReadonlySet<string> = new Set(['^', '%']);

function syntaxError(): RelationErr {
  return { ok: false, message: SYNTAX_ERROR };
}

function failure(message: string): RelationErr {
  return { ok: false, message: `tcpdump: ${message}` };
}

function isErr(value: unknown): value is RelationErr {
  return typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === false;
}

export function isNumberToken(token: string): boolean {
  return NUMBER_PATTERN.test(token);
}

export function startsArithmetic(token: string | undefined): boolean {
  if (token === undefined) return false;
  if (token === '-' || token === 'len') return true;
  if (isNumberToken(token) || token in NAMED_CONSTANTS) return true;
  const bracket = token.indexOf('[');
  return bracket > 0 && (SLICE_PROTOCOLS.has(token.slice(0, bracket)) || UNSUPPORTED_INDEX_PROTOCOLS.has(token.slice(0, bracket)));
}

function numberValue(token: string): number | RelationErr {
  const value = /^0[xX]/.test(token) ? parseInt(token, 16) : /^0[0-7]*$/.test(token) ? parseInt(token, 8) : /^[0-9]+$/.test(token) ? parseInt(token, 10) : NaN;
  if (Number.isNaN(value)) return syntaxError();
  if (value > MAXIMUM_NUMBER) return failure(`number ${token} overflows 32 bits`);
  return value;
}

export function relexFilter(text: string): string[] {
  const tokens: string[] = [];
  const doubles = new Set(['&&', '||', '!=', '==', '<=', '>=', '<<', '>>']);
  const singles = new Set(['(', ')', '!', '=', '<', '>', '&', '|', '^', '+', '*', '%', '-']);
  const wordStart = /[A-Za-z0-9_.:\\]/;
  const wordPart = /[A-Za-z0-9_.:/\\-]/;
  let at = 0;
  while (at < text.length) {
    const ch = text[at];
    if (/\s/.test(ch)) {
      at++;
      continue;
    }
    const pair = text.slice(at, at + 2);
    if (doubles.has(pair)) {
      tokens.push(pair);
      at += 2;
      continue;
    }
    if (singles.has(ch)) {
      tokens.push(ch);
      at++;
      continue;
    }
    if (wordStart.test(ch)) {
      let end = at + 1;
      while (end < text.length && wordPart.test(text[end])) end++;
      const word = text.slice(at, end);
      let probe = end;
      while (probe < text.length && /\s/.test(text[probe])) probe++;
      if (text[probe] === '[' && (SLICE_PROTOCOLS.has(word) || UNSUPPORTED_INDEX_PROTOCOLS.has(word))) {
        let depth = 0;
        let close = probe;
        for (; close < text.length; close++) {
          if (text[close] === '[') depth++;
          else if (text[close] === ']' && --depth === 0) break;
        }
        if (close < text.length) {
          tokens.push(word + text.slice(probe, close + 1));
          at = close + 1;
          continue;
        }
      }
      tokens.push(word);
      at = end;
      continue;
    }
    tokens.push(ch);
    at++;
  }
  return tokens;
}

class ExpressionParser {
  constructor(private readonly tokens: readonly string[], public at: number) {}

  peek(): string | undefined {
    return this.tokens[this.at];
  }

  next(): string | undefined {
    return this.tokens[this.at++];
  }

  parseArithmetic(minimum: number): Arithmetic | RelationErr {
    let left = this.parseUnary();
    if (isErr(left)) return left;
    for (;;) {
      const operator = this.peek();
      if (operator === undefined) return left;
      if (UNORDERED_OPERATORS.has(operator)) {
        this.next();
        const right = this.parseArithmetic(0);
        if (isErr(right)) return right;
        const folded = combine(operator as BinaryOperator, left, right);
        if (isErr(folded)) return folded;
        left = folded;
        continue;
      }
      const precedence = PRECEDENCE[operator];
      if (precedence === undefined || precedence < minimum) return left;
      this.next();
      const right = this.parseArithmetic(precedence + 1);
      if (isErr(right)) return right;
      const folded = combine(operator as BinaryOperator, left, right);
      if (isErr(folded)) return folded;
      left = folded;
    }
  }

  private parseUnary(): Arithmetic | RelationErr {
    const token = this.next();
    if (token === undefined) return syntaxError();
    if (token === '-') {
      const operand = this.parseUnary();
      if (isErr(operand)) return operand;
      return operand.kind === 'constant' ? { kind: 'constant', value: (-operand.value) >>> 0 } : { kind: 'negate', operand };
    }
    if (token === '(') {
      const inner = this.parseArithmetic(0);
      if (isErr(inner)) return inner;
      if (this.next() !== ')') return syntaxError();
      return inner;
    }
    if (token === 'len') return { kind: 'length' };
    if (token in NAMED_CONSTANTS) return { kind: 'constant', value: NAMED_CONSTANTS[token] };
    if (isNumberToken(token)) {
      const value = numberValue(token);
      return typeof value === 'number' ? { kind: 'constant', value } : value;
    }
    return this.parseSlice(token);
  }

  private parseSlice(token: string): Arithmetic | RelationErr {
    const bracket = token.indexOf('[');
    if (bracket <= 0 || !token.endsWith(']')) return syntaxError();
    const name = token.slice(0, bracket);
    if (UNSUPPORTED_INDEX_PROTOCOLS.has(name)) return failure('unsupported index operation');
    if (!SLICE_PROTOCOLS.has(name)) return syntaxError();
    const inner = token.slice(bracket + 1, -1);
    let depth = 0;
    let colon = -1;
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i];
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      else if (ch === ':' && depth === 0) {
        colon = i;
        break;
      }
    }
    const offsetText = colon < 0 ? inner : inner.slice(0, colon);
    const sizeText = colon < 0 ? null : inner.slice(colon + 1).trim();
    const offsetTokens = relexFilter(offsetText);
    if (offsetTokens.length === 0) return syntaxError();
    const offsetParser = new ExpressionParser(offsetTokens, 0);
    const offset = offsetParser.parseArithmetic(0);
    if (isErr(offset)) return offset;
    if (offsetParser.at !== offsetTokens.length) return syntaxError();
    let size: 1 | 2 | 4 = 1;
    if (sizeText !== null) {
      if (!/^[0-9]+$/.test(sizeText)) return syntaxError();
      const wanted = parseInt(sizeText, 10);
      if (wanted !== 1 && wanted !== 2 && wanted !== 4) return failure('data size must be 1, 2, or 4');
      size = wanted;
    }
    return { kind: 'load', protocol: name as SliceProtocol, offset, size };
  }
}

function combine(operator: BinaryOperator, left: Arithmetic, right: Arithmetic): Arithmetic | RelationErr {
  if ((operator === '/' || operator === '%') && right.kind === 'constant' && right.value === 0) return failure('division by zero');
  if ((operator === '<<' || operator === '>>') && right.kind === 'constant' && right.value > 31) return failure('shift by more than 31 bits');
  if (left.kind === 'constant' && right.kind === 'constant') return { kind: 'constant', value: apply(operator, left.value, right.value) };
  return { kind: 'binary', operator, left, right };
}

function apply(operator: BinaryOperator, a: number, b: number): number {
  switch (operator) {
    case '+': return (a + b) >>> 0;
    case '-': return (a - b) >>> 0;
    case '*': return Math.imul(a, b) >>> 0;
    case '/': return b === 0 ? reject() : Math.floor(a / b) >>> 0;
    case '%': return b === 0 ? reject() : (a % b) >>> 0;
    case '&': return (a & b) >>> 0;
    case '|': return (a | b) >>> 0;
    case '^': return (a ^ b) >>> 0;
    case '<<': return b > 31 ? reject() : (a << b) >>> 0;
    case '>>': return b > 31 ? reject() : a >>> b;
  }
}

function reject(): never {
  throw new RejectPacket();
}

function guardOf(node: Arithmetic): SliceProtocol | null {
  switch (node.kind) {
    case 'load': return node.protocol;
    case 'negate': return guardOf(node.operand);
    case 'binary': return guardOf(node.left);
    default: return null;
  }
}

function byteAt(frame: CaptureFrame, at: number): number {
  if (at < 0 || at >= frame.raw.length) return reject();
  return frame.raw[at];
}

function wordAt(frame: CaptureFrame, at: number): number {
  return (byteAt(frame, at) << 8) | byteAt(frame, at + 1);
}

function etherTypeOf(frame: CaptureFrame): number {
  if (frame.raw.length < 14) return -1;
  return (frame.raw[12] << 8) | frame.raw[13];
}

function guardHolds(frame: CaptureFrame, protocol: SliceProtocol): boolean {
  const network = frame.rawLinkOffset;
  switch (protocol) {
    case 'ether':
    case 'link':
      return true;
    case 'ip':
      return frame.l3 === 'ipv4';
    case 'arp':
      return frame.l3 === 'arp';
    case 'rarp':
      return etherTypeOf(frame) === ETHERTYPE_RARP;
    case 'ip6':
      return frame.l3 === 'ipv6';
    case 'icmp6':
      return frame.l3 === 'ipv6' && byteAt(frame, network + 6) === ICMPV6_PROTOCOL;
    default:
      return frame.l3 === 'ipv4'
        && byteAt(frame, network + 9) === IPV4_PAYLOAD_PROTOCOLS[protocol]
        && (wordAt(frame, network + 6) & 0x1fff) === 0;
  }
}

function baseOf(frame: CaptureFrame, protocol: SliceProtocol): number {
  const network = frame.rawLinkOffset;
  switch (protocol) {
    case 'ether':
    case 'link':
      return 0;
    case 'ip':
    case 'arp':
    case 'rarp':
    case 'ip6':
      return network;
    case 'icmp6':
      return network + IPV6_HEADER_BYTES;
    default:
      return network + (byteAt(frame, network) & 0x0f) * 4;
  }
}

function evaluate(node: Arithmetic, frame: CaptureFrame): number {
  switch (node.kind) {
    case 'constant': return node.value;
    case 'length': return frame.length >>> 0;
    case 'negate': return (-evaluate(node.operand, frame)) >>> 0;
    case 'binary': return apply(node.operator, evaluate(node.left, frame), evaluate(node.right, frame));
    case 'load': {
      const at = baseOf(frame, node.protocol) + evaluate(node.offset, frame);
      let value = 0;
      for (let i = 0; i < node.size; i++) value = ((value << 8) | byteAt(frame, at + i)) >>> 0;
      return value;
    }
  }
}

function guardsHold(guards: readonly SliceProtocol[], frame: CaptureFrame): boolean {
  return guards.every((protocol) => guardHolds(frame, protocol));
}

function compare(comparator: string, actual: number, expected: number): boolean {
  switch (comparator) {
    case '=':
    case '==': return actual === expected;
    case '!=': return actual !== expected;
    case '<': return actual < expected;
    case '>': return actual > expected;
    case '<=': return actual <= expected;
    default: return actual >= expected;
  }
}

export function parseRelation(tokens: readonly string[], start: number): RelationResult {
  const parser = new ExpressionParser(tokens, start);
  const left = parser.parseArithmetic(0);
  if (isErr(left)) return left;
  const comparator = parser.next();
  if (comparator === undefined || !COMPARATORS.has(comparator)) return syntaxError();
  const right = parser.parseArithmetic(0);
  if (isErr(right)) return right;
  if (parser.peek() !== undefined && COMPARATORS.has(parser.peek()!)) return syntaxError();

  if (left.kind === 'constant' && right.kind === 'constant') {
    const holds = compare(comparator, left.value, right.value);
    return { ok: true, predicate: () => holds, constant: holds, next: parser.at };
  }
  const guards = [guardOf(left), guardOf(right)].filter((protocol): protocol is SliceProtocol => protocol !== null);
  return {
    ok: true,
    next: parser.at,
    predicate: (frame) => guardsHold(guards, frame) && compare(comparator, evaluate(left, frame), evaluate(right, frame)),
  };
}
