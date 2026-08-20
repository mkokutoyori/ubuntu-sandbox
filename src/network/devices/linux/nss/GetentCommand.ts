/**
 * `getent` — query the Name Service Switch databases.
 *
 * Faithful subset of the GNU getent(1) implementation:
 *
 *   getent [OPTION...] database [key ...]
 *
 *   Supported databases: passwd group shadow gshadow hosts ahosts
 *                        ahostsv4 ahostsv6 services protocols networks
 *                        ethers rpc netgroup initgroups
 *
 *   Options:
 *     -s, --service=CONFIG  consult a specific source list (e.g. "files")
 *     -i, --no-idn          (accepted, no-op — sim has no IDN names)
 *     -h, --help            usage banner
 *     -V, --version         version banner
 *
 *   Keys:
 *     passwd        name|uid
 *     group         name|gid
 *     shadow        name
 *     hosts         name|address
 *     services      name[/proto] | port[/proto]
 *     protocols     name|number
 *     networks      name|address
 *     ethers        mac|host
 *     rpc           name|number
 *
 * Exit codes (matches glibc):
 *   0  → SUCCESS — at least one record returned
 *   1  → SUCCESS but a key was missing on enumerate-only databases
 *   2  → "Key not found" (the most common error)
 *   3  → ENUMERATE not supported on this database
 */

import type { INssSource } from './INssSource';
import type { NameServiceSwitch } from './NameServiceSwitch';
import { FilesNssSource } from './FilesNssSource';
import { GetentFormatter } from './GetentFormatter';
import type {
  NssEnumResult, NssResult,
  NssEthersEntry, NssGroupEntry, NssGshadowEntry, NssHostEntry,
  NssAliasEntry,
  NssNetgroupEntry, NssNetworkEntry, NssPasswdEntry, NssProtocolEntry,
  NssRpcEntry, NssServiceEntry, NssShadowEntry,
} from './types';

export interface GetentResult {
  output: string;
  exitCode: number;
}

const VERSION_LINE = 'getent (Ubuntu GLIBC 2.35-0ubuntu3.4) 2.35';

const USAGE = [
  'Usage: getent [OPTION...] database [key ...]',
  'Get entries from administrative database.',
  '',
  '  -i, --no-idn               disable IDN encoding',
  '  -s, --service=CONFIG       Service configuration to be used',
  '  -?, --help                 Give this help list',
  '      --usage                Give a short usage message',
  '  -V, --version              Print program version',
  '',
  'Supported databases:',
  'ahosts ahostsv4 ahostsv6 aliases ethers group gshadow hosts initgroups',
  'netgroup networks passwd protocols rpc services shadow',
  '',
].join('\n');

/**
 * Parse the argument list. Returns `{ ok, options, args }` or
 * `{ ok: false, message }` on malformed input.
 */
interface ParsedServiceOverride {
  global: string | null;
  perDb: Map<string, string>;
}

function applyServiceConfig(config: string, into: ParsedServiceOverride): void {
  const colon = config.indexOf(':');
  if (colon === -1) {
    into.global = config.toLowerCase();
  } else {
    into.perDb.set(config.slice(0, colon).toLowerCase(), config.slice(colon + 1).toLowerCase());
  }
}

function parseArgs(argv: string[]):
  | { ok: true; service: ParsedServiceOverride; database: string; keys: string[] }
  | { ok: false; output: string; exitCode: number } {
  const service: ParsedServiceOverride = { global: null, perDb: new Map() };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '-h' || a === '--help' || a === '-?') {
      return { ok: false, output: USAGE, exitCode: 0 };
    }
    if (a === '--usage') {
      return { ok: false, output: 'Usage: getent [-Vh?] [-i] [-s CONFIG] [--service=CONFIG] [--no-idn] [--help] [--usage] [--version] database [key ...]', exitCode: 0 };
    }
    if (a === '-V' || a === '--version') {
      return { ok: false, output: VERSION_LINE, exitCode: 0 };
    }
    if (a === '-i' || a === '--no-idn') { i++; continue; }
    if (a === '-s' || a === '--service') {
      if (i + 1 >= argv.length) {
        return { ok: false, output: USAGE, exitCode: 1 };
      }
      applyServiceConfig(argv[i + 1], service);
      i += 2;
      continue;
    }
    if (a.startsWith('--service=')) {
      applyServiceConfig(a.slice('--service='.length), service);
      i++;
      continue;
    }
    if (a.startsWith('-')) {
      return { ok: false, output: `getent: unrecognized option '${a}'`, exitCode: 1 };
    }
    break;
  }

  if (i >= argv.length) {
    return { ok: false, output: USAGE, exitCode: 1 };
  }
  const database = argv[i].toLowerCase();
  const keys = argv.slice(i + 1);
  return { ok: true, service, database, keys };
}

/**
 * Resolve a single database lookup or enumeration through the NSS.
 * Returns the canonical text output and exit code.
 */
export function runGetent(
  nss: NameServiceSwitch,
  argv: string[],
  fallbackFilesSource: FilesNssSource,
): GetentResult {
  const parsed = parseArgs(argv);
  if (parsed.ok === false) return { output: parsed.output, exitCode: parsed.exitCode };

  const overrideFor = (database: string): string | null =>
    parsed.service.perDb.get(database) ?? parsed.service.global;

  // The resolver caches per (database, key); handlers pass no key of
  // their own, so the invocation's own argv plus the position of the
  // call in the (deterministic) call sequence identifies it exactly.
  const invocation = argv.join(' ');
  let callSeq = 0;

  const resolveSingle = <T>(database: string, fn: (s: INssSource) => NssResult<T> | undefined): NssResult<T> => {
    const ov = overrideFor(database);
    if (ov === 'files') return fn(fallbackFilesSource) ?? { status: 'UNAVAIL' };
    if (ov) return nss.lookupVia<T>(ov, fn);
    return nss.lookup<T>(database, fn, `${invocation}#${callSeq++}`);
  };
  const resolveEnum = <T>(database: string, fn: (s: INssSource) => NssEnumResult<T> | undefined): NssEnumResult<T> => {
    const ov = overrideFor(database);
    if (ov === 'files') return fn(fallbackFilesSource) ?? { status: 'UNAVAIL', entries: [] };
    if (ov) return nss.enumerateVia<T>(ov, fn);
    return nss.enumerate<T>(database, fn, `${invocation}#${callSeq++}`);
  };

  switch (parsed.database) {
    case 'passwd':    return handlePasswd(resolveSingle, resolveEnum, parsed.keys);
    case 'group':     return handleGroup(resolveSingle, resolveEnum, parsed.keys);
    case 'shadow':    return handleShadow(resolveSingle, resolveEnum, parsed.keys);
    case 'gshadow':   return handleGshadow(resolveSingle, resolveEnum, parsed.keys);
    case 'hosts':
    case 'ahosts':
    case 'ahostsv4':
    case 'ahostsv6':
      return handleHostsDb(resolveSingle, resolveEnum, parsed.database, parsed.keys);
    case 'services':  return handleServices(resolveSingle, resolveEnum, parsed.keys);
    case 'protocols': return handleProtocols(resolveSingle, resolveEnum, parsed.keys);
    case 'networks':  return handleNetworks(resolveSingle, resolveEnum, parsed.keys);
    case 'ethers':    return handleEthers(resolveSingle, resolveEnum, parsed.keys);
    case 'rpc':       return handleRpc(resolveSingle, resolveEnum, parsed.keys);
    case 'netgroup':  return handleNetgroup(resolveSingle, resolveEnum, parsed.keys);
    case 'initgroups':return handleInitgroups(resolveSingle, parsed.keys);
    case 'aliases':   return handleAliases(resolveSingle, resolveEnum, parsed.keys);
    default:
      return { output: `Unknown database: ${parsed.database}`, exitCode: 1 };
  }
}

const HOST_DATABASES = new Set(['hosts', 'ahosts', 'ahostsv4', 'ahostsv6']);

/**
 * Le vrai `getent`. Seule la base `hosts` a besoin d'attendre — valider
 * (DNSSEC) ou chiffrer (DoT) demande des allers-retours qui ne peuvent
 * pas tenir dans la pile d'appel de l'appelant. Toutes les autres bases
 * se lisent dans le VFS et repartent sur {@link runGetent} inchangé.
 */
export async function runGetentAsync(
  nss: NameServiceSwitch,
  argv: string[],
  fallbackFilesSource: FilesNssSource,
): Promise<GetentResult> {
  const parsed = parseArgs(argv);
  if (parsed.ok === false) return { output: parsed.output, exitCode: parsed.exitCode };
  if (!HOST_DATABASES.has(parsed.database)) {
    return runGetent(nss, argv, fallbackFilesSource);
  }

  const overrideFor = (database: string): string | null =>
    parsed.service.perDb.get(database) ?? parsed.service.global;

  const resolveSingle = async <T>(
    database: string,
    fn: (s: INssSource) => NssResult<T> | Promise<NssResult<T>> | undefined,
  ): Promise<NssResult<T>> => {
    const ov = overrideFor(database);
    if (ov === 'files') return await fn(fallbackFilesSource) ?? { status: 'UNAVAIL' };
    if (ov) return nss.lookupViaAsync<T>(ov, fn);
    return nss.lookupAsync<T>(database, fn);
  };
  const resolveEnum = <T>(database: string, fn: (s: INssSource) => NssEnumResult<T> | undefined): NssEnumResult<T> => {
    const ov = overrideFor(database);
    if (ov === 'files') return fn(fallbackFilesSource) ?? { status: 'UNAVAIL', entries: [] };
    if (ov) return nss.enumerateVia<T>(ov, fn);
    return nss.enumerate<T>(database, fn);
  };

  return handleHostsDbAsync(resolveSingle, resolveEnum, parsed.database, parsed.keys);
}

type SingleFn = <T>(db: string, fn: (s: INssSource) => NssResult<T> | undefined) => NssResult<T>;
type EnumFn   = <T>(db: string, fn: (s: INssSource) => NssEnumResult<T> | undefined) => NssEnumResult<T>;
type AsyncSingleFn = <T>(
  db: string, fn: (s: INssSource) => NssResult<T> | Promise<NssResult<T>> | undefined,
) => Promise<NssResult<T>>;

function handlePasswd(single: SingleFn, enumerate: EnumFn, keys: string[]): GetentResult {
  if (keys.length === 0) {
    const r = enumerate<NssPasswdEntry>('passwd', s => s.enumPasswd?.());
    return { output: r.entries.map(GetentFormatter.passwd).join('\n'), exitCode: 0 };
  }
  const out: string[] = [];
  let allOk = true;
  for (const k of keys) {
    const numeric = /^\d+$/.test(k);
    const r = numeric
      ? single<NssPasswdEntry>('passwd', s => s.getpwuid?.(parseInt(k, 10)))
      : single<NssPasswdEntry>('passwd', s => s.getpwnam?.(k));
    if (r.status === 'SUCCESS' && r.entry) {
      out.push(GetentFormatter.passwd(r.entry));
    } else {
      allOk = false;
    }
  }
  return { output: out.join('\n'), exitCode: allOk && out.length ? 0 : 2 };
}

function handleGroup(single: SingleFn, enumerate: EnumFn, keys: string[]): GetentResult {
  if (keys.length === 0) {
    const r = enumerate<NssGroupEntry>('group', s => s.enumGroup?.());
    return { output: r.entries.map(GetentFormatter.group).join('\n'), exitCode: 0 };
  }
  const out: string[] = [];
  let allOk = true;
  for (const k of keys) {
    const numeric = /^\d+$/.test(k);
    const r = numeric
      ? single<NssGroupEntry>('group', s => s.getgrgid?.(parseInt(k, 10)))
      : single<NssGroupEntry>('group', s => s.getgrnam?.(k));
    if (r.status === 'SUCCESS' && r.entry) out.push(GetentFormatter.group(r.entry));
    else allOk = false;
  }
  return { output: out.join('\n'), exitCode: allOk && out.length ? 0 : 2 };
}

function handleShadow(single: SingleFn, enumerate: EnumFn, keys: string[]): GetentResult {
  if (keys.length === 0) {
    const r = enumerate<NssShadowEntry>('shadow', s => s.enumShadow?.());
    return { output: r.entries.map(GetentFormatter.shadow).join('\n'), exitCode: 0 };
  }
  const out: string[] = [];
  let allOk = true;
  for (const k of keys) {
    const r = single<NssShadowEntry>('shadow', s => s.getspnam?.(k));
    if (r.status === 'SUCCESS' && r.entry) out.push(GetentFormatter.shadow(r.entry));
    else allOk = false;
  }
  return { output: out.join('\n'), exitCode: allOk && out.length ? 0 : 2 };
}

function handleGshadow(single: SingleFn, enumerate: EnumFn, keys: string[]): GetentResult {
  if (keys.length === 0) {
    const r = enumerate<NssGshadowEntry>('gshadow', s => s.enumGshadow?.());
    return { output: r.entries.map(GetentFormatter.gshadow).join('\n'), exitCode: 0 };
  }
  const out: string[] = [];
  let allOk = true;
  for (const k of keys) {
    const r = single<NssGshadowEntry>('gshadow', s => s.getsgnam?.(k));
    if (r.status === 'SUCCESS' && r.entry) out.push(GetentFormatter.gshadow(r.entry));
    else allOk = false;
  }
  return { output: out.join('\n'), exitCode: allOk && out.length ? 0 : 2 };
}

/**
 * La base `hosts` est la seule qui puisse partir sur le réseau, donc la
 * seule à exister en deux versions : synchrone et asynchrone. Pour que
 * les deux ne divergent jamais, tout ce qui décide — quelle recherche
 * pour quelle clé, ce qui compte comme trouvé, le code de retour, le
 * rendu — vit ici, et les deux pilotes ci-dessous ne font qu'attendre,
 * ou pas.
 */
type HostLookupSpec = {
  /** La recherche à faire pour cette clé. */
  invoke: (s: INssSource) => NssResult<NssHostEntry | NssHostEntry[]> | undefined;
  /** Sa contrepartie qui a le droit d'attendre. */
  invokeAsync: (s: INssSource) => Promise<NssResult<NssHostEntry | NssHostEntry[]>> | undefined;
};

function hostsSpec(database: string, key: string): HostLookupSpec {
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(key) || key.includes(':');
  if (database === 'hosts' && isIp) {
    return {
      invoke: (s) => s.gethostbyaddr?.(key),
      invokeAsync: (s) => s.gethostbyaddrAsync?.(key),
    };
  }
  const family = database === 'ahostsv4' ? 2 : database === 'ahostsv6' ? 10 : undefined;
  return {
    invoke: (s) => s.gethostbyname?.(key, family),
    invokeAsync: (s) => s.gethostbynameAsync?.(key, family),
  };
}

/** Les lignes rendues pour une clé, ou null quand rien n'a été trouvé. */
function hostLines(
  r: NssResult<NssHostEntry | NssHostEntry[]>,
  format: (h: NssHostEntry) => string | string[],
): string[] | null {
  if (r.status !== 'SUCCESS' || r.entry === undefined) return null;
  const entries = Array.isArray(r.entry) ? r.entry : [r.entry];
  const lines = entries.flatMap((h) => {
    const rendered = format(h);
    return Array.isArray(rendered) ? rendered : [rendered];
  });
  return lines;
}

function hostsFormatter(database: string): (h: NssHostEntry) => string | string[] {
  return database === 'hosts' ? GetentFormatter.host : GetentFormatter.ahosts;
}

function enumerateHosts(enumerate: EnumFn, database: string): GetentResult {
  const r = enumerate<NssHostEntry>(database, s => s.enumHosts?.());
  if (database === 'hosts') {
    return { output: r.entries.map(GetentFormatter.host).join('\n'), exitCode: 0 };
  }
  const family = database === 'ahostsv4' ? 2 : database === 'ahostsv6' ? 10 : null;
  const out = r.entries
    .filter(h => family === null || h.addressFamily === family)
    .flatMap(GetentFormatter.ahosts);
  return { output: out.join('\n'), exitCode: out.length ? 0 : 1 };
}

function handleHostsDb(
  single: SingleFn, enumerate: EnumFn, database: string, keys: string[],
): GetentResult {
  if (keys.length === 0) return enumerateHosts(enumerate, database);
  const format = hostsFormatter(database);
  const out: string[] = [];
  let allOk = true;
  for (const k of keys) {
    const r = single<NssHostEntry | NssHostEntry[]>(database, hostsSpec(database, k).invoke);
    const lines = hostLines(r, format);
    if (lines) out.push(...lines); else allOk = false;
  }
  return { output: out.join('\n'), exitCode: allOk && out.length ? 0 : 2 };
}

async function handleHostsDbAsync(
  single: AsyncSingleFn, enumerate: EnumFn, database: string, keys: string[],
): Promise<GetentResult> {
  if (keys.length === 0) return enumerateHosts(enumerate, database);
  const format = hostsFormatter(database);
  const out: string[] = [];
  let allOk = true;
  for (const k of keys) {
    const spec = hostsSpec(database, k);
    const r = await single<NssHostEntry | NssHostEntry[]>(
      database, (s) => spec.invokeAsync(s) ?? spec.invoke(s),
    );
    const lines = hostLines(r, format);
    if (lines) out.push(...lines); else allOk = false;
  }
  return { output: out.join('\n'), exitCode: allOk && out.length ? 0 : 2 };
}

function handleServices(single: SingleFn, enumerate: EnumFn, keys: string[]): GetentResult {
  if (keys.length === 0) {
    const r = enumerate<NssServiceEntry>('services', s => s.enumServices?.());
    return { output: r.entries.map(GetentFormatter.service).join('\n'), exitCode: 0 };
  }
  const out: string[] = [];
  let allOk = true;
  for (const k of keys) {
    const slash = k.indexOf('/');
    const left = slash === -1 ? k : k.slice(0, slash);
    const proto = slash === -1 ? undefined : k.slice(slash + 1);
    const numeric = /^\d+$/.test(left);
    const r = numeric
      ? single<NssServiceEntry>('services', s => s.getservbyport?.(parseInt(left, 10), proto))
      : single<NssServiceEntry>('services', s => s.getservbyname?.(left, proto));
    if (r.status === 'SUCCESS' && r.entry) out.push(GetentFormatter.service(r.entry));
    else allOk = false;
  }
  return { output: out.join('\n'), exitCode: allOk && out.length ? 0 : 2 };
}

function handleProtocols(single: SingleFn, enumerate: EnumFn, keys: string[]): GetentResult {
  if (keys.length === 0) {
    const r = enumerate<NssProtocolEntry>('protocols', s => s.enumProtocols?.());
    return { output: r.entries.map(GetentFormatter.protocol).join('\n'), exitCode: 0 };
  }
  const out: string[] = [];
  let allOk = true;
  for (const k of keys) {
    const numeric = /^\d+$/.test(k);
    const r = numeric
      ? single<NssProtocolEntry>('protocols', s => s.getprotobynumber?.(parseInt(k, 10)))
      : single<NssProtocolEntry>('protocols', s => s.getprotobyname?.(k));
    if (r.status === 'SUCCESS' && r.entry) out.push(GetentFormatter.protocol(r.entry));
    else allOk = false;
  }
  return { output: out.join('\n'), exitCode: allOk && out.length ? 0 : 2 };
}

function handleNetworks(single: SingleFn, enumerate: EnumFn, keys: string[]): GetentResult {
  if (keys.length === 0) {
    const r = enumerate<NssNetworkEntry>('networks', s => s.enumNetworks?.());
    return { output: r.entries.map(GetentFormatter.network).join('\n'), exitCode: 0 };
  }
  const out: string[] = [];
  let allOk = true;
  for (const k of keys) {
    const isAddr = /^\d{1,3}(\.\d{1,3}){0,3}$/.test(k);
    const r = isAddr
      ? single<NssNetworkEntry>('networks', s => s.getnetbyaddr?.(k))
      : single<NssNetworkEntry>('networks', s => s.getnetbyname?.(k));
    if (r.status === 'SUCCESS' && r.entry) out.push(GetentFormatter.network(r.entry));
    else allOk = false;
  }
  return { output: out.join('\n'), exitCode: allOk && out.length ? 0 : 2 };
}

function handleEthers(single: SingleFn, enumerate: EnumFn, keys: string[]): GetentResult {
  if (keys.length === 0) {
    const r = enumerate<NssEthersEntry>('ethers', s => s.enumEthers?.());
    return { output: r.entries.map(GetentFormatter.ethers).join('\n'), exitCode: 0 };
  }
  const out: string[] = [];
  let allOk = true;
  for (const k of keys) {
    const isMac = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i.test(k);
    const r = isMac
      ? single<NssEthersEntry>('ethers', s => s.getetherbyaddr?.(k))
      : single<NssEthersEntry>('ethers', s => s.getetherbyname?.(k));
    if (r.status === 'SUCCESS' && r.entry) out.push(GetentFormatter.ethers(r.entry));
    else allOk = false;
  }
  return { output: out.join('\n'), exitCode: allOk && out.length ? 0 : 2 };
}

function handleRpc(single: SingleFn, enumerate: EnumFn, keys: string[]): GetentResult {
  if (keys.length === 0) {
    const r = enumerate<NssRpcEntry>('rpc', s => s.enumRpc?.());
    return { output: r.entries.map(GetentFormatter.rpc).join('\n'), exitCode: 0 };
  }
  const out: string[] = [];
  let allOk = true;
  for (const k of keys) {
    const numeric = /^\d+$/.test(k);
    const r = numeric
      ? single<NssRpcEntry>('rpc', s => s.getrpcbynumber?.(parseInt(k, 10)))
      : single<NssRpcEntry>('rpc', s => s.getrpcbyname?.(k));
    if (r.status === 'SUCCESS' && r.entry) out.push(GetentFormatter.rpc(r.entry));
    else allOk = false;
  }
  return { output: out.join('\n'), exitCode: allOk && out.length ? 0 : 2 };
}

function handleNetgroup(single: SingleFn, enumerate: EnumFn, keys: string[]): GetentResult {
  if (keys.length === 0) {
    const r = enumerate<NssNetgroupEntry>('netgroup', s => s.enumNetgroup?.());
    return { output: r.entries.map(GetentFormatter.netgroup).join('\n'), exitCode: 0 };
  }
  const out: string[] = [];
  let allOk = true;
  for (const k of keys) {
    const r = single<NssNetgroupEntry>('netgroup', s => s.getnetgrent?.(k));
    if (r.status === 'SUCCESS' && r.entry) out.push(GetentFormatter.netgroup(r.entry));
    else allOk = false;
  }
  return { output: out.join('\n'), exitCode: allOk && out.length ? 0 : 2 };
}

function handleAliases(single: SingleFn, enumerate: EnumFn, keys: string[]): GetentResult {
  if (keys.length === 0) {
    const r = enumerate<NssAliasEntry>('aliases', s => s.enumAliases?.());
    return { output: r.entries.map(GetentFormatter.alias).join('\n'), exitCode: 0 };
  }
  const out: string[] = [];
  let allOk = true;
  for (const k of keys) {
    const r = single<NssAliasEntry>('aliases', s => s.getaliasbyname?.(k));
    if (r.status === 'SUCCESS' && r.entry) out.push(GetentFormatter.alias(r.entry));
    else allOk = false;
  }
  return { output: out.join('\n'), exitCode: allOk && out.length ? 0 : 2 };
}

function handleInitgroups(single: SingleFn, keys: string[]): GetentResult {
  // `getent initgroups <user>` — output is `<user>  gid1 gid2 ...`.
  if (keys.length === 0) return { output: '', exitCode: 1 };
  const out: string[] = [];
  let allOk = true;
  for (const user of keys) {
    const r = single<number[]>('initgroups', s => s.initgroups?.(user));
    if (r.status === 'SUCCESS' && r.entry) {
      out.push(`${user.padEnd(15)} ${r.entry.join(' ')}`);
    } else allOk = false;
  }
  return { output: out.join('\n'), exitCode: allOk && out.length ? 0 : 2 };
}
