import { IPv6Address } from '@/network/core/types';
import { tryIpToUint32 } from '@/network/core/ip';
import {
  AF, DB, SsError, SsFilter, type HostCondition, type SsExpression,
} from './SsModel';

export interface SsParseEnvironment {
  servicePort(name: string, protocol: 'tcp' | 'udp'): number | null;
  hostAddresses(name: string): readonly string[];
  interfaceIndex(name: string): number | null;
}

export interface SsEndpoint {
  readonly family: number;
  readonly address: Uint8Array;
  readonly port: number;
}

export interface SsFilterSubject {
  readonly local: SsEndpoint;
  readonly remote: SsEndpoint;
  readonly interfaceIndex: number;
  readonly mark: number;
}

const ADDRESS_BYTES = 16;

export function addressBytes(text: string): { family: number; bytes: Uint8Array } | null {
  const bytes = new Uint8Array(ADDRESS_BYTES);
  if (text.includes(':')) {
    const parsed = IPv6Address.tryParse(text);
    if (parsed === null) return null;
    parsed.getHextets().forEach((hextet, index) => {
      bytes[index * 2] = hextet >> 8;
      bytes[index * 2 + 1] = hextet & 0xff;
    });
    return { family: AF.INET6, bytes };
  }
  const value = tryIpToUint32(text);
  if (value === null) return null;
  bytes[0] = (value >>> 24) & 0xff;
  bytes[1] = (value >>> 16) & 0xff;
  bytes[2] = (value >>> 8) & 0xff;
  bytes[3] = value & 0xff;
  return { family: AF.INET, bytes };
}

function bitsMatch(left: Uint8Array, right: Uint8Array, bits: number): boolean {
  const whole = bits >> 3;
  for (let index = 0; index < whole; index++) {
    if (left[index] !== right[index]) return false;
  }
  const rest = bits & 7;
  if (rest === 0) return true;
  const mask = (0xff << (8 - rest)) & 0xff;
  return ((left[whole] ^ right[whole]) & mask) === 0;
}

function isV4Mapped(address: Uint8Array): boolean {
  for (let index = 0; index < 10; index++) if (address[index] !== 0) return false;
  return address[10] === 0xff && address[11] === 0xff;
}

function addressMatches(socket: SsEndpoint, pattern: HostCondition): boolean {
  if (bitsMatch(socket.address, pattern.address, pattern.bits)) return true;
  if (pattern.family === AF.INET && socket.family === AF.INET6 && isV4Mapped(socket.address)) {
    const embedded = new Uint8Array(ADDRESS_BYTES);
    embedded.set(socket.address.subarray(12, 16));
    return bitsMatch(embedded, pattern.address, pattern.bits);
  }
  return false;
}

function conditionMatches(endpoint: SsEndpoint, conditions: readonly HostCondition[]): boolean {
  const first = conditions[0];
  if (first.family === AF.UNIX) return false;
  if (first.port !== -1 && first.port !== endpoint.port) return false;
  if (first.bits === 0) return true;
  return conditions.some((condition) => addressMatches(endpoint, condition));
}

export function evaluateExpression(
  expression: SsExpression, subject: SsFilterSubject, isEphemeral: (port: number) => boolean,
): boolean {
  switch (expression.type) {
    case 'autobound': return isEphemeral(subject.local.port);
    case 'destination': return conditionMatches(subject.remote, expression.conditions);
    case 'source': return conditionMatches(subject.local, expression.conditions);
    case 'destination-port-at-least': return subject.remote.port >= expression.port;
    case 'destination-port-at-most': return subject.remote.port <= expression.port;
    case 'source-port-at-least': return subject.local.port >= expression.port;
    case 'source-port-at-most': return subject.local.port <= expression.port;
    case 'device': return subject.interfaceIndex === expression.index;
    case 'mark': return ((subject.mark & expression.mask) >>> 0) === (expression.mark >>> 0);
    case 'and':
      return evaluateExpression(expression.left, subject, isEphemeral)
        && evaluateExpression(expression.right, subject, isEphemeral);
    case 'or':
      return evaluateExpression(expression.left, subject, isEphemeral)
        || evaluateExpression(expression.right, subject, isEphemeral);
    case 'not': return !evaluateExpression(expression.operand, subject, isEphemeral);
  }
}

function splitTokens(words: readonly string[]): string[] {
  const tokens: string[] = [];
  for (const word of words) {
    let current = '';
    let present = false;
    for (let index = 0; index < word.length; index++) {
      const character = word[index];
      if (character === ' ' || character === '\t') {
        if (present) tokens.push(current);
        current = '';
        present = false;
        continue;
      }
      if (character === '\\' && index + 1 < word.length) {
        index++;
        current += word[index];
      } else {
        current += character;
      }
      present = true;
    }
    if (present) tokens.push(current);
  }
  return tokens;
}

function parseInteger(text: string): number | null {
  if (!/^[+-]?(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)$/.test(text)) return null;
  const value = Number(text.startsWith('0') && text.length > 1 && !/^0[xX]/.test(text)
    ? parseInt(text, 8) : text);
  return Number.isFinite(value) ? value : null;
}

function netmaskBits(text: string, limit: number): number | null {
  const value = parseInteger(text);
  if (value !== null && /^\d+$/.test(text)) return value <= limit ? value : null;
  const parsed = addressBytes(text);
  if (parsed === null || parsed.family !== AF.INET) return null;
  let bits = 0;
  let seenZero = false;
  for (const byte of parsed.bytes.subarray(0, 4)) {
    for (let position = 7; position >= 0; position--) {
      if (((byte >> position) & 1) === 1) {
        if (seenZero) return null;
        bits++;
      } else {
        seenZero = true;
      }
    }
  }
  return bits <= limit ? bits : null;
}

interface ParsedPrefix {
  readonly family: number;
  readonly address: Uint8Array;
  readonly bits: number;
}

function parsePrefix(text: string, family: number): ParsedPrefix | null {
  if (text === 'default' || text === 'any' || text === 'all') {
    return { family, address: new Uint8Array(ADDRESS_BYTES), bits: 0 };
  }
  const slash = text.indexOf('/');
  const host = slash < 0 ? text : text.slice(0, slash);
  const parsed = addressBytes(host);
  if (parsed === null) return null;
  if (family !== AF.UNSPEC && family !== parsed.family) return null;
  const limit = parsed.family === AF.INET6 ? 128 : 32;
  if (slash < 0) return { family: parsed.family, address: parsed.bytes, bits: limit };
  const bits = netmaskBits(text.slice(slash + 1), limit);
  return bits === null ? null : { family: parsed.family, address: parsed.bytes, bits };
}

export interface SsFilterParseContext {
  readonly filter: SsFilter;
  readonly environment: SsParseEnvironment;
}

function conditionFromName(
  host: string, family: number, port: number, context: SsFilterParseContext,
): HostCondition[] {
  const conditions: HostCondition[] = [];
  for (const address of context.environment.hostAddresses(host)) {
    const parsed = addressBytes(address);
    if (parsed === null) continue;
    if (family !== AF.UNSPEC && family !== parsed.family) continue;
    conditions.push({
      family: parsed.family, address: parsed.bytes, bits: parsed.family === AF.INET6 ? 128 : 32, port,
    });
  }
  return conditions;
}

function hostFailure(message: string): SsError {
  return new SsError(`${message}Cannot parse dst/src address.\n`, 1);
}

function resolvePort(text: string, context: SsFilterParseContext): number {
  const numeric = parseInteger(text);
  if (numeric !== null) return numeric;
  const wantsUdp = (context.filter.databases & (1 << DB.UDP)) !== 0;
  const wantsTcp = (context.filter.databases & (1 << DB.TCP)) !== 0;
  const udp = wantsUdp ? context.environment.servicePort(text, 'udp') : null;
  const tcp = wantsTcp ? context.environment.servicePort(text, 'tcp') : null;
  if (udp !== null && tcp !== null && udp !== tcp) {
    throw hostFailure(`Error: ambiguous port "${text}".\n`);
  }
  const port = udp ?? tcp;
  if (port === null) throw hostFailure(`Error: "${text}" does not look like a port.\n`);
  return port;
}

function parseHostCondition(
  token: string, isPort: boolean, context: SsFilterParseContext,
): HostCondition[] {
  let text = token;
  let family: number = context.filter.preferredFamily;
  const prefixes: ReadonlyArray<readonly [string, number]> = [
    ['unix:', AF.UNIX], ['link:', AF.PACKET], ['netlink:', AF.NETLINK], ['vsock:', AF.VSOCK],
    ['inet:', AF.INET], ['inet6:', AF.INET6],
  ];
  for (const [prefix, prefixFamily] of prefixes) {
    if (text.startsWith(prefix)) {
      family = prefixFamily;
      text = text.slice(prefix.length);
      break;
    }
  }
  const restrictFamilies = (): void => {
    if (family === AF.UNSPEC) return;
    const states = context.filter.states;
    context.filter.families = 0n;
    context.filter.setFamily(family);
    context.filter.setStates(states);
  };
  const noAddress = new Uint8Array(ADDRESS_BYTES);
  if (family === AF.UNIX || family === AF.PACKET || family === AF.NETLINK || family === AF.VSOCK) {
    const colon = text.lastIndexOf(':');
    const portText = isPort ? text : colon < 0 ? null : text.slice(colon + 1);
    const port = portText === null || portText === '' || portText === '*' ? -1 : parseInteger(portText) ?? -1;
    restrictFamilies();
    return [{ family, address: noAddress, bits: family === AF.UNIX ? 8 * text.length : 0, port }];
  }

  let host = text;
  let portText: string | null = null;
  if (host.startsWith('[')) {
    const close = host.indexOf(']');
    if (close < 0) throw hostFailure('');
    portText = host.slice(close + 1);
    host = host.slice(1, close);
  } else if (host.startsWith('*')) {
    portText = host.slice(1);
    host = '';
  } else {
    const searchFrom = host.includes('/') ? host.indexOf('/') : 0;
    const colon = host.lastIndexOf(':');
    if (colon >= searchFrom) {
      portText = host.slice(colon);
      host = host.slice(0, colon);
    }
  }
  if (isPort) {
    portText = text;
    host = '';
  }
  let port = -1;
  if (portText !== null && portText !== '') {
    const digits = portText.startsWith(':') ? portText.slice(1) : portText;
    if (digits !== '' && digits !== '*') port = resolvePort(digits, context);
  }
  let conditions: HostCondition[] = [{ family: AF.UNSPEC, address: noAddress, bits: 0, port }];
  if (!isPort && host !== '' && host !== '*') {
    const prefix = parsePrefix(host, family);
    if (prefix !== null) {
      conditions = [{ ...prefix, port }];
    } else {
      conditions = conditionFromName(host, family, port, context);
      if (conditions.length === 0) {
        throw hostFailure(`Error: an inet prefix is expected rather than "${host}".\n`);
      }
    }
  }
  restrictFamilies();
  return conditions;
}

type Token =
  | { readonly kind: 'end' }
  | { readonly kind: 'not' | 'and' | 'or' | 'open' | 'close' | 'ge' | 'le' | 'ne' | 'equals' | 'gt' | 'lt' | 'autobound' }
  | { readonly kind: 'keyword'; readonly word: 'dst' | 'src' | 'dport' | 'sport' | 'dev' | 'fwmark' | 'cgroup' }
  | { readonly kind: 'host'; readonly conditions: readonly HostCondition[] }
  | { readonly kind: 'device'; readonly index: number }
  | { readonly kind: 'markmask'; readonly mark: number; readonly mask: number };

const SYNTAX_ERROR = (): SsError => new SsError(
  'ss: bison bellows (while parsing filter): "syntax error!" Sorry.\n', 255);

class Lexer {
  private position = 0;
  private context: 'dst' | 'src' | 'dport' | 'sport' | 'dev' | 'fwmark' | 'cgroup' | 'autobound' | null = null;
  private lookahead: Token | null = null;

  constructor(private readonly tokens: readonly string[], private readonly parse: SsFilterParseContext) {}

  peek(): Token {
    if (this.lookahead === null) this.lookahead = this.lex();
    return this.lookahead;
  }

  next(): Token {
    const token = this.peek();
    this.lookahead = null;
    return token;
  }

  private lex(): Token {
    if (this.position >= this.tokens.length) return { kind: 'end' };
    const word = this.tokens[this.position++];
    switch (word) {
      case '!': case 'not': return { kind: 'not' };
      case '&': case '&&': case 'and': return { kind: 'and' };
      case '|': case '||': case 'or': return { kind: 'or' };
      case '(': return { kind: 'open' };
      case ')': return { kind: 'close' };
      case '>=': case 'ge': case 'geq': return { kind: 'ge' };
      case '<=': case 'le': case 'leq': return { kind: 'le' };
      case '!=': case 'ne': case 'neq': return { kind: 'ne' };
      case '=': case '==': case 'eq': return { kind: 'equals' };
      case '>': case 'gt': return { kind: 'gt' };
      case '<': case 'lt': return { kind: 'lt' };
      case 'autobound': this.context = 'autobound'; return { kind: 'autobound' };
      case 'dst': case 'src': case 'dport': case 'sport': case 'dev': case 'fwmark': case 'cgroup':
        this.context = word;
        return { kind: 'keyword', word };
    }
    if (this.context === 'dev') {
      const index = this.parse.environment.interfaceIndex(word) ?? parseInteger(word);
      if (index === null) throw new SsError('Cannot parse device.\n', 1);
      return { kind: 'device', index };
    }
    if (this.context === 'fwmark') return this.markmask(word);
    if (this.context === 'cgroup') throw new SsError(`Cannot parse cgroup ${word}.\n`, 1);
    return {
      kind: 'host',
      conditions: parseHostCondition(word, this.context === 'sport' || this.context === 'dport', this.parse),
    };
  }

  private markmask(word: string): Token {
    const slash = word.indexOf('/');
    const mark = parseInteger(slash < 0 ? word : word.slice(0, slash));
    const mask = slash < 0 ? 0xffffffff : parseInteger(word.slice(slash + 1));
    if (mark === null || mask === null) throw new SsError(`Cannot parse mark ${word}.\n`, 1);
    return { kind: 'markmask', mark, mask };
  }
}

function startsExpression(token: Token): boolean {
  return token.kind === 'not' || token.kind === 'open' || token.kind === 'autobound' || token.kind === 'keyword';
}

class Parser {
  constructor(private readonly lexer: Lexer) {}

  parseApplet(): SsExpression | null {
    if (this.lexer.peek().kind === 'end') return null;
    const expression = this.parseList();
    if (this.lexer.peek().kind !== 'end') throw SYNTAX_ERROR();
    return expression;
  }

  private parseList(): SsExpression {
    let left = this.parseExpression();
    for (;;) {
      const token = this.lexer.peek();
      if (token.kind === 'or') {
        this.lexer.next();
        left = { type: 'or', left, right: this.parseExpression() };
      } else if (token.kind === 'and') {
        this.lexer.next();
        left = { type: 'and', left, right: this.parseExpression() };
      } else if (startsExpression(token)) {
        left = { type: 'and', left, right: this.parseExpression() };
      } else {
        return left;
      }
    }
  }

  private conditions(): readonly HostCondition[] {
    const token = this.lexer.next();
    if (token.kind !== 'host') throw SYNTAX_ERROR();
    return token.conditions;
  }

  private port(): number {
    return this.conditions()[0].port;
  }

  private skipEquals(): void {
    if (this.lexer.peek().kind === 'equals') this.lexer.next();
  }

  private parseExpression(): SsExpression {
    const token = this.lexer.next();
    switch (token.kind) {
      case 'open': {
        const inner = this.parseList();
        if (this.lexer.next().kind !== 'close') throw SYNTAX_ERROR();
        return inner;
      }
      case 'not': return { type: 'not', operand: this.parseExpression() };
      case 'autobound': return { type: 'autobound' };
      case 'keyword': return this.parseKeyword(token.word);
      default: throw SYNTAX_ERROR();
    }
  }

  private parseKeyword(word: 'dst' | 'src' | 'dport' | 'sport' | 'dev' | 'fwmark' | 'cgroup'): SsExpression {
    if (word === 'dst' || word === 'src') {
      this.skipEquals();
      return { type: word === 'dst' ? 'destination' : 'source', conditions: this.conditions() };
    }
    if (word === 'dport' || word === 'sport') return this.parsePortComparison(word === 'dport' ? 'destination' : 'source');
    if (word === 'dev') {
      const negated = this.lexer.peek().kind === 'ne';
      if (negated) this.lexer.next(); else this.skipEquals();
      const device = this.lexer.next();
      if (device.kind !== 'device') throw SYNTAX_ERROR();
      const expression: SsExpression = { type: 'device', index: device.index };
      return negated ? { type: 'not', operand: expression } : expression;
    }
    if (word === 'fwmark') {
      const negated = this.lexer.peek().kind === 'ne';
      if (negated) this.lexer.next(); else this.skipEquals();
      const mark = this.lexer.next();
      if (mark.kind !== 'markmask') throw SYNTAX_ERROR();
      const expression: SsExpression = { type: 'mark', mark: mark.mark, mask: mark.mask };
      return negated ? { type: 'not', operand: expression } : expression;
    }
    throw SYNTAX_ERROR();
  }

  private parsePortComparison(side: 'destination' | 'source'): SsExpression {
    const atLeast = side === 'destination' ? 'destination-port-at-least' : 'source-port-at-least';
    const atMost = side === 'destination' ? 'destination-port-at-most' : 'source-port-at-most';
    const operator = this.lexer.peek();
    switch (operator.kind) {
      case 'ge': this.lexer.next(); return { type: atLeast, port: this.port() };
      case 'le': this.lexer.next(); return { type: atMost, port: this.port() };
      case 'gt': this.lexer.next(); return { type: 'not', operand: { type: atMost, port: this.port() } };
      case 'lt': this.lexer.next(); return { type: 'not', operand: { type: atLeast, port: this.port() } };
      case 'ne': this.lexer.next(); return { type: 'not', operand: { type: side, conditions: this.conditions() } };
      default:
        this.skipEquals();
        return { type: side, conditions: this.conditions() };
    }
  }
}

export function parseFilterExpression(
  words: readonly string[], context: SsFilterParseContext,
): SsExpression | null {
  const lexer = new Lexer(splitTokens(words), context);
  return new Parser(lexer).parseApplet();
}
