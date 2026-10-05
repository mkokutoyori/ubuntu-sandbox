import {
  REGISTRY_ROOT_NAMES,
  parseRegistryAddress,
  type RegistryAddress,
  type RegistryKeyView,
  type RegistryValue,
  type RegistryValueType,
} from './PSRegistryProvider';
import { parseRegFile, renderRegFile } from './WinRegFile';
import { REG_HELP, REG_OPERATION_HELP } from './WinRegHelp';

export interface WinRegistry {
  keyView(address: RegistryAddress): RegistryKeyView | null;
  createKey(address: RegistryAddress): boolean;
  setValue(address: RegistryAddress, name: string, type: RegistryValueType, value: string | number): boolean;
  deleteValue(address: RegistryAddress, name: string): boolean;
  deleteAllValues(address: RegistryAddress): boolean;
  deleteKey(address: RegistryAddress): boolean;
  writesUserHive(address: RegistryAddress): boolean;
}

export interface WinRegHost {
  readonly registry: WinRegistry;
  readonly isAdmin: boolean;
  readonly computerName: string;
  readonly files: {
    read(path: string): string | null;
    write(path: string, content: string): boolean;
    exists(path: string): boolean;
    normalize(path: string): string;
  };
  readonly interactive: boolean;
  ask(prompt: string): Promise<string | null>;
}

export interface RegResult {
  readonly output: string;
  readonly exitCode: number;
}

const OK = 'The operation completed successfully.';
const NOT_FOUND = 'ERROR: The system was unable to find the specified registry key or value.';
const DENIED = 'ERROR: Access is denied.';
const CANCELED = 'The operation was canceled by the user.';
const NOT_SUPPORTED = 'ERROR: The request is not supported.';

const failure = (output: string): RegResult => ({ output, exitCode: 1 });
const success = (output: string): RegResult => ({ output, exitCode: 0 });
const syntaxError = (operation: string): RegResult =>
  failure(`ERROR: Invalid syntax.\nType "REG ${operation.toUpperCase()} /?" for usage.`);
const invalidKey = (operation: string): RegResult =>
  failure(`ERROR: Invalid key name.\nType "REG ${operation.toUpperCase()} /?" for usage.`);

const TYPE_NAMES: Readonly<Record<RegistryValueType, string>> = {
  String: 'REG_SZ', ExpandString: 'REG_EXPAND_SZ', MultiString: 'REG_MULTI_SZ', DWord: 'REG_DWORD',
  QWord: 'REG_QWORD', Binary: 'REG_BINARY', None: 'REG_NONE', DWordBigEndian: 'REG_DWORD_BIG_ENDIAN',
  Link: 'REG_LINK', ResourceList: 'REG_FULL_RESOURCE_DESCRIPTOR',
};

const TYPE_NUMBERS: Readonly<Record<RegistryValueType, number>> = {
  None: 0, String: 1, ExpandString: 2, Binary: 3, DWord: 4, DWordBigEndian: 5, Link: 6, MultiString: 7, ResourceList: 9, QWord: 11,
};

const TYPES_BY_NAME: Readonly<Record<string, RegistryValueType>> = Object.fromEntries(
  Object.entries(TYPE_NAMES).map(([type, name]) => [name, type as RegistryValueType]),
);

const RESTRICTED_HIVES = new Set(['sam', 'security']);

interface Switches {
  readonly valueName: string | null;
  readonly defaultValue: boolean;
  readonly allValues: boolean;
  readonly type: string | null;
  readonly separator: string | null;
  readonly data: string | null;
  readonly force: boolean;
  readonly recursive: boolean;
  readonly search: string | null;
  readonly searchKeys: boolean;
  readonly searchData: boolean;
  readonly caseSensitive: boolean;
  readonly exact: boolean;
  readonly verbose: boolean;
  readonly view: 32 | 64 | null;
  readonly positional: readonly string[];
}

function parseSwitches(operation: string, args: readonly string[]): Switches | null {
  const state = {
    valueName: null as string | null, defaultValue: false, allValues: false, type: null as string | null,
    separator: null as string | null, data: null as string | null, force: false, recursive: false,
    search: null as string | null, searchKeys: false, searchData: false, caseSensitive: false, exact: false,
    verbose: false, view: null as 32 | 64 | null,
  };
  const positional: string[] = [];
  const querying = operation === 'query';
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    const lowered = argument.toLowerCase();
    const next = (): string | null => (index + 1 < args.length ? args[++index] : null);
    if (lowered === '/reg:32') state.view = 32;
    else if (lowered === '/reg:64') state.view = 64;
    else if (lowered === '/v' && (operation === 'add' || operation === 'delete' || querying)) {
      const upcoming = args[index + 1];
      if (querying && (upcoming === undefined || upcoming.startsWith('/'))) state.valueName = '';
      else {
        const taken = next();
        if (taken === null) return null;
        state.valueName = taken;
      }
    } else if (lowered === '/ve' && operation !== 'copy' && operation !== 'export' && operation !== 'import') state.defaultValue = true;
    else if (lowered === '/va' && operation === 'delete') state.allValues = true;
    else if (lowered === '/t' && (operation === 'add' || querying)) {
      const taken = next();
      if (taken === null) return null;
      state.type = taken;
    } else if (lowered === '/s' && operation === 'add') {
      const taken = next();
      if (taken === null || taken.length !== 1) return null;
      state.separator = taken;
    } else if (lowered === '/s' && (querying || operation === 'copy')) state.recursive = true;
    else if (lowered === '/se' && querying) {
      const taken = next();
      if (taken === null || taken.length !== 1) return null;
      state.separator = taken;
    } else if (lowered === '/d' && operation === 'add') {
      const taken = next();
      if (taken === null) return null;
      state.data = taken;
    } else if (lowered === '/d' && querying) state.searchData = true;
    else if (lowered === '/f' && querying) {
      const taken = next();
      if (taken === null) return null;
      state.search = taken;
    } else if (lowered === '/f' && operation !== 'export' && operation !== 'import') state.force = true;
    else if (lowered === '/y' && operation === 'export') state.force = true;
    else if (lowered === '/k' && querying) state.searchKeys = true;
    else if (lowered === '/c' && querying) state.caseSensitive = true;
    else if (lowered === '/e' && querying) state.exact = true;
    else if (lowered === '/z' && querying) state.verbose = true;
    else if (argument.startsWith('/')) return null;
    else positional.push(argument);
  }
  return { ...state, positional };
}

function isLocalMachine(name: string, host: WinRegHost): boolean {
  return ['localhost', '.', host.computerName.toLowerCase()].includes(name.toLowerCase());
}

function resolve(text: string, view: 32 | 64 | null, host: WinRegHost, operation: string): RegistryAddress | RegResult {
  const address = parseRegistryAddress(text);
  if (address === null) return invalidKey(operation);
  if (address.machine !== null && !isLocalMachine(address.machine, host)) return failure('ERROR: The network path was not found.');
  if (address.machine !== null && address.root !== 'HKLM' && address.root !== 'HKU') return failure('ERROR: The parameter is incorrect.');
  const software = address.segments[0]?.toLowerCase() === 'software';
  if (view === 32 && (address.root === 'HKLM' || address.root === 'HKCU') && software) {
    return { ...address, segments: [address.segments[0], 'WOW6432Node', ...address.segments.slice(1)] };
  }
  return address;
}

const isResult = (value: RegistryAddress | RegResult): value is RegResult => 'output' in value;

function isRestricted(address: RegistryAddress): boolean {
  return address.root === 'HKLM' && address.segments.length > 0 && RESTRICTED_HIVES.has(address.segments[0].toLowerCase());
}

function canWrite(address: RegistryAddress, host: WinRegHost): boolean {
  return host.isAdmin || host.registry.writesUserHive(address);
}

function headerOf(address: RegistryAddress, typed: string): string {
  const tail = typed.replace(/^\\\\[^\\]+\\/, '').split('\\').filter(part => part !== '').slice(1);
  return [REGISTRY_ROOT_NAMES[address.root], ...tail].join('\\');
}

function renderData(value: RegistryValue, separator: string | null): string {
  switch (value.type) {
    case 'DWord': case 'DWordBigEndian': case 'QWord': return `0x${Number(value.value).toString(16)}`;
    case 'MultiString': return String(value.value).split('\\0').join(separator ?? '\\0');
    default: return String(value.value);
  }
}

function valueRow(value: RegistryValue, switches: Switches): string {
  const name = value.name === '' ? '(Default)' : value.name;
  const type = switches.verbose ? `${TYPE_NAMES[value.type]} (${TYPE_NUMBERS[value.type]})` : TYPE_NAMES[value.type];
  return `    ${name}    ${type}    ${renderData(value, switches.separator)}`;
}

function matcherOf(switches: Switches): (text: string) => boolean {
  const escaped = (switches.search ?? '*').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  const expression = new RegExp(switches.exact ? `^${escaped}$` : escaped, switches.caseSensitive ? '' : 'i');
  return text => expression.test(text);
}

interface Walk {
  readonly host: WinRegHost;
  readonly switches: Switches;
  readonly matches: (text: string) => boolean;
  readonly lines: string[];
  count: number;
}

function filtersValues(switches: Switches): boolean {
  return switches.valueName !== null || switches.defaultValue || switches.type !== null;
}

function wantedValue(value: RegistryValue, switches: Switches): boolean {
  if (switches.defaultValue && value.name !== '') return false;
  if (switches.valueName !== null && switches.valueName !== '' && value.name.toLowerCase() !== switches.valueName.toLowerCase()) return false;
  return switches.type === null || TYPES_BY_NAME[switches.type.toUpperCase()] === value.type;
}

function valueMatchesSearch(walk: Walk, value: RegistryValue): boolean {
  const { switches, matches } = walk;
  const byName = !switches.searchData && matches(value.name === '' ? '(Default)' : value.name);
  const byData = !switches.searchKeys && matches(renderData(value, switches.separator));
  return byName || byData;
}

function visit(walk: Walk, address: RegistryAddress, header: string, isRoot: boolean): void {
  const view = walk.host.registry.keyView(address);
  if (view === null) return;
  const { switches } = walk;
  const searching = switches.search !== null;
  const rows = view.values
    .filter(value => wantedValue(value, switches))
    .filter(value => !searching || valueMatchesSearch(walk, value))
    .map(value => valueRow(value, switches));
  const namesKey = searching && !switches.searchData && !isRoot && walk.matches(view.name);

  if (searching) {
    if (rows.length > 0 || namesKey) walk.lines.push('', header, ...rows);
    walk.count += rows.length + (namesKey ? 1 : 0);
  } else if (!filtersValues(switches) || rows.length > 0) {
    walk.lines.push('', header, ...rows);
    walk.count += rows.length + (switches.recursive ? 1 : 0);
  }

  if (!switches.recursive) {
    for (const child of view.subkeys) {
      if (searching) {
        if (switches.searchData || !walk.matches(child)) continue;
        walk.lines.push('', `${header}\\${child}`);
        walk.count++;
      } else if (!filtersValues(switches)) {
        walk.lines.push(`${header}\\${child}`);
      }
    }
    return;
  }
  for (const child of view.subkeys) visit(walk, { ...address, segments: [...address.segments, child] }, `${header}\\${child}`, false);
}

function queryOperation(host: WinRegHost, args: readonly string[]): RegResult {
  const switches = parseSwitches('query', args);
  if (switches === null || switches.positional.length !== 1) return syntaxError('query');
  const conflicting = (switches.valueName !== null && switches.defaultValue)
    || (switches.type !== null && TYPES_BY_NAME[switches.type.toUpperCase()] === undefined);
  if (conflicting) return syntaxError('query');
  const typed = switches.positional[0];
  const address = resolve(typed, switches.view, host, 'query');
  if (isResult(address)) return address;
  if (isRestricted(address)) return failure(DENIED);
  if (host.registry.keyView(address) === null) return failure(NOT_FOUND);

  const walk: Walk = { host, switches, matches: matcherOf(switches), lines: [], count: 0 };
  visit(walk, address, headerOf(address, typed), true);
  const withFooter = switches.search !== null || filtersValues(switches) || switches.recursive;
  if (switches.search === null && filtersValues(switches) && walk.count === 0) return failure(NOT_FOUND);
  const lines = [...walk.lines, ''];
  if (withFooter) lines.push(`End of search: ${walk.count} match(es) found.`);
  return { output: lines.join('\n'), exitCode: switches.search !== null && walk.count === 0 ? 1 : 0 };
}

function parseNumber(text: string, maximum: number): number | null {
  const trimmed = text.trim();
  const value = /^0x[0-9a-f]+$/i.test(trimmed) ? Number.parseInt(trimmed, 16) : /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : null;
}

function convertData(type: RegistryValueType, data: string, separator: string | null): string | number | null {
  switch (type) {
    case 'String': case 'ExpandString': case 'Link': return data;
    case 'MultiString': return separator === null ? data : data.split(separator).join('\\0');
    case 'DWord': case 'DWordBigEndian': return parseNumber(data, 0xffffffff);
    case 'QWord': return parseNumber(data, Number.MAX_SAFE_INTEGER);
    default: return data === '' ? '' : /^([0-9a-f]{2})+$/i.test(data) ? data.toUpperCase() : null;
  }
}

async function confirmed(host: WinRegHost, prompt: string): Promise<boolean> {
  const answer = await host.ask(prompt);
  return answer !== null && /^y(es)?$/i.test(answer.trim());
}

async function addOperation(host: WinRegHost, args: readonly string[]): Promise<RegResult> {
  const switches = parseSwitches('add', args);
  if (switches === null || switches.positional.length !== 1) return syntaxError('add');
  if (switches.valueName !== null && switches.defaultValue) return syntaxError('add');
  const type = switches.type === null ? 'String' : TYPES_BY_NAME[switches.type.toUpperCase()];
  if (type === undefined) return syntaxError('add');
  const address = resolve(switches.positional[0], switches.view, host, 'add');
  if (isResult(address)) return address;
  if (address.segments.length === 0 || !canWrite(address, host)) return failure(DENIED);

  if (switches.valueName === null && !switches.defaultValue) {
    return host.registry.createKey(address) ? success(OK) : failure(DENIED);
  }
  const converted = convertData(type, switches.data ?? '', switches.separator);
  if (converted === null) return syntaxError('add');
  const name = switches.defaultValue ? '' : switches.valueName!;
  const existing = host.registry.keyView(address)?.values.find(value => value.name.toLowerCase() === name.toLowerCase());
  if (existing !== undefined && !switches.force) {
    const label = name === '' ? '(Default)' : name;
    if (!(await confirmed(host, `Value ${label} exists, overwrite(Yes/No)? `))) return failure(CANCELED);
  }
  return host.registry.setValue(address, name, type, converted) ? success(OK) : failure(DENIED);
}

async function deleteOperation(host: WinRegHost, args: readonly string[]): Promise<RegResult> {
  const switches = parseSwitches('delete', args);
  if (switches === null || switches.positional.length !== 1) return syntaxError('delete');
  const chosen = [switches.valueName !== null, switches.defaultValue, switches.allValues].filter(Boolean).length;
  if (chosen > 1) return syntaxError('delete');
  const typed = switches.positional[0];
  const address = resolve(typed, switches.view, host, 'delete');
  if (isResult(address)) return address;
  if (isRestricted(address)) return failure(DENIED);
  const view = host.registry.keyView(address);
  if (view === null) return failure(NOT_FOUND);
  if (!canWrite(address, host)) return failure(DENIED);
  const path = headerOf(address, typed);

  if (switches.allValues) {
    if (!switches.force && !(await confirmed(host, `Delete all registry values under the key ${path} (Yes/No)? `))) return failure(CANCELED);
    host.registry.deleteAllValues(address);
    return success(OK);
  }
  if (switches.valueName !== null || switches.defaultValue) {
    const name = switches.defaultValue ? '' : switches.valueName!;
    if (!view.values.some(value => value.name.toLowerCase() === name.toLowerCase())) return failure(NOT_FOUND);
    const label = name === '' ? '(Default)' : name;
    if (!switches.force && !(await confirmed(host, `Delete the registry value ${label} (Yes/No)? `))) return failure(CANCELED);
    host.registry.deleteValue(address, name);
    return success(OK);
  }
  if (address.segments.length === 0) return failure(DENIED);
  if (!switches.force && !(await confirmed(host, `Permanently delete the registry key ${path} (Yes/No)? `))) return failure(CANCELED);
  host.registry.deleteKey(address);
  return success(OK);
}

function copyTree(host: WinRegHost, from: RegistryAddress, to: RegistryAddress, recursive: boolean): boolean {
  const view = host.registry.keyView(from);
  if (view === null || !host.registry.createKey(to)) return false;
  for (const value of view.values) host.registry.setValue(to, value.name, value.type, value.value);
  if (!recursive) return true;
  return view.subkeys.every(child =>
    copyTree(host, { ...from, segments: [...from.segments, child] }, { ...to, segments: [...to.segments, child] }, true));
}

async function copyOperation(host: WinRegHost, args: readonly string[]): Promise<RegResult> {
  const switches = parseSwitches('copy', args);
  if (switches === null || switches.positional.length !== 2) return syntaxError('copy');
  const from = resolve(switches.positional[0], switches.view, host, 'copy');
  if (isResult(from)) return from;
  const to = resolve(switches.positional[1], switches.view, host, 'copy');
  if (isResult(to)) return to;
  if (isRestricted(from)) return failure(DENIED);
  if (host.registry.keyView(from) === null) return failure(NOT_FOUND);
  if (!canWrite(to, host)) return failure(DENIED);
  if (host.registry.keyView(to) !== null && !switches.force) {
    if (!(await confirmed(host, `Overwrite the destination key ${headerOf(to, switches.positional[1])} (Yes/No)? `))) return failure(CANCELED);
  }
  return copyTree(host, from, to, switches.recursive) ? success(OK) : failure(DENIED);
}

async function exportOperation(host: WinRegHost, args: readonly string[]): Promise<RegResult> {
  const switches = parseSwitches('export', args);
  if (switches === null || switches.positional.length !== 2) return syntaxError('export');
  const address = resolve(switches.positional[0], switches.view, host, 'export');
  if (isResult(address)) return address;
  if (isRestricted(address)) return failure(DENIED);
  if (host.registry.keyView(address) === null) return failure(NOT_FOUND);
  const path = host.files.normalize(switches.positional[1]);
  if (host.files.exists(path) && !switches.force) {
    if (!(await confirmed(host, `Overwrite ${switches.positional[1]} (Yes/No)? `))) return failure(CANCELED);
  }
  return host.files.write(path, renderRegFile(host.registry, address))
    ? success(OK)
    : failure('ERROR: The system cannot find the path specified.');
}

function importOperation(host: WinRegHost, args: readonly string[]): RegResult {
  const switches = parseSwitches('import', args);
  if (switches === null || switches.positional.length !== 1) return syntaxError('import');
  const text = host.files.read(host.files.normalize(switches.positional[0]));
  if (text === null) return failure('ERROR: The system cannot find the file specified.');
  const keys = parseRegFile(text);
  if (keys === null) return failure('ERROR: Error accessing the registry.');
  const targets: Array<{ address: RegistryAddress; entry: (typeof keys)[number] }> = [];
  for (const entry of keys) {
    const address = resolve(entry.path, switches.view, host, 'import');
    if (isResult(address)) return failure('ERROR: Error accessing the registry.');
    if (!canWrite(address, host)) return failure(DENIED);
    targets.push({ address, entry });
  }
  for (const { address, entry } of targets) {
    if (entry.deleted) {
      host.registry.deleteKey(address);
      continue;
    }
    host.registry.createKey(address);
    for (const value of entry.values) host.registry.setValue(address, value.name, value.type, value.value);
  }
  return success(OK);
}

async function dispatch(host: WinRegHost, args: string[]): Promise<RegResult> {
  if (args.length === 0) return failure('ERROR: Invalid syntax.\nType "REG /?" for usage.');
  if (args.length === 1 && args[0] === '/?') return success(REG_HELP);
  const operation = args[0].toLowerCase();
  const rest = args.slice(1);
  if (rest.length === 1 && rest[0] === '/?' && REG_OPERATION_HELP[operation] !== undefined) return success(REG_OPERATION_HELP[operation]);
  switch (operation) {
    case 'query': return queryOperation(host, rest);
    case 'add': return addOperation(host, rest);
    case 'delete': return deleteOperation(host, rest);
    case 'copy': return copyOperation(host, rest);
    case 'export': return exportOperation(host, rest);
    case 'import': return importOperation(host, rest);
    case 'save': case 'restore': case 'load': case 'unload': case 'compare': case 'flags':
      return failure(NOT_SUPPORTED);
    default:
      return failure('ERROR: Invalid syntax.\nType "REG /?" for usage.');
  }
}

export async function cmdReg(host: WinRegHost, args: string[]): Promise<RegResult> {
  let shown = '';
  const transcribing: WinRegHost = {
    ...host,
    ask: async prompt => {
      const answer = await host.ask(prompt);
      if (!host.interactive) shown += prompt;
      return answer;
    },
  };
  const result = await dispatch(transcribing, args);
  return { ...result, output: shown + result.output };
}
