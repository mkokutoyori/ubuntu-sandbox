export interface DhcpdError {
  readonly line: number;
  readonly message: string;
  readonly text: string;
}

export interface DhcpdOptions {
  routers: string[];
  domainNameServers: string[];
  domainName: string | null;
  broadcastAddress: string | null;
  defaultLeaseTime: number | null;
  maxLeaseTime: number | null;
  ntpServers: string[];
  netbiosNameServers: string[];
  tftpServerName: string | null;
  bootfileName: string | null;
  nameServers6: string[];
  domainSearch: string[];
  preference: number | null;
  renewalTime: number | null;
  rebindingTime: number | null;
  preferredLifetime: number | null;
  unicast6: string | null;
  infoRefreshTime: number | null;
}

export interface DhcpdSubnet6 {
  readonly prefix: string;
  readonly prefixLength: number;
  readonly ranges: { start: string; end: string }[];
  readonly prefixRanges: { low: string; high: string; length: number }[];
  readonly options: DhcpdOptions;
  readonly line: number;
}

export interface DhcpdSubnet {
  readonly network: string;
  readonly netmask: string;
  readonly ranges: { start: string; end: string }[];
  readonly options: DhcpdOptions;
  readonly line: number;
}

export interface DhcpdHost {
  readonly name: string;
  readonly hardwareEthernet: string | null;
  readonly fixedAddress: string | null;
  readonly clientDuid: string | null;
  readonly fixedAddress6: string | null;
  readonly fixedPrefix6: { prefix: string; length: number } | null;
  readonly options: DhcpdOptions;
  readonly line: number;
}

export interface DhcpdConfig {
  readonly globals: DhcpdOptions;
  readonly pingCheck: boolean;
  readonly pingTimeoutSeconds: number;
  readonly subnets: readonly DhcpdSubnet[];
  readonly subnets6: readonly DhcpdSubnet6[];
  readonly hosts: readonly DhcpdHost[];
  readonly authoritative: boolean;
  readonly leasequery: boolean;
  readonly errors: readonly DhcpdError[];
}

export const PING_CHECK_DEFAULT = true;

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const MAC = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i;
const IPV6_PREFIX = /^[0-9a-f:]+\/\d{1,3}$/i;
const IPV6 = /^[0-9a-f:]*:[0-9a-f:]*$/i;
const DUID = /^[0-9a-f]{1,2}(:[0-9a-f]{1,2})+$/i;

export function emptyOptions(): DhcpdOptions {
  return {
    routers: [], domainNameServers: [], domainName: null, broadcastAddress: null,
    defaultLeaseTime: null, maxLeaseTime: null, ntpServers: [],
    netbiosNameServers: [], tftpServerName: null, bootfileName: null,
    nameServers6: [], domainSearch: [], preference: null, renewalTime: null,
    rebindingTime: null, preferredLifetime: null, unicast6: null, infoRefreshTime: null,
  };
}

export function mergedOptions(globals: DhcpdOptions, local: DhcpdOptions): DhcpdOptions {
  return {
    routers: local.routers.length > 0 ? local.routers : globals.routers,
    domainNameServers: local.domainNameServers.length > 0
      ? local.domainNameServers : globals.domainNameServers,
    domainName: local.domainName ?? globals.domainName,
    broadcastAddress: local.broadcastAddress ?? globals.broadcastAddress,
    defaultLeaseTime: local.defaultLeaseTime ?? globals.defaultLeaseTime,
    maxLeaseTime: local.maxLeaseTime ?? globals.maxLeaseTime,
    ntpServers: local.ntpServers.length > 0 ? local.ntpServers : globals.ntpServers,
    netbiosNameServers: local.netbiosNameServers.length > 0
      ? local.netbiosNameServers : globals.netbiosNameServers,
    tftpServerName: local.tftpServerName ?? globals.tftpServerName,
    bootfileName: local.bootfileName ?? globals.bootfileName,
    nameServers6: local.nameServers6.length > 0 ? local.nameServers6 : globals.nameServers6,
    domainSearch: local.domainSearch.length > 0 ? local.domainSearch : globals.domainSearch,
    preference: local.preference ?? globals.preference,
    renewalTime: local.renewalTime ?? globals.renewalTime,
    rebindingTime: local.rebindingTime ?? globals.rebindingTime,
    preferredLifetime: local.preferredLifetime ?? globals.preferredLifetime,
    unicast6: local.unicast6 ?? globals.unicast6,
    infoRefreshTime: local.infoRefreshTime ?? globals.infoRefreshTime,
  };
}

interface Token {
  readonly value: string;
  readonly line: number;
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].split('#')[0];
    const matches = line.match(/"[^"]*"|[{};,]|[^\s{};,]+/g);
    if (!matches) continue;
    for (const value of matches) tokens.push({ value, line: index + 1 });
  }
  return tokens;
}

function addressList(words: readonly string[]): string[] {
  return words.filter(word => word !== ',' && word.length > 0);
}

function unquote(word: string): string {
  return word.startsWith('"') && word.endsWith('"') ? word.slice(1, -1) : word;
}

class Parser {
  private index = 0;
  readonly errors: DhcpdError[] = [];
  readonly subnets: DhcpdSubnet[] = [];
  readonly subnets6: DhcpdSubnet6[] = [];
  readonly hosts: DhcpdHost[] = [];
  authoritative = false;
  leasequery = false;
  pingCheck: boolean | undefined;
  pingTimeoutSeconds = 1;

  constructor(private readonly tokens: Token[], private readonly path: string) {}

  private fail(token: Token | undefined, message: string): void {
    this.errors.push({
      line: token?.line ?? 0, message,
      text: `${this.path} line ${token?.line ?? 0}: ${message}`,
    });
  }

  /**
   * Reads a statement's words and the `;` that must close it. `arity`
   * bounds how many words the keyword takes, so a forgotten semicolon is
   * caught where ISC catches it rather than swallowing the next line.
   */
  private statement(head: Token, arity = Number.POSITIVE_INFINITY): string[] | null {
    const words: string[] = [];
    while (this.index < this.tokens.length && words.length < arity) {
      const token = this.tokens[this.index];
      if (token.value === ';') { this.index++; return words; }
      if (token.value === '{' || token.value === '}') break;
      words.push(token.value);
      this.index++;
    }
    if (this.tokens[this.index]?.value === ';') { this.index++; return words; }
    this.fail(head, 'semicolon expected.');
    return null;
  }

  private applyOption(head: Token, words: readonly string[], into: DhcpdOptions): void {
    const name = words[0];
    const rest = addressList(words.slice(1));
    switch (name) {
      case 'routers': into.routers = rest; return;
      case 'domain-name-servers': into.domainNameServers = rest; return;
      case 'domain-name': into.domainName = unquote(rest[0] ?? ''); return;
      case 'broadcast-address': into.broadcastAddress = rest[0] ?? null; return;
      case 'ntp-servers': into.ntpServers = rest; return;
      case 'netbios-name-servers': into.netbiosNameServers = rest; return;
      case 'tftp-server-name': into.tftpServerName = unquote(rest[0] ?? ''); return;
      case 'bootfile-name': into.bootfileName = unquote(rest[0] ?? ''); return;
      case 'subnet-mask': return;
      case 'dhcp6.name-servers': into.nameServers6 = rest; return;
      case 'dhcp6.domain-search': into.domainSearch = rest.map(unquote); return;
      case 'dhcp6.preference': into.preference = Number(rest[0]); return;
      case 'dhcp6.unicast': into.unicast6 = rest[0] ?? null; return;
      case 'dhcp6.info-refresh-time': into.infoRefreshTime = Number(rest[0]); return;
      case 'dhcp-renewal-time': into.renewalTime = Number(rest[0]); return;
      case 'dhcp-rebinding-time': into.rebindingTime = Number(rest[0]); return;
      default: this.fail(head, `unknown option ${name}.`);
    }
  }

  private arityOf(keyword: string): number {
    switch (keyword) {
      case 'default-lease-time': case 'max-lease-time': case 'min-lease-time': case 'preferred-lifetime':
      case 'ddns-update-style': case 'ddns-updates': case 'log-facility':
      case 'next-server': case 'filename': case 'server-identifier':
      case 'get-lease-hostnames': case 'use-host-decl-names':
      case 'ping-check': case 'ping-timeout':
        return 1;
      default:
        return Number.POSITIVE_INFINITY;
    }
  }

  private applyParameter(head: Token, words: readonly string[], into: DhcpdOptions): boolean {
    switch (head.value) {
      case 'default-lease-time': into.defaultLeaseTime = Number(words[0]); return true;
      case 'max-lease-time': into.maxLeaseTime = Number(words[0]); return true;
      case 'preferred-lifetime': into.preferredLifetime = Number(words[0]); return true;
      case 'leasequery':
        this.leasequery = /^(true|on|1)$/i.test(words[0] ?? '');
        return true;
      case 'ping-check':
        this.pingCheck = /^(true|on|1)$/i.test(words[0] ?? '');
        return true;
      case 'ping-timeout':
        this.pingTimeoutSeconds = Number(words[0]) || 1;
        return true;
      case 'min-lease-time': case 'ddns-update-style': case 'ddns-updates':
      case 'log-facility': case 'allow': case 'deny': case 'ignore':
      case 'get-lease-hostnames': case 'use-host-decl-names':
      case 'server-identifier': case 'authoritative':
        return true;
      case 'next-server': into.tftpServerName = words[0] ?? null; return true;
      case 'filename': into.bootfileName = unquote(words[0] ?? ''); return true;
      default: return false;
    }
  }

  private block(open: Token | undefined): Token[] | null {
    if (open?.value !== '{') {
      this.fail(open, 'expecting a parameter or declaration.');
      return null;
    }
    this.index++;
    const inner: Token[] = [];
    let depth = 1;
    while (this.index < this.tokens.length) {
      const token = this.tokens[this.index];
      if (token.value === '{') depth++;
      if (token.value === '}') {
        depth--;
        if (depth === 0) { this.index++; return inner; }
      }
      inner.push(token);
      this.index++;
    }
    this.fail(open, 'unexpected end of file.');
    return null;
  }

  /** Parses a nested block, harvesting its declarations into this parser's. */
  private nested(tokens: Token[], options: DhcpdOptions): void {
    const parser = new Parser(tokens, this.path);
    parser.run(options);
    for (const error of parser.errors) this.errors.push(error);
    for (const subnet of parser.subnets) this.subnets.push(subnet);
    for (const subnet of parser.subnets6) this.subnets6.push(subnet);
    for (const host of parser.hosts) this.hosts.push(host);
    if (parser.authoritative) this.authoritative = true;
    if (parser.leasequery) this.leasequery = true;
    if (parser.pingCheck !== undefined) this.pingCheck = parser.pingCheck;
  }

  private declareSubnet(head: Token): void {
    const network = this.tokens[this.index]?.value ?? '';
    const netmaskWord = this.tokens[this.index + 1]?.value ?? '';
    const netmask = this.tokens[this.index + 2]?.value ?? '';
    if (!IPV4.test(network) || netmaskWord !== 'netmask' || !IPV4.test(netmask)) {
      this.fail(head, 'expecting a subnet number and netmask.');
      return;
    }
    this.index += 3;
    const inner = this.block(this.tokens[this.index]);
    if (!inner) return;
    const options = emptyOptions();
    this.nested(inner, options);
    const ranges: { start: string; end: string }[] = [];
    collectRanges(inner, ranges);
    this.subnets.push({ network, netmask, ranges, options, line: head.line });
  }

  private declareSubnet6(head: Token): void {
    const spec = this.tokens[this.index]?.value ?? '';
    if (!IPV6_PREFIX.test(spec)) {
      this.fail(head, 'expecting an IPv6 prefix.');
      return;
    }
    this.index++;
    const inner = this.block(this.tokens[this.index]);
    if (!inner) return;
    const options = emptyOptions();
    this.nested(inner, options);
    const [prefix, length] = spec.split('/');
    const ranges: { start: string; end: string }[] = [];
    const prefixRanges: { low: string; high: string; length: number }[] = [];
    for (let i = 0; i < inner.length; i++) {
      if (inner[i].value === 'range6' && IPV6.test(inner[i + 1]?.value ?? '') && IPV6.test(inner[i + 2]?.value ?? '')) {
        ranges.push({ start: inner[i + 1].value, end: inner[i + 2].value });
      }
      if (inner[i].value === 'prefix6' && IPV6.test(inner[i + 1]?.value ?? '') && IPV6.test(inner[i + 2]?.value ?? '')
        && /^\/\d+$/.test(inner[i + 3]?.value ?? '')) {
        prefixRanges.push({ low: inner[i + 1].value, high: inner[i + 2].value, length: Number(inner[i + 3].value.slice(1)) });
      }
    }
    this.subnets6.push({ prefix, prefixLength: Number(length), ranges, prefixRanges, options, line: head.line });
  }

  private declareHost(head: Token): void {
    const name = this.tokens[this.index]?.value ?? '';
    if (name === '' || name === '{') {
      this.fail(head, 'expecting a name for the host declaration.');
      return;
    }
    this.index++;
    const inner = this.block(this.tokens[this.index]);
    if (!inner) return;
    const options = emptyOptions();
    this.nested(inner, options);
    const record = collectHostRecord(inner);
    if (record.hardwareEthernet !== null && !MAC.test(record.hardwareEthernet)) {
      this.fail(head, 'expecting a hardware address.');
      return;
    }
    if (record.clientDuid !== null && !DUID.test(record.clientDuid)) {
      this.fail(head, 'expecting a DUID.');
      return;
    }
    this.hosts.push({
      name, hardwareEthernet: record.hardwareEthernet,
      fixedAddress: record.fixedAddress, clientDuid: record.clientDuid,
      fixedAddress6: record.fixedAddress6, fixedPrefix6: record.fixedPrefix6, options, line: head.line,
    });
  }

  run(options: DhcpdOptions): void {
    while (this.index < this.tokens.length) {
      const head = this.tokens[this.index];
      if (head.value === ';' || head.value === '}') { this.index++; continue; }
      this.index++;

      if (head.value === 'option') {
        const words = this.statement(head);
        if (words) this.applyOption(head, words, options);
        continue;
      }
      if (head.value === 'authoritative') {
        this.authoritative = true;
        if (this.tokens[this.index]?.value === ';') this.index++;
        continue;
      }
      if (head.value === 'subnet') { this.declareSubnet(head); continue; }
      if (head.value === 'subnet6') { this.declareSubnet6(head); continue; }
      if (head.value === 'host') { this.declareHost(head); continue; }
      if (head.value === 'range' || head.value === 'range6' || head.value === 'prefix6') { this.statement(head); continue; }
      if (head.value === 'hardware' || head.value === 'fixed-address' || head.value === 'fixed-address6'
        || head.value === 'fixed-prefix6' || head.value === 'host-identifier') {
        this.statement(head);
        continue;
      }
      if (head.value === 'group' || head.value === 'shared-network' || head.value === 'class') {
        if (head.value !== 'group') this.index++;
        const inner = this.block(this.tokens[this.index]);
        if (inner) this.nested(inner, options);
        continue;
      }

      const words = this.statement(head, this.arityOf(head.value));
      if (!words) return;
      if (this.applyParameter(head, words, options)) continue;
      this.fail(head, `unknown parameter ${head.value}.`);
    }
  }
}

function collectRanges(tokens: readonly Token[], into: { start: string; end: string }[]): void {
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].value !== 'range') continue;
    const first = tokens[i + 1]?.value ?? '';
    const second = tokens[i + 2]?.value ?? '';
    if (!IPV4.test(first)) continue;
    into.push({ start: first, end: IPV4.test(second) ? second : first });
  }
}

function collectHostRecord(tokens: readonly Token[]): {
  hardwareEthernet: string | null; fixedAddress: string | null; clientDuid: string | null;
  fixedAddress6: string | null; fixedPrefix6: { prefix: string; length: number } | null;
} {
  let hardwareEthernet: string | null = null;
  let fixedAddress: string | null = null;
  let clientDuid: string | null = null;
  let fixedAddress6: string | null = null;
  let fixedPrefix6: { prefix: string; length: number } | null = null;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].value === 'hardware' && tokens[i + 1]?.value === 'ethernet') {
      hardwareEthernet = (tokens[i + 2]?.value ?? '').toLowerCase();
    }
    if (tokens[i].value === 'fixed-address') {
      fixedAddress = tokens[i + 1]?.value ?? null;
    }
    if (tokens[i].value === 'host-identifier' && tokens[i + 1]?.value === 'option'
      && tokens[i + 2]?.value === 'dhcp6.client-id') {
      clientDuid = (tokens[i + 3]?.value ?? '').toLowerCase();
    }
    if (tokens[i].value === 'fixed-address6') fixedAddress6 = tokens[i + 1]?.value ?? null;
    if (tokens[i].value === 'fixed-prefix6' && IPV6_PREFIX.test(tokens[i + 1]?.value ?? '')) {
      const [prefix, length] = tokens[i + 1].value.split('/');
      fixedPrefix6 = { prefix, length: Number(length) };
    }
  }
  return { hardwareEthernet, fixedAddress, clientDuid, fixedAddress6, fixedPrefix6 };
}

export function parseDhcpdConf(text: string, path: string): DhcpdConfig {
  const globals = emptyOptions();
  const parser = new Parser(tokenize(text), path);
  parser.run(globals);
  return {
    globals, subnets: parser.subnets, subnets6: parser.subnets6, hosts: parser.hosts,
    authoritative: parser.authoritative, leasequery: parser.leasequery, pingCheck: parser.pingCheck ?? PING_CHECK_DEFAULT,
    pingTimeoutSeconds: parser.pingTimeoutSeconds, errors: parser.errors,
  };
}

/** `INTERFACESv4="eth0 eth1"` — the list `/etc/default/isc-dhcp-server` carries. */
export function parseDhcpdInterfaces(text: string, family: 'v4' | 'v6' = 'v4'): string[] {
  const variable = family === 'v4' ? 'INTERFACESv4' : 'INTERFACESv6';
  for (const line of text.split('\n')) {
    const clean = line.split('#')[0].trim();
    const match = new RegExp(`^${variable}\\s*=\\s*(.*)$`).exec(clean);
    if (!match) continue;
    return unquote(match[1].trim()).split(/[\s,]+/).filter(word => word.length > 0);
  }
  return [];
}
