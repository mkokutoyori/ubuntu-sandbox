import { IPAddress } from '@/network/core/types';
import { AddressMatchList } from './NamedAcl';
import { NamedConfigError } from './NamedConfigError';
import type { NamedConfStatement } from './NamedConfParser';

export { NamedConfigError } from './NamedConfigError';

export type DnssecValidationMode = 'auto' | 'yes' | 'no';
export type ForwardMode = 'first' | 'only';
export type ZoneType = 'primary' | 'secondary' | 'forward' | 'hint';

export interface NamedOptions {
  readonly directory: string;
  readonly recursion: boolean;
  readonly queryLog: boolean;
  readonly dnssecValidation: DnssecValidationMode;
  readonly listenOnPort: number;
  readonly listenOn: AddressMatchList;
  readonly allowQuery: AddressMatchList;
  readonly allowRecursion: AddressMatchList;
  readonly allowTransfer: AddressMatchList;
  readonly forwarders: readonly string[];
  readonly forwardMode: ForwardMode;
}

export interface NamedZone {
  readonly name: string;
  readonly type: ZoneType;
  readonly file: string | null;
  readonly primaries: readonly string[];
  readonly alsoNotify: readonly string[];
  readonly allowTransfer: AddressMatchList | null;
  readonly forwarders: readonly string[];
  readonly declaredAt: { readonly file: string; readonly line: number };
}

export interface NamedLoggingChannel {
  readonly name: string;
  readonly target: 'file' | 'null';
  readonly path: string | null;
  readonly severity: string;
}

export interface NamedLogging {
  readonly channels: ReadonlyMap<string, NamedLoggingChannel>;
  readonly categories: ReadonlyMap<string, readonly string[]>;
}

export interface NamedKey {
  readonly name: string;
  readonly algorithm: string;
  readonly secret: string;
}

export interface NamedConfig {
  readonly options: NamedOptions;
  readonly zones: readonly NamedZone[];
  readonly acls: ReadonlyMap<string, AddressMatchList>;
  readonly logging: NamedLogging;
  readonly keys: ReadonlyMap<string, NamedKey>;
}

const DEFAULT_DIRECTORY = '/var/cache/bind';
const DEFAULT_DNS_PORT = 53;
const DEFAULT_SEVERITY = 'info';
const ZONE_TYPE_ALIASES: Readonly<Record<string, ZoneType>> = {
  primary: 'primary',
  master: 'primary',
  secondary: 'secondary',
  slave: 'secondary',
  forward: 'forward',
  hint: 'hint',
};

function fail(statement: NamedConfStatement, detail: string): never {
  throw new NamedConfigError(statement.file, statement.line, detail);
}

function keywordOf(statement: NamedConfStatement): string {
  return statement.values[0].text;
}

function argsOf(statement: NamedConfStatement): string[] {
  return statement.values.slice(1).map((v) => v.text);
}

function requireBlock(statement: NamedConfStatement): readonly NamedConfStatement[] {
  if (statement.block === null) {
    fail(statement, `expected '{' after '${keywordOf(statement)}'`);
  }
  return statement.block;
}

function parseBoolean(statement: NamedConfStatement): boolean {
  const value = argsOf(statement)[0];
  if (value === 'yes' || value === 'true') return true;
  if (value === 'no' || value === 'false') return false;
  return fail(statement, `expected boolean near '${value ?? ';'}'`);
}

function parseAddressList(statement: NamedConfStatement): string[] {
  const addresses: string[] = [];
  for (const entry of requireBlock(statement)) {
    const text = keywordOf(entry);
    if (!IPAddress.isValid(text)) fail(entry, `expected IP address near '${text}'`);
    addresses.push(text);
  }
  return addresses;
}

function normalizeZoneName(name: string): string {
  const lowered = name.toLowerCase();
  return lowered.endsWith('.') && lowered !== '.' ? lowered.slice(0, -1) : lowered;
}

interface MutableOptions {
  directory: string;
  recursion: boolean;
  queryLog: boolean;
  dnssecValidation: DnssecValidationMode;
  listenOnPort: number;
  listenOn: AddressMatchList;
  allowQuery: AddressMatchList;
  allowRecursion: AddressMatchList;
  allowTransfer: AddressMatchList;
  forwarders: string[];
  forwardMode: ForwardMode;
}

function defaultOptions(): MutableOptions {
  return {
    directory: DEFAULT_DIRECTORY,
    recursion: true,
    queryLog: false,
    dnssecValidation: 'auto',
    listenOnPort: DEFAULT_DNS_PORT,
    listenOn: AddressMatchList.any(),
    allowQuery: AddressMatchList.any(),
    allowRecursion: AddressMatchList.localTrust(),
    allowTransfer: AddressMatchList.any(),
    forwarders: [],
    forwardMode: 'first',
  };
}

function parseOptions(
  statement: NamedConfStatement,
  options: MutableOptions,
  acls: ReadonlyMap<string, AddressMatchList>,
): void {
  for (const entry of requireBlock(statement)) {
    const keyword = keywordOf(entry);
    const args = argsOf(entry);
    switch (keyword) {
      case 'directory':
        options.directory = args[0] ?? options.directory;
        break;
      case 'recursion':
        options.recursion = parseBoolean(entry);
        break;
      case 'querylog':
        options.queryLog = parseBoolean(entry);
        break;
      case 'forwarders':
        options.forwarders = parseAddressList(entry);
        break;
      case 'forward':
        if (args[0] !== 'only' && args[0] !== 'first') {
          fail(entry, `expected 'first' or 'only' near '${args[0] ?? ';'}'`);
        }
        options.forwardMode = args[0];
        break;
      case 'listen-on':
      case 'listen-on-v6': {
        let port = options.listenOnPort;
        if (args[0] === 'port') {
          const parsed = Number(args[1]);
          if (!Number.isInteger(parsed)) fail(entry, `expected port number near '${args[1] ?? ';'}'`);
          port = parsed;
        }
        if (keyword === 'listen-on') {
          options.listenOnPort = port;
          options.listenOn = AddressMatchList.fromStatements(requireBlock(entry), acls);
        }
        break;
      }
      case 'dnssec-validation':
        if (args[0] !== 'auto' && args[0] !== 'yes' && args[0] !== 'no') {
          fail(entry, `expected 'auto', 'yes' or 'no' near '${args[0] ?? ';'}'`);
        }
        options.dnssecValidation = args[0];
        break;
      case 'allow-query':
        options.allowQuery = AddressMatchList.fromStatements(requireBlock(entry), acls);
        break;
      case 'allow-recursion':
        options.allowRecursion = AddressMatchList.fromStatements(requireBlock(entry), acls);
        break;
      case 'allow-transfer':
        options.allowTransfer = AddressMatchList.fromStatements(requireBlock(entry), acls);
        break;
      default:
        fail(entry, `unknown option '${keyword}'`);
    }
  }
}

interface ZoneDraft {
  type: ZoneType | null;
  file: string | null;
  primaries: string[];
  alsoNotify: string[];
  allowTransfer: AddressMatchList | null;
  forwarders: string[];
}

function parseZoneEntries(
  statement: NamedConfStatement,
  zoneName: string,
  acls: ReadonlyMap<string, AddressMatchList>,
): ZoneDraft {
  const draft: ZoneDraft = {
    type: null, file: null, primaries: [], alsoNotify: [], allowTransfer: null, forwarders: [],
  };
  for (const entry of requireBlock(statement)) {
    const keyword = keywordOf(entry);
    const args = argsOf(entry);
    switch (keyword) {
      case 'type': {
        const type = ZONE_TYPE_ALIASES[args[0] ?? ''];
        if (!type) fail(statement, `zone '${zoneName}': unknown type '${args[0] ?? ''}'`);
        draft.type = type;
        break;
      }
      case 'file':
        draft.file = args[0] ?? null;
        break;
      case 'primaries':
      case 'masters':
        draft.primaries = parseAddressList(entry);
        break;
      case 'also-notify':
        draft.alsoNotify = parseAddressList(entry);
        break;
      case 'allow-transfer':
        draft.allowTransfer = AddressMatchList.fromStatements(requireBlock(entry), acls);
        break;
      case 'forwarders':
        draft.forwarders = parseAddressList(entry);
        break;
      default:
        fail(entry, `unknown option '${keyword}'`);
    }
  }
  return draft;
}

function validateZone(statement: NamedConfStatement, zoneName: string, draft: ZoneDraft): ZoneType {
  if (draft.type === null) fail(statement, `zone '${zoneName}': type not present`);
  if ((draft.type === 'primary' || draft.type === 'hint') && draft.file === null) {
    fail(statement, `zone '${zoneName}': missing 'file' entry`);
  }
  if (draft.type === 'secondary' && draft.primaries.length === 0) {
    fail(statement, `zone '${zoneName}': missing 'primaries' entry`);
  }
  if (draft.type === 'forward' && draft.forwarders.length === 0) {
    fail(statement, `zone '${zoneName}': missing 'forwarders' entry`);
  }
  return draft.type;
}

function resolveZoneFile(file: string | null, directory: string): string | null {
  if (file === null) return null;
  return file.startsWith('/') ? file : `${directory}/${file}`;
}

function parseZone(
  statement: NamedConfStatement,
  directory: string,
  acls: ReadonlyMap<string, AddressMatchList>,
  seen: Map<string, NamedZone>,
): NamedZone {
  const nameValue = statement.values[1];
  if (!nameValue) fail(statement, "expected zone name after 'zone'");
  const name = normalizeZoneName(nameValue.text);

  const previous = seen.get(name);
  if (previous) {
    fail(statement, `zone '${name}': already exists previous definition: ${previous.declaredAt.file}:${previous.declaredAt.line}`);
  }

  const draft = parseZoneEntries(statement, name, acls);
  const type = validateZone(statement, name, draft);

  return {
    name,
    type,
    file: resolveZoneFile(draft.file, directory),
    primaries: draft.primaries,
    alsoNotify: draft.alsoNotify,
    allowTransfer: draft.allowTransfer,
    forwarders: draft.forwarders,
    declaredAt: { file: statement.file, line: statement.line },
  };
}

function parseLogging(
  statement: NamedConfStatement,
  channels: Map<string, NamedLoggingChannel>,
  categories: Map<string, readonly string[]>,
): void {
  const entries = requireBlock(statement);
  for (const entry of entries) {
    if (keywordOf(entry) !== 'channel') continue;
    const name = argsOf(entry)[0];
    if (!name) fail(entry, "expected channel name after 'channel'");
    channels.set(name, parseChannel(entry, name));
  }
  for (const entry of entries) {
    const keyword = keywordOf(entry);
    if (keyword === 'channel') continue;
    if (keyword !== 'category') fail(entry, `unknown option '${keyword}'`);
    const name = argsOf(entry)[0];
    if (!name) fail(entry, "expected category name after 'category'");
    const channelNames: string[] = [];
    for (const ref of requireBlock(entry)) {
      const channelName = keywordOf(ref);
      if (!channels.has(channelName)) fail(entry, `channel '${channelName}': not defined`);
      channelNames.push(channelName);
    }
    categories.set(name, channelNames);
  }
}

function parseChannel(statement: NamedConfStatement, name: string): NamedLoggingChannel {
  let target: 'file' | 'null' = 'null';
  let path: string | null = null;
  let severity = DEFAULT_SEVERITY;
  for (const entry of requireBlock(statement)) {
    const keyword = keywordOf(entry);
    if (keyword === 'file') {
      target = 'file';
      path = argsOf(entry)[0] ?? null;
    } else if (keyword === 'null') {
      target = 'null';
      path = null;
    } else if (keyword === 'severity') {
      severity = argsOf(entry)[0] ?? DEFAULT_SEVERITY;
    }
  }
  return { name, target, path, severity };
}

function parseKey(statement: NamedConfStatement): NamedKey {
  const name = statement.values[1]?.text;
  if (!name) fail(statement, "expected key name after 'key'");
  let algorithm = '';
  let secret = '';
  for (const entry of requireBlock(statement)) {
    const keyword = keywordOf(entry);
    if (keyword === 'algorithm') algorithm = argsOf(entry)[0] ?? '';
    if (keyword === 'secret') secret = argsOf(entry)[0] ?? '';
  }
  return { name, algorithm, secret };
}

export function buildNamedConfig(statements: readonly NamedConfStatement[]): NamedConfig {
  const acls = new Map<string, AddressMatchList>();
  const options = defaultOptions();
  const channels = new Map<string, NamedLoggingChannel>();
  const categories = new Map<string, readonly string[]>();
  const keys = new Map<string, NamedKey>();
  const zoneStatements: NamedConfStatement[] = [];

  for (const statement of statements) {
    const keyword = keywordOf(statement);
    switch (keyword) {
      case 'acl': {
        const name = statement.values[1]?.text;
        if (!name) fail(statement, "expected ACL name after 'acl'");
        if (acls.has(name)) fail(statement, `attempt to redefine ACL '${name}'`);
        acls.set(name, AddressMatchList.fromStatements(requireBlock(statement), acls));
        break;
      }
      case 'options':
        parseOptions(statement, options, acls);
        break;
      case 'zone':
        zoneStatements.push(statement);
        break;
      case 'logging':
        parseLogging(statement, channels, categories);
        break;
      case 'key': {
        const key = parseKey(statement);
        keys.set(key.name, key);
        break;
      }
      case 'controls':
        break;
      default:
        fail(statement, `unknown option '${keyword}'`);
    }
  }

  const zoneMap = new Map<string, NamedZone>();
  const zones: NamedZone[] = [];
  for (const statement of zoneStatements) {
    const zone = parseZone(statement, options.directory, acls, zoneMap);
    zoneMap.set(zone.name, zone);
    zones.push(zone);
  }

  return {
    options,
    zones,
    acls,
    logging: { channels, categories },
    keys,
  };
}
