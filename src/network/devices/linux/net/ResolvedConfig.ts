import {
  booleanHandler, parseBoolean, readSystemdConfig, secHandler, wordsOf,
  type ConfigDiagnostic, type ConfigHandler, type ConfigSource, type ConfigSpec,
} from '../systemd/ConfigFiles';
import {
  defaultGlobalConfig, RESOLVED_CONF_PATH,
  type CacheMode, type DnsOverTlsMode, type DnssecMode, type DnsStubListenerMode, type ResolvedGlobalConfig, type StubListenerExtra, type TriState,
} from './ResolvedService';
import { formatDnsServerWord, parseDnsServerWord } from './DnsServerWord';

const LOG_WARNING = 4;
const DNS_PORT = 53;
const STUB_ADDRESS = '127.0.0.53';
const STUB_PROXY_ADDRESS = '127.0.0.54';
const NOT_ROUTABLE_ADDRESSES = new Set(['0.0.0.0', '::']);
const HOST_NAME_MAX = 253;
const LABEL_MAX = 63;

export function dnsNameIsValid(name: string): boolean {
  if (name === '.') return true;
  const trimmed = name.endsWith('.') ? name.slice(0, -1) : name;
  if (trimmed === '' || trimmed.length > HOST_NAME_MAX) return false;
  return trimmed.split('.').every((label) => label.length > 0 && label.length <= LABEL_MAX);
}

export function addDnsServers(list: string[], value: string, warn: (message: string) => void): void {
  for (const word of wordsOf(value, false)) {
    const parsed = parseDnsServerWord(word);
    if (parsed === null) {
      warn(`Failed to add DNS server address '${word}', ignoring: Invalid argument`);
      continue;
    }
    if (NOT_ROUTABLE_ADDRESSES.has(parsed.address) || parsed.address === STUB_ADDRESS || parsed.address === STUB_PROXY_ADDRESS) continue;
    const text = formatDnsServerWord(parsed);
    const existing = list.indexOf(text);
    if (existing >= 0) list.splice(existing, 1);
    list.push(text);
  }
}

export function addSearchDomains(list: string[], value: string, warn: (message: string) => void): void {
  for (const word of wordsOf(value, true)) {
    let routeOnly = word.startsWith('~');
    let domain = routeOnly ? word.slice(1) : word;
    if (domain === '.' || domain === '*') {
      routeOnly = true;
      domain = '.';
    }
    if (!dnsNameIsValid(domain)) {
      warn(`Failed to add search domain '${word}', ignoring: Invalid argument`);
      continue;
    }
    const entry = routeOnly ? `~${domain}` : domain;
    const existing = list.findIndex((candidate) => candidate.replace(/^~/, '') === domain);
    if (existing >= 0) list.splice(existing, 1);
    list.push(entry);
  }
}

function dnsServersHandler(target: () => string[], clear: () => void): ConfigHandler {
  return (value, _at, warn) => {
    if (value === '') clear();
    else addDnsServers(target(), value, (message) => warn(message, LOG_WARNING, false));
  };
}

function resolveSupportHandler(apply: (value: TriState) => void): ConfigHandler {
  return (value, _at, warn) => {
    const flag = parseBoolean(value);
    if (flag !== null) apply(flag ? 'yes' : 'no');
    else if (value === 'resolve') apply('resolve');
    else warn(`Failed to parse resolve support setting, ignoring: ${value}`);
  };
}

function dnssecHandler(apply: (value: DnssecMode) => void): ConfigHandler {
  return (value, _at, warn) => {
    const flag = parseBoolean(value);
    if (flag !== null) apply(flag ? 'yes' : 'no');
    else if (value === 'allow-downgrade') apply('allow-downgrade');
    else warn(`Failed to parse DNSSEC mode setting, ignoring: ${value}`);
  };
}

function dnsOverTlsHandler(apply: (value: DnsOverTlsMode) => void): ConfigHandler {
  return (value, _at, warn) => {
    const flag = parseBoolean(value);
    if (flag !== null) apply(flag ? 'yes' : 'no');
    else if (value === 'opportunistic') apply('opportunistic');
    else warn(`Failed to parse DNS-over-TLS mode setting, ignoring: ${value}`);
  };
}

function cacheHandler(apply: (value: CacheMode) => void): ConfigHandler {
  return (value, _at, warn) => {
    const flag = parseBoolean(value);
    if (flag !== null) apply(flag ? 'yes' : 'no');
    else if (value === 'no-negative') apply('no-negative');
    else warn(`Failed to parse DNS cache mode setting, ignoring: ${value}`);
  };
}

function stubListenerHandler(apply: (value: DnsStubListenerMode) => void): ConfigHandler {
  return (value, _at, warn) => {
    const flag = parseBoolean(value);
    if (flag !== null) apply(flag ? 'yes' : 'no');
    else if (value === 'udp' || value === 'tcp') apply(value);
    else warn(`Failed to parse DNS stub listener mode setting, ignoring: ${value}`);
  };
}

function stubExtraHandler(config: ResolvedGlobalConfig): ConfigHandler {
  return (value, at, warn) => {
    if (value === '') {
      config.dnsStubListenerExtra = [];
      return;
    }
    let mode: DnsStubListenerMode = 'yes';
    let address = value;
    if (value.startsWith('udp:')) {
      mode = 'udp';
      address = value.slice(4);
    } else if (value.startsWith('tcp:')) {
      mode = 'tcp';
      address = value.slice(4);
    }
    const parsed = parseDnsServerWord(address);
    if (parsed === null || parsed.interfaceName !== null || parsed.serverName !== null) {
      warn(`Failed to parse address in ${at.key}=${value}, ignoring assignment: Invalid argument`);
      return;
    }
    const listener: StubListenerExtra = { mode, address: parsed.address, port: parsed.port === 0 ? DNS_PORT : parsed.port };
    const duplicate = config.dnsStubListenerExtra.some((other) => other.mode === listener.mode && other.address === listener.address && other.port === listener.port);
    if (!duplicate) config.dnsStubListenerExtra.push(listener);
  };
}

function resolvedSpec(config: ResolvedGlobalConfig): ConfigSpec {
  const handlers = new Map<string, ConfigHandler>([
    ['Resolve.DNS', dnsServersHandler(() => config.dnsServers, () => { config.dnsServers = []; })],
    ['Resolve.FallbackDNS', dnsServersHandler(() => config.fallbackDns, () => { config.fallbackDns = []; })],
    ['Resolve.Domains', (value, _at, warn) => {
      if (value === '') config.domains = [];
      else addSearchDomains(config.domains, value, (message) => warn(message, LOG_WARNING, false));
    }],
    ['Resolve.LLMNR', resolveSupportHandler((value) => { config.llmnr = value; })],
    ['Resolve.MulticastDNS', resolveSupportHandler((value) => { config.mdns = value; })],
    ['Resolve.DNSSEC', dnssecHandler((value) => { config.dnssec = value; })],
    ['Resolve.DNSOverTLS', dnsOverTlsHandler((value) => { config.dnsOverTls = value; })],
    ['Resolve.Cache', cacheHandler((value) => { config.cacheMode = value; })],
    ['Resolve.DNSStubListener', stubListenerHandler((value) => { config.dnsStubListener = value; })],
    ['Resolve.ReadEtcHosts', booleanHandler((value) => { config.readEtcHosts = value; })],
    ['Resolve.ResolveUnicastSingleLabel', booleanHandler((value) => { config.resolveUnicastSingleLabel = value; })],
    ['Resolve.DNSStubListenerExtra', stubExtraHandler(config)],
    ['Resolve.CacheFromLocalhost', booleanHandler((value) => { config.cacheFromLocalhost = value; })],
    ['Resolve.StaleRetentionSec', secHandler((usec) => { config.staleRetentionUsec = usec; })],
  ]);
  return { mainFile: RESOLVED_CONF_PATH, dropInName: 'resolved.conf.d', sections: ['Resolve'], handlers };
}

export interface ResolvedConfigReadout {
  readonly config: ResolvedGlobalConfig;
  readonly diagnostics: ConfigDiagnostic[];
}

function applyKernelCommandLine(commandLine: string, config: ResolvedGlobalConfig, diagnostics: ConfigDiagnostic[]): void {
  const note = (message: string): void => { diagnostics.push({ priority: LOG_WARNING, file: '', line: 0, message }); };
  for (const word of wordsOf(commandLine, true)) {
    const equals = word.indexOf('=');
    if (equals < 0) continue;
    const key = word.slice(0, equals);
    const value = word.slice(equals + 1);
    if (key === 'nameserver') addDnsServers(config.dnsServers, value, (message) => note(message.replace(/^Failed to add DNS server address '([^']*)', ignoring: .*$/, "Failed to parse DNS server string '$1', ignoring.")));
    else if (key === 'domain') addSearchDomains(config.domains, value, (message) => note(message.replace(/^Failed to add search domain '([^']*)', ignoring: .*$/, "Failed to parse credential provided search domain string '$1', ignoring.")));
  }
}

export function readResolvedConfig(source: ConfigSource, kernelCommandLine = ''): ResolvedConfigReadout {
  const config = defaultGlobalConfig();
  const diagnostics = readSystemdConfig(source, resolvedSpec(config));
  applyKernelCommandLine(kernelCommandLine, config, diagnostics);
  return { config, diagnostics };
}

