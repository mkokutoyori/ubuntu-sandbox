import { IPv6Address } from '@/network/core/types';

export const RADVD_INFINITY = 0xffffffff;
export const MAX_PREFIX_LEN = 128;

export interface RadvdPrefix {
  address: IPv6Address;
  prefixLength: number;
  onLink: boolean;
  autonomous: boolean;
  routerAddr: boolean;
  validLifetime: number;
  preferredLifetime: number;
  deprecatePrefix: boolean;
  decrementLifetimes: boolean;
  base6Interface: string;
  base6to4Interface: string;
}

export interface RadvdRoute {
  address: IPv6Address;
  prefixLength: number;
  preference: number;
  lifetime: number;
  removeRoute: boolean;
}

export interface RadvdRdnss {
  addresses: IPv6Address[];
  lifetime: number;
  flush: boolean;
}

export interface RadvdDnssl {
  suffixes: string[];
  lifetime: number;
  flush: boolean;
}

export interface RadvdLowpanCo {
  contextLength: number;
  compression: boolean;
  contextId: number;
  lifetime: number;
}

export interface RadvdAbro {
  lbrAddress: IPv6Address;
  versionHigh: number;
  versionLow: number;
  validLifetime: number;
}

export interface RadvdInterface {
  name: string;
  line: number;
  ignoreIfMissing: boolean;
  advSendAdvert: boolean;
  maxRtrAdvInterval: number;
  minRtrAdvInterval: number;
  minDelayBetweenRAs: number;
  advManagedFlag: boolean;
  advOtherConfigFlag: boolean;
  advLinkMTU: number;
  advRAMTU: number;
  advReachableTime: number;
  advRetransTimer: number;
  advCurHopLimit: number;
  advDefaultLifetime: number;
  advDefaultPreference: number;
  advSourceLLAddress: boolean;
  advHomeAgentFlag: boolean;
  advIntervalOpt: boolean;
  advHomeAgentInfo: boolean;
  homeAgentPreference: number;
  homeAgentLifetime: number;
  advMobRtrSupportFlag: boolean;
  unicastOnly: boolean;
  advRASolicitedUnicast: boolean;
  prefixes: RadvdPrefix[];
  clients: IPv6Address[];
  routes: RadvdRoute[];
  rdnss: RadvdRdnss[];
  dnssl: RadvdDnssl[];
  lowpanCo: RadvdLowpanCo[];
  abro: RadvdAbro[];
  raSourceAddresses: IPv6Address[];
}

export type RadvdLogLevel = 'crit' | 'err' | 'warning' | 'info';

export interface RadvdConfigResult {
  interfaces: RadvdInterface[] | null;
  stderr: string[];
  log: Array<{ level: RadvdLogLevel; message: string }>;
}

const MIN_ADV_LINK_MTU = 1280;
const MAX_ADV_LINK_MTU = 131072;

function newInterface(name: string, line: number): RadvdInterface {
  return {
    name, line,
    ignoreIfMissing: true, advSendAdvert: false, maxRtrAdvInterval: 600, minRtrAdvInterval: -1,
    minDelayBetweenRAs: 3.0, advManagedFlag: false, advOtherConfigFlag: false, advLinkMTU: 0, advRAMTU: 1280,
    advReachableTime: 0, advRetransTimer: 0, advCurHopLimit: 64, advDefaultLifetime: -1, advDefaultPreference: 0,
    advSourceLLAddress: true, advHomeAgentFlag: false, advIntervalOpt: false, advHomeAgentInfo: false,
    homeAgentPreference: 0, homeAgentLifetime: -1, advMobRtrSupportFlag: false, unicastOnly: false,
    advRASolicitedUnicast: true, prefixes: [], clients: [], routes: [], rdnss: [], dnssl: [], lowpanCo: [], abro: [],
    raSourceAddresses: [],
  };
}

function newPrefix(address: IPv6Address, prefixLength: number): RadvdPrefix {
  return {
    address, prefixLength, onLink: true, autonomous: true, routerAddr: false, validLifetime: 86400,
    preferredLifetime: 14400, deprecatePrefix: false, decrementLifetimes: false, base6Interface: '', base6to4Interface: '',
  };
}

type TokenKind =
  | 'KEYWORD' | 'STRING' | 'NUMBER' | 'SNUMBER' | 'DECIMAL' | 'SWITCH' | 'IPV6ADDR' | 'INFINITY' | 'PUNCT' | 'BAD' | 'EOF';

interface Token {
  kind: TokenKind;
  text: string;
  number: number;
  address?: IPv6Address;
}

const KEYWORDS: readonly string[] = [
  'interface', 'prefix', 'route', 'RDNSS', 'DNSSL', 'clients', 'lowpanco', 'abro', 'AdvRASrcAddress',
  'IgnoreIfMissing', 'AdvSendAdvert', 'MaxRtrAdvInterval', 'MinRtrAdvInterval', 'AdvManagedFlag', 'AdvOtherConfigFlag',
  'AdvLinkMTU', 'AdvRAMTU', 'AdvReachableTime', 'AdvRetransTimer', 'AdvCurHopLimit', 'AdvDefaultLifetime',
  'AdvDefaultPreference', 'AdvSourceLLAddress', 'AdvOnLink', 'AdvAutonomous', 'AdvValidLifetime', 'AdvPreferredLifetime',
  'DeprecatePrefix', 'DecrementLifetimes', 'AdvRouterAddr', 'AdvHomeAgentFlag', 'AdvIntervalOpt', 'AdvHomeAgentInfo',
  'UnicastOnly', 'AdvRASolicitedUnicast', 'Base6Interface', 'Base6to4Interface', 'HomeAgentPreference',
  'HomeAgentLifetime', 'AdvRoutePreference', 'AdvRouteLifetime', 'RemoveRoute', 'AdvRDNSSPreference', 'AdvRDNSSOpen',
  'AdvRDNSSLifetime', 'FlushRDNSS', 'AdvDNSSLLifetime', 'FlushDNSSL', 'MinDelayBetweenRAs', 'AdvMobRtrSupportFlag',
  'AdvContextLength', 'AdvContextCompressionFlag', 'AdvContextID', 'AdvLifeTime', 'AdvContextPrefix', 'AdvVersionLow',
  'AdvVersionHigh', 'AdvValidLifeTime', 'Adv6LBRaddress',
];

const HEX = '[a-fA-F0-9]';
const GROUP = `${HEX}{1,4}`;
const ADDRESS_FORMS: readonly RegExp[] = [
  new RegExp(`${GROUP}:(?:${GROUP}:)*(?::${GROUP})+`, 'y'),
  new RegExp(`${GROUP}(?::${GROUP})*::`, 'y'),
  new RegExp(`(?:${GROUP}:){7}${GROUP}`, 'y'),
  /::/y,
];
const STRING_PLAIN = /[a-zA-Z0-9`~!@#$%^&*()_\-+=:[\]<>,.?\\]+/y;
const STRING_QUOTED = /L?"(?:\\.|[^\\"])*"/y;

class Scanner {
  line = 1;
  private position = 0;

  constructor(private readonly text: string) {}

  private matchAt(pattern: RegExp): number {
    pattern.lastIndex = this.position;
    const found = pattern.exec(this.text);
    return found === null ? 0 : found[0].length;
  }

  next(): Token {
    for (;;) {
      if (this.position >= this.text.length) return { kind: 'EOF', text: '', number: 0 };
      const ch = this.text[this.position];
      if (ch === '\n') { this.line++; this.position++; continue; }
      if (ch === ' ' || ch === '\t') { this.position++; continue; }
      if (ch === '#') {
        while (this.position < this.text.length && this.text[this.position] !== '\n') this.position++;
        continue;
      }
      break;
    }
    type Candidate = { length: number; make: (text: string) => Token };
    let best: Candidate | null = null;
    const offer = (length: number, make: (text: string) => Token): void => {
      if (length > 0 && (best === null || length > best.length)) best = { length, make };
    };
    for (const keyword of KEYWORDS) {
      if (this.text.startsWith(keyword, this.position)) offer(keyword.length, (text) => ({ kind: 'KEYWORD', text, number: 0 }));
    }
    for (const form of ADDRESS_FORMS) {
      offer(this.matchAt(form), (text) => {
        const address = IPv6Address.tryParse(text);
        return address === null ? { kind: 'BAD', text, number: 0 } : { kind: 'IPV6ADDR', text, number: 0, address };
      });
    }
    offer(this.matchAt(/[0-9]+/y), (text) => {
      const value = Number(text);
      return value > 0xffffffff ? { kind: 'BAD', text, number: 0 } : { kind: 'NUMBER', text, number: value };
    });
    offer(this.matchAt(/-?[0-9]+/y), (text) => ({ kind: 'SNUMBER', text, number: parseInt(text, 10) }));
    offer(this.matchAt(/[0-9]+\.[0-9]+/y), (text) => ({ kind: 'DECIMAL', text, number: parseFloat(text) }));
    for (const [word, kind, value] of [
      ['infinity', 'INFINITY', 0], ['on', 'SWITCH', 1], ['off', 'SWITCH', 0],
      ['low', 'SNUMBER', -1], ['medium', 'SNUMBER', 0], ['high', 'SNUMBER', 1],
    ] as const) {
      if (this.text.startsWith(word, this.position)) offer(word.length, (text) => ({ kind, text, number: value }));
    }
    offer(this.matchAt(STRING_PLAIN), (text) => ({ kind: 'STRING', text: text.slice(0, 255), number: 0 }));
    offer(this.matchAt(STRING_QUOTED), (text) => ({ kind: 'STRING', text: text.slice(0, 255), number: 0 }));
    if ('{};/'.includes(ch0(this.text, this.position))) offer(1, (text) => ({ kind: 'PUNCT', text, number: 0 }));
    const chosen = best as Candidate | null;
    if (chosen === null) {
      this.position++;
      return { kind: 'BAD', text: ch0(this.text, this.position - 1), number: 0 };
    }
    const lexeme = this.text.slice(this.position, this.position + chosen.length);
    this.position += chosen.length;
    return chosen.make(lexeme);
  }
}

function ch0(text: string, position: number): string {
  return position < text.length ? text[position] : '\0';
}

class SyntaxFailure extends Error {}
class AbortFailure extends Error {}

class Parser {
  private lookahead: Token | null = null;
  private readonly scanner: Scanner;
  readonly log: RadvdConfigResult['log'] = [];
  private current!: RadvdInterface;
  private readonly interfaces: RadvdInterface[] = [];

  constructor(text: string, private readonly path: string) {
    this.scanner = new Scanner(text);
  }

  get lineNumber(): number { return this.scanner.line; }

  private peek(): Token {
    this.lookahead ??= this.scanner.next();
    return this.lookahead;
  }

  private take(): Token {
    const token = this.peek();
    this.lookahead = null;
    return token;
  }

  private fail(): never { throw new SyntaxFailure(); }

  private abort(level: RadvdLogLevel, message: string): never {
    this.log.push({ level, message });
    throw new AbortFailure();
  }

  private warn(level: RadvdLogLevel, message: string): void { this.log.push({ level, message }); }

  private expectKeyword(word: string): void {
    const token = this.take();
    if (token.kind !== 'KEYWORD' || token.text !== word) this.fail();
  }

  private expectPunct(symbol: string): void {
    const token = this.take();
    if (token.kind !== 'PUNCT' || token.text !== symbol) this.fail();
  }

  private isKeyword(word: string): boolean {
    const token = this.peek();
    return token.kind === 'KEYWORD' && token.text === word;
  }

  private isPunct(symbol: string): boolean {
    const token = this.peek();
    return token.kind === 'PUNCT' && token.text === symbol;
  }

  private number(): number {
    const token = this.take();
    if (token.kind !== 'NUMBER') this.fail();
    return token.number;
  }

  private signed(): number {
    const token = this.take();
    if (token.kind !== 'SNUMBER') this.fail();
    return token.number;
  }

  private switchValue(): boolean {
    const token = this.take();
    if (token.kind !== 'SWITCH') this.fail();
    return token.number === 1;
  }

  private numberOrInfinity(): number {
    const token = this.take();
    if (token.kind === 'NUMBER') return token.number;
    if (token.kind === 'INFINITY') return RADVD_INFINITY;
    return this.fail();
  }

  private numberOrDecimal(): number {
    const token = this.take();
    if (token.kind !== 'NUMBER' && token.kind !== 'DECIMAL') this.fail();
    return token.number;
  }

  private address(): IPv6Address {
    const token = this.take();
    if (token.kind !== 'IPV6ADDR' || token.address === undefined) this.fail();
    return token.address;
  }

  private name(): string {
    const token = this.take();
    if (token.kind !== 'STRING') this.fail();
    return token.text;
  }

  parse(): RadvdInterface[] {
    this.interfaceDefinition();
    while (this.peek().kind !== 'EOF') this.interfaceDefinition();
    return this.interfaces.slice().reverse();
  }

  private interfaceDefinition(): void {
    this.expectKeyword('interface');
    const name = this.name();
    if (this.interfaces.some((known) => known.name === name)) {
      this.abort('err', `duplicate interface definition for ${name}`);
    }
    this.current = newInterface(name.slice(0, 15), this.scanner.line);
    this.expectPunct('{');
    while (!this.isPunct('}')) this.interfaceParameter();
    this.take();
    this.expectPunct(';');
    this.interfaces.push(this.current);
  }

  private interfaceParameter(): void {
    const token = this.peek();
    if (token.kind !== 'KEYWORD') this.fail();
    const iface = this.current;
    switch (token.text) {
      case 'prefix': iface.prefixes.push(this.prefixDefinition()); return;
      case 'clients': iface.clients.push(...this.addressList('clients')); return;
      case 'route': iface.routes.push(this.routeDefinition()); return;
      case 'RDNSS': iface.rdnss.push(this.rdnssDefinition()); return;
      case 'DNSSL': iface.dnssl.push(this.dnsslDefinition()); return;
      case 'lowpanco': iface.lowpanCo.push(this.lowpanDefinition()); return;
      case 'abro': iface.abro.push(this.abroDefinition()); return;
      case 'AdvRASrcAddress': iface.raSourceAddresses.push(...this.addressList('AdvRASrcAddress')); return;
      default: break;
    }
    this.take();
    const finish = (): void => this.expectPunct(';');
    switch (token.text) {
      case 'MinRtrAdvInterval': iface.minRtrAdvInterval = this.numberOrDecimal(); break;
      case 'MaxRtrAdvInterval': iface.maxRtrAdvInterval = this.numberOrDecimal(); break;
      case 'MinDelayBetweenRAs': iface.minDelayBetweenRAs = this.numberOrDecimal(); break;
      case 'IgnoreIfMissing': iface.ignoreIfMissing = this.switchValue(); break;
      case 'AdvSendAdvert': iface.advSendAdvert = this.switchValue(); break;
      case 'AdvManagedFlag': iface.advManagedFlag = this.switchValue(); break;
      case 'AdvOtherConfigFlag': iface.advOtherConfigFlag = this.switchValue(); break;
      case 'AdvLinkMTU': iface.advLinkMTU = this.number(); break;
      case 'AdvRAMTU':
        iface.advRAMTU = Math.min(MAX_ADV_LINK_MTU, Math.max(MIN_ADV_LINK_MTU, this.number()));
        break;
      case 'AdvReachableTime': iface.advReachableTime = this.number(); break;
      case 'AdvRetransTimer': iface.advRetransTimer = this.number(); break;
      case 'AdvDefaultLifetime': iface.advDefaultLifetime = this.number(); break;
      case 'AdvDefaultPreference': iface.advDefaultPreference = this.signed(); break;
      case 'AdvCurHopLimit': iface.advCurHopLimit = this.number(); break;
      case 'AdvSourceLLAddress': iface.advSourceLLAddress = this.switchValue(); break;
      case 'AdvIntervalOpt': iface.advIntervalOpt = this.switchValue(); break;
      case 'AdvHomeAgentInfo': iface.advHomeAgentInfo = this.switchValue(); break;
      case 'AdvHomeAgentFlag': iface.advHomeAgentFlag = this.switchValue(); break;
      case 'HomeAgentPreference': iface.homeAgentPreference = this.number(); break;
      case 'HomeAgentLifetime': iface.homeAgentLifetime = this.number(); break;
      case 'UnicastOnly': iface.unicastOnly = this.switchValue(); break;
      case 'AdvRASolicitedUnicast': iface.advRASolicitedUnicast = this.switchValue(); break;
      case 'AdvMobRtrSupportFlag': iface.advMobRtrSupportFlag = this.switchValue(); break;
      default: this.fail();
    }
    finish();
  }

  private addressList(keyword: string): IPv6Address[] {
    this.expectKeyword(keyword);
    this.expectPunct('{');
    const found: IPv6Address[] = [this.address()];
    this.expectPunct(';');
    while (!this.isPunct('}')) {
      found.push(this.address());
      this.expectPunct(';');
    }
    this.take();
    this.expectPunct(';');
    return found.reverse();
  }

  private prefixDefinition(): RadvdPrefix {
    this.expectKeyword('prefix');
    const address = this.address();
    this.expectPunct('/');
    const length = this.number();
    if (length > MAX_PREFIX_LEN) this.abort('err', `invalid prefix length in ${this.path}, line ${this.scanner.line}`);
    const prefix = newPrefix(address, length);
    if (this.isPunct('{')) {
      this.take();
      while (!this.isPunct('}')) this.prefixParameter(prefix);
      this.take();
    }
    this.expectPunct(';');
    if (prefix.preferredLifetime > prefix.validLifetime) {
      this.abort('err', `AdvValidLifeTime must be greater than AdvPreferredLifetime in ${this.path}, line ${this.scanner.line}`);
    }
    if (prefix.base6Interface !== '' && prefix.prefixLength !== 64) {
      this.abort('err', `only /64 is allowed with Base6Interface.  ${this.path}:${this.scanner.line}`);
    }
    return prefix;
  }

  private prefixParameter(prefix: RadvdPrefix): void {
    const token = this.take();
    if (token.kind !== 'KEYWORD') this.fail();
    switch (token.text) {
      case 'AdvOnLink': prefix.onLink = this.switchValue(); break;
      case 'AdvAutonomous': prefix.autonomous = this.switchValue(); break;
      case 'AdvRouterAddr': prefix.routerAddr = this.switchValue(); break;
      case 'AdvValidLifetime': prefix.validLifetime = this.numberOrInfinity(); break;
      case 'AdvPreferredLifetime': prefix.preferredLifetime = this.numberOrInfinity(); break;
      case 'DeprecatePrefix': prefix.deprecatePrefix = this.switchValue(); break;
      case 'DecrementLifetimes': prefix.decrementLifetimes = this.switchValue(); break;
      case 'Base6Interface': prefix.base6Interface = this.name().slice(0, 15); break;
      case 'Base6to4Interface': prefix.base6to4Interface = this.name().slice(0, 15); break;
      default: this.fail();
    }
    this.expectPunct(';');
  }

  private routeDefinition(): RadvdRoute {
    this.expectKeyword('route');
    const address = this.address();
    this.expectPunct('/');
    const length = this.number();
    const route: RadvdRoute = {
      address, prefixLength: length, preference: 0, lifetime: 3 * this.current.maxRtrAdvInterval, removeRoute: true,
    };
    if (length > MAX_PREFIX_LEN) this.abort('err', `invalid route prefix length in ${this.path}, line ${this.scanner.line}`);
    this.expectPunct('{');
    while (!this.isPunct('}')) {
      const token = this.take();
      if (token.kind !== 'KEYWORD') this.fail();
      switch (token.text) {
        case 'AdvRoutePreference': route.preference = this.signed(); break;
        case 'AdvRouteLifetime': route.lifetime = this.numberOrInfinity(); break;
        case 'RemoveRoute': route.removeRoute = this.switchValue(); break;
        default: this.fail();
      }
      this.expectPunct(';');
    }
    this.take();
    this.expectPunct(';');
    return route;
  }

  private rdnssDefinition(): RadvdRdnss {
    this.expectKeyword('RDNSS');
    const rdnss: RadvdRdnss = { addresses: [], lifetime: this.current.maxRtrAdvInterval, flush: true };
    rdnss.addresses.push(this.address());
    while (this.peek().kind === 'IPV6ADDR') {
      if (rdnss.addresses.length === 3) this.abort('crit', 'too many addresses in RDNSS section');
      rdnss.addresses.push(this.address());
    }
    this.expectPunct('{');
    while (!this.isPunct('}')) {
      const token = this.take();
      if (token.kind !== 'KEYWORD') this.fail();
      switch (token.text) {
        case 'AdvRDNSSPreference':
          this.number();
          this.warn('warning', 'ignoring deprecated RDNSS preference');
          break;
        case 'AdvRDNSSOpen':
          this.switchValue();
          this.warn('warning', 'ignoring deprecated RDNSS open flag');
          break;
        case 'AdvRDNSSLifetime': {
          const lifetime = this.numberOrInfinity();
          const max = this.current.maxRtrAdvInterval;
          if (lifetime > 2 * max) {
            this.warn('warning', 'warning: AdvRDNSSLifetime <= 2*MaxRtrAdvInterval would allow stale DNS servers to be deleted faster');
          }
          if (lifetime < max && lifetime !== 0) this.warn('err', 'AdvRDNSSLifetime must be at least MaxRtrAdvInterval');
          if (lifetime > 2 * max) {
            this.warn('warning', `warning: (${this.path}:${this.scanner.line}) AdvRDNSSLifetime <= 2*MaxRtrAdvInterval would allow stale DNS servers to be deleted faster`);
          }
          rdnss.lifetime = lifetime;
          break;
        }
        case 'FlushRDNSS': rdnss.flush = this.switchValue(); break;
        default: this.fail();
      }
      this.expectPunct(';');
    }
    this.take();
    this.expectPunct(';');
    return rdnss;
  }

  private dnsslDefinition(): RadvdDnssl {
    this.expectKeyword('DNSSL');
    const dnssl: RadvdDnssl = { suffixes: [], lifetime: this.current.maxRtrAdvInterval, flush: true };
    do {
      const suffix = this.name();
      if (!/^[A-Za-z0-9.-]*$/.test(suffix)) this.abort('crit', 'invalid domain suffix specified');
      dnssl.suffixes.push(suffix);
    } while (this.peek().kind === 'STRING');
    this.expectPunct('{');
    while (!this.isPunct('}')) {
      const token = this.take();
      if (token.kind !== 'KEYWORD') this.fail();
      switch (token.text) {
        case 'AdvDNSSLLifetime': {
          const lifetime = this.numberOrInfinity();
          const max = this.current.maxRtrAdvInterval;
          if (lifetime > 2 * max) {
            this.warn('warning', 'warning: AdvDNSSLLifetime <= 2*MaxRtrAdvInterval would allow stale DNS suffixes to be deleted faster');
          }
          if (lifetime < max && lifetime !== 0) this.warn('err', 'AdvDNSSLLifetime must be at least MaxRtrAdvInterval');
          dnssl.lifetime = lifetime < max && lifetime !== 0 ? max : lifetime;
          break;
        }
        case 'FlushDNSSL': dnssl.flush = this.switchValue(); break;
        default: this.fail();
      }
      this.expectPunct(';');
    }
    this.take();
    this.expectPunct(';');
    return dnssl;
  }

  private lowpanDefinition(): RadvdLowpanCo {
    this.expectKeyword('lowpanco');
    const co: RadvdLowpanCo = { contextLength: 0, compression: false, contextId: 0, lifetime: 0 };
    this.expectPunct('{');
    while (!this.isPunct('}')) {
      const token = this.take();
      if (token.kind !== 'KEYWORD') this.fail();
      switch (token.text) {
        case 'AdvContextLength': co.contextLength = this.number(); break;
        case 'AdvContextCompressionFlag': co.compression = this.switchValue(); break;
        case 'AdvContextID': co.contextId = this.number(); break;
        case 'AdvLifeTime': co.lifetime = this.number(); break;
        default: this.fail();
      }
      this.expectPunct(';');
    }
    this.take();
    this.expectPunct(';');
    return co;
  }

  private abroDefinition(): RadvdAbro {
    this.expectKeyword('abro');
    const abro: RadvdAbro = { lbrAddress: this.address(), versionHigh: 0, versionLow: 0, validLifetime: 0 };
    if (this.isPunct('/')) {
      this.take();
      const length = this.number();
      this.warn('warning', `${this.path}:${this.scanner.line} abro prefix length deprecated, remove trailing '/${length}'`);
    }
    this.expectPunct('{');
    while (!this.isPunct('}')) {
      const token = this.take();
      if (token.kind !== 'KEYWORD') this.fail();
      switch (token.text) {
        case 'AdvVersionLow': abro.versionLow = this.number(); break;
        case 'AdvVersionHigh': abro.versionHigh = this.number(); break;
        case 'AdvValidLifeTime': abro.validLifetime = this.number(); break;
        default: this.fail();
      }
      this.expectPunct(';');
    }
    this.take();
    this.expectPunct(';');
    return abro;
  }
}

export function parseRadvdConfig(text: string, path: string): RadvdConfigResult {
  const parser = new Parser(text, path);
  try {
    const interfaces = parser.parse();
    return { interfaces, stderr: [], log: parser.log };
  } catch (failure) {
    if (failure instanceof SyntaxFailure) {
      return { interfaces: null, stderr: [`${path}:${parser.lineNumber} error: syntax error`], log: parser.log };
    }
    if (failure instanceof AbortFailure) return { interfaces: null, stderr: [], log: parser.log };
    throw failure;
  }
}
