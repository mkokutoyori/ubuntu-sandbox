import { IPAddress } from '@/network/core/types';
import type { ConfSection } from './FreeradiusConf';

export interface HomeServer {
  readonly name: string;
  readonly address: string;
  readonly port: number;
  readonly type: 'auth' | 'acct' | 'auth+acct';
  readonly acctPort: number | null;
  readonly secret: string;
  readonly responseWindowMs: number;
  readonly pingIntervalMs: number;
  readonly zombiePeriodMs: number;
  readonly reviveIntervalMs: number;
  readonly statusCheck: { intervalMs: number; timeoutMs: number; answers: number } | null;
}

export interface HomePool {
  readonly name: string;
  readonly type: string;
  readonly servers: readonly HomeServer[];
}

export interface RealmDefinition {
  readonly name: string;
  readonly pattern: RegExp | null;
  readonly strip: boolean;
  readonly authPool: HomePool | null;
  readonly acctPool: HomePool | null;
}

export interface RadiusFormat {
  readonly format: 'suffix' | 'prefix';
  readonly delimiter: string;
  readonly ignoreDefault: boolean;
  readonly ignoreNull: boolean;
}

export interface ProxyConfig {
  readonly realms: readonly RealmDefinition[];
  readonly homeServers: readonly HomeServer[];
  readonly instances: ReadonlyMap<string, RadiusFormat>;
}

export const NO_PROXY: ProxyConfig = { realms: [], homeServers: [], instances: new Map() };

const HOME_SERVER_KEYS = new Set(['type', 'ipaddr', 'ipv4addr', 'port', 'secret', 'response_window', 'proto', 'ping_interval', 'zombie_period', 'revive_interval', 'status_check', 'check_interval', 'check_timeout', 'num_answers_to_alive']);
const POOL_KEYS = new Set(['type', 'home_server']);
const REALM_KEYS = new Set(['type', 'auth_pool', 'acct_pool', 'nostrip', 'authhost', 'accthost', 'secret']);
const POOL_TYPES = new Set(['fail-over', 'load-balance', 'client-balance', 'client-port-balance', 'keyed-balance']);

function located(section: { file: string; line: number }): string {
  return `${section.file}[${section.line}]`;
}

function value(section: ConfSection, key: string): string | undefined {
  return section.pairs.find((pair) => pair.name === key)?.value;
}

function refuseUnknown(section: ConfSection, allowed: ReadonlySet<string>, what: string): string | null {
  for (const pair of section.pairs) {
    if (!allowed.has(pair.name)) return `${located(pair)}: The ${what} setting "${pair.name}" is not implemented in this simulator`;
  }
  return null;
}

export function readProxyConfig(root: ConfSection): ProxyConfig | { error: string } {
  const homeServers = new Map<string, HomeServer>();
  const pools = new Map<string, HomePool>();
  const realms: RealmDefinition[] = [];
  const instances = new Map<string, RadiusFormat>();
  const modules = root.sections.find((section) => section.name1 === 'modules') ?? root;
  for (const section of modules.sections.filter((candidate) => candidate.name1 === 'realm' && candidate.name2 !== null)) {
    const format = value(section, 'format') ?? 'suffix';
    if (format !== 'suffix' && format !== 'prefix') return { error: `${located(section)}: The realm format "${format}" is not implemented in this simulator` };
    const delimiter = value(section, 'delimiter') ?? '@';
    if (delimiter.length === 0) return { error: `${located(section)}: Invalid empty delimiter` };
    const flag = (key: string) => /^(yes|true|on)$/i.test(value(section, key) ?? 'no');
    instances.set(section.name2 as string, { format, delimiter: delimiter[0], ignoreDefault: flag('ignore_default'), ignoreNull: flag('ignore_null') });
  }
  for (const section of root.sections.filter((candidate) => candidate.name1 === 'home_server')) {
    const refusal = refuseUnknown(section, HOME_SERVER_KEYS, 'home_server');
    if (refusal !== null) return { error: refusal };
    const name = section.name2 ?? '';
    const type = value(section, 'type') ?? 'auth+acct';
    if (type !== 'auth' && type !== 'auth+acct' && type !== 'acct') return { error: `${located(section)}: Invalid type "${type}" for home server ${name}` };
    if ((value(section, 'proto') ?? 'udp') !== 'udp') return { error: `${located(section)}: The home server protocol "${value(section, 'proto')}" is not implemented in this simulator` };
    const address = value(section, 'ipaddr') ?? value(section, 'ipv4addr');
    if (address === undefined || IPAddress.tryParse(address) === null) return { error: `${located(section)}: No valid ipaddr found for home server ${name}` };
    const secret = value(section, 'secret');
    if (secret === undefined || secret === '') return { error: `${located(section)}: No shared secret defined for home server ${name}` };
    const port = Number(value(section, 'port') ?? (type === 'acct' ? 1813 : 1812));
    const acctPort = type === 'auth' ? null : type === 'acct' ? port : port + 1;
    const windowSeconds = Number(value(section, 'response_window') ?? 20);
    const bounded = (key: string, fallback: number, min: number, max: number): number | string => {
      const text = value(section, key);
      if (text === undefined) return fallback;
      const number = Number(text);
      return Number.isInteger(number) && number >= min && number <= max ? number : `${located(section)}: Invalid value "${text}" for variable ${key}`;
    };
    const ping = bounded('ping_interval', 30, 6, 120);
    const zombie = bounded('zombie_period', 40, 1, 120);
    const revive = bounded('revive_interval', 120, 60, 3600);
    const checkInterval = bounded('check_interval', 30, 6, 120);
    const checkTimeout = bounded('check_timeout', 4, 1, 10);
    const answers = bounded('num_answers_to_alive', 3, 1, 10);
    for (const checked of [ping, zombie, revive, checkInterval, checkTimeout, answers]) if (typeof checked === 'string') return { error: checked };
    const check = value(section, 'status_check') ?? 'none';
    if (check !== 'none' && check !== 'status-server') {
      return { error: `${located(section)}: ${check === 'request' ? 'The home_server status_check "request" is not implemented in this simulator: it needs a username and password to build an Access-Request' : `Invalid status_check "${check}" for home server ${name}`}` };
    }
    if (check === 'status-server' && type !== 'auth' && type !== 'acct' && type !== 'auth+acct') return { error: `${located(section)}: status_check = status-server is not valid for a home server of type ${type}` };
    homeServers.set(name, { name, address: IPAddress.tryParse(address)!.toString(), port, type, acctPort, secret, responseWindowMs: windowSeconds * 1000, pingIntervalMs: (ping as number) * 1000, zombiePeriodMs: (zombie as number) * 1000, reviveIntervalMs: (revive as number) * 1000, statusCheck: check === 'status-server' ? { intervalMs: (checkInterval as number) * 1000, timeoutMs: (checkTimeout as number) * 1000, answers: answers as number } : null });
  }
  for (const section of root.sections.filter((candidate) => candidate.name1 === 'home_server_pool')) {
    const refusal = refuseUnknown(section, POOL_KEYS, 'home_server_pool');
    if (refusal !== null) return { error: refusal };
    const name = section.name2 ?? '';
    const type = value(section, 'type') ?? 'fail-over';
    if (!POOL_TYPES.has(type)) return { error: `${located(section)}: Invalid type "${type}" for home server pool ${name}` };
    const servers: HomeServer[] = [];
    for (const pair of section.pairs.filter((candidate) => candidate.name === 'home_server')) {
      const server = homeServers.get(pair.value);
      if (server === undefined) return { error: `${located(pair)}: Unknown home_server "${pair.value}"` };
      servers.push(server);
    }
    if (servers.length === 0) return { error: `${located(section)}: No home_server defined in pool ${name}` };
    pools.set(name, { name, type, servers });
  }
  for (const section of root.sections.filter((candidate) => candidate.name1 === 'realm')) {
    const refusal = refuseUnknown(section, REALM_KEYS, 'realm');
    if (refusal !== null) return { error: refusal };
    const name = section.name2 ?? '';
    const poolFor = (poolKey: string, hostKey: string, suffix: string, defaultPort: number): HomePool | null | string => {
      const poolName = value(section, poolKey);
      if (poolName !== undefined) return pools.get(poolName) ?? `${located(section)}: Failed to find home_server_pool "${poolName}"`;
      const host = value(section, hostKey);
      if (host === undefined || host === 'LOCAL') return null;
      const [address, portText] = host.split(':');
      const secret = value(section, 'secret');
      if (IPAddress.tryParse(address) === null || secret === undefined) return `${located(section)}: Invalid ${hostKey} "${host}" or missing secret for realm ${name}`;
      const server: HomeServer = { name: `${name}-${suffix}`, address: IPAddress.tryParse(address)!.toString(), port: portText === undefined ? defaultPort : Number(portText), type: suffix === 'acct' ? 'acct' : 'auth', acctPort: suffix === 'acct' ? (portText === undefined ? defaultPort : Number(portText)) : null, secret, responseWindowMs: 20000, pingIntervalMs: 30000, zombiePeriodMs: 40000, reviveIntervalMs: 120000, statusCheck: null };
      return { name: server.name, type: 'fail-over', servers: [server] };
    };
    const authPool = poolFor('auth_pool', 'authhost', 'auth', 1812);
    if (typeof authPool === 'string') return { error: authPool };
    const acctPool = poolFor('acct_pool', 'accthost', 'acct', 1813);
    if (typeof acctPool === 'string') return { error: acctPool };
    const misused = authPool?.servers.find((server) => server.type === 'acct') ?? acctPool?.servers.find((server) => server.type === 'auth');
    if (misused !== undefined) return { error: `${located(section)}: Home server "${misused.name}" of type ${misused.type} cannot be used in an ${misused.type === 'acct' ? 'auth_pool' : 'acct_pool'}` };
    let pattern: RegExp | null = null;
    if (name.startsWith('~')) {
      try { pattern = new RegExp(name.slice(1), 'i'); } catch { return { error: `${located(section)}: Invalid regular expression in realm name "${name}"` }; }
    }
    realms.push({ name, pattern, strip: !section.pairs.some((pair) => pair.name === 'nostrip'), authPool, acctPool });
  }
  return { realms, homeServers: [...homeServers.values()], instances };
}

export function findRealm(config: ProxyConfig, name: string | null): RealmDefinition | null {
  const wanted = name ?? 'NULL';
  const exact = config.realms.find((realm) => realm.pattern === null && realm.name.toLowerCase() === wanted.toLowerCase());
  if (exact !== undefined) return exact;
  if (name !== null) {
    const regex = config.realms.find((realm) => realm.pattern !== null && realm.pattern.test(name));
    if (regex !== undefined) return regex;
  }
  return config.realms.find((realm) => realm.name === 'DEFAULT') ?? null;
}
