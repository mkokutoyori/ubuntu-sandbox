import { IPAddress } from '@/network/core/types';
import type { ConfSection } from './FreeradiusConf';

export interface HomeServer {
  readonly name: string;
  readonly address: string;
  readonly port: number;
  readonly secret: string;
  readonly responseWindowMs: number;
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
}

export interface RadiusFormat {
  readonly format: 'suffix' | 'prefix';
  readonly delimiter: string;
  readonly ignoreDefault: boolean;
  readonly ignoreNull: boolean;
}

export interface ProxyConfig {
  readonly realms: readonly RealmDefinition[];
  readonly instances: ReadonlyMap<string, RadiusFormat>;
}

export const NO_PROXY: ProxyConfig = { realms: [], instances: new Map() };

const HOME_SERVER_KEYS = new Set(['type', 'ipaddr', 'ipv4addr', 'port', 'secret', 'response_window', 'proto']);
const POOL_KEYS = new Set(['type', 'home_server']);
const REALM_KEYS = new Set(['type', 'auth_pool', 'nostrip', 'authhost', 'secret']);
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
    const type = value(section, 'type') ?? 'auth';
    if (type !== 'auth' && type !== 'auth+acct' && type !== 'acct') return { error: `${located(section)}: Invalid type "${type}" for home server ${name}` };
    if ((value(section, 'proto') ?? 'udp') !== 'udp') return { error: `${located(section)}: The home server protocol "${value(section, 'proto')}" is not implemented in this simulator` };
    const address = value(section, 'ipaddr') ?? value(section, 'ipv4addr');
    if (address === undefined || IPAddress.tryParse(address) === null) return { error: `${located(section)}: No valid ipaddr found for home server ${name}` };
    const secret = value(section, 'secret');
    if (secret === undefined || secret === '') return { error: `${located(section)}: No shared secret defined for home server ${name}` };
    const port = Number(value(section, 'port') ?? (type === 'acct' ? 1813 : 1812));
    const windowSeconds = Number(value(section, 'response_window') ?? 20);
    homeServers.set(name, { name, address: IPAddress.tryParse(address)!.toString(), port, secret, responseWindowMs: windowSeconds * 1000 });
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
    let authPool: HomePool | null = null;
    const poolName = value(section, 'auth_pool');
    if (poolName !== undefined) {
      authPool = pools.get(poolName) ?? null;
      if (authPool === null) return { error: `${located(section)}: Failed to find home_server_pool "${poolName}"` };
    }
    const host = value(section, 'authhost');
    if (host !== undefined && host !== 'LOCAL') {
      const [address, portText] = host.split(':');
      const secret = value(section, 'secret');
      if (IPAddress.tryParse(address) === null || secret === undefined) return { error: `${located(section)}: Invalid authhost "${host}" or missing secret for realm ${name}` };
      const server: HomeServer = { name: `${name}-auth`, address: IPAddress.tryParse(address)!.toString(), port: portText === undefined ? 1812 : Number(portText), secret, responseWindowMs: 20000 };
      authPool = { name: `${name}-auth`, type: 'fail-over', servers: [server] };
    }
    let pattern: RegExp | null = null;
    if (name.startsWith('~')) {
      try { pattern = new RegExp(name.slice(1), 'i'); } catch { return { error: `${located(section)}: Invalid regular expression in realm name "${name}"` }; }
    }
    realms.push({ name, pattern, strip: !section.pairs.some((pair) => pair.name === 'nostrip'), authPool });
  }
  return { realms, instances };
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
