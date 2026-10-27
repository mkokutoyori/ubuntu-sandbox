import type { CmdletContext } from '../CmdletContext';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import { psValueToString } from '@/powershell/runtime/PSExpansion';
import { hasWildcard, wildcardToRegex } from '@/powershell/runtime/PSWildcard';
import { joinProviderPath } from '@/powershell/runtime/PSLocationState';
import { allAliases } from './AliasCmdlets';
import { functionRow } from './CommandRows';
import { NAMESPACE_DRIVES, qualifierOf, type NamespaceKind } from './ProviderPaths';
import { pathNotFound } from './ProviderFailures';

export type { NamespaceKind };

export type NamespaceEntry = Record<string, PSValue>;

export interface NamespaceTarget {
  readonly kind: NamespaceKind;
  readonly drive: string;
  readonly pattern: string;
}

const PROVIDER_PATH = /^(?:Microsoft\.PowerShell\.Core\\)?([A-Za-z]+)::[\\/]*(.*)$/;
const NOT_IN_RANGE = 'Value does not fall within the expected range.';

export const COPY_ACROSS_PROVIDERS = 'Source and destination path did not resolve to the same provider.';

const KINDS = Object.keys(NAMESPACE_DRIVES) as NamespaceKind[];

export function namespaceTarget(path: string): NamespaceTarget | null {
  const qualified = PROVIDER_PATH.exec(path);
  const drive = qualified === null ? qualifierOf(path) : qualified[1];
  if (drive === null) return null;
  const kind = KINDS.find(candidate => NAMESPACE_DRIVES[candidate][qualified === null ? 'drive' : 'provider'].toLowerCase() === drive.toLowerCase());
  if (kind === undefined) return null;
  return { kind, drive: NAMESPACE_DRIVES[kind].drive, pattern: qualified === null ? path.slice(drive.length + 1).replace(/^[\\/]+/, '') : qualified[2] };
}

export function namespacePath(target: NamespaceTarget, name = target.pattern): string {
  return joinProviderPath(target.drive, [name]);
}

function withProviderPath(kind: NamespaceKind, entry: NamespaceEntry): NamespaceEntry {
  Object.defineProperty(entry, 'PSPath', { value: `Microsoft.PowerShell.Core\\${NAMESPACE_DRIVES[kind].provider}::${String(entry['Name'])}`, enumerable: false });
  return entry;
}

const byName = (left: NamespaceEntry, right: NamespaceEntry): number =>
  String(left['Name']).toLowerCase().localeCompare(String(right['Name']).toLowerCase());

function rowsOf(ctx: CmdletContext, kind: NamespaceKind): NamespaceEntry[] {
  switch (kind) {
    case 'environment':
      return ctx.runtime.listEnvVars().map(({ Name, Value }) => ({ Name, Value }));
    case 'function':
      return ctx.runtime.listFunctions().map(name => functionRow(ctx, name) as unknown as NamespaceEntry);
    case 'alias':
      return allAliases(ctx) as unknown as NamespaceEntry[];
    case 'variable':
      return ctx.env.names().filter(name => !name.startsWith('__')).map(name => ({ Name: name, Value: ctx.env.get(name) ?? null }));
  }
}

function entriesOf(ctx: CmdletContext, kind: NamespaceKind): NamespaceEntry[] {
  return rowsOf(ctx, kind).sort(byName).map(row => withProviderPath(kind, row));
}

export function namespaceItem(ctx: CmdletContext, kind: NamespaceKind, name: string): NamespaceEntry | null {
  const found = entriesOf(ctx, kind).find(entry => String(entry['Name']).toLowerCase() === name.toLowerCase());
  if (found === undefined) return null;
  return kind === 'environment' ? withProviderPath(kind, { Name: name, Value: found['Value'] }) : found;
}

export function namespaceMatches(ctx: CmdletContext, target: NamespaceTarget): NamespaceEntry[] {
  if (target.pattern === '') return entriesOf(ctx, target.kind);
  if (!hasWildcard(target.pattern)) {
    const item = namespaceItem(ctx, target.kind, target.pattern);
    return item === null ? [] : [item];
  }
  const wanted = wildcardToRegex(target.pattern);
  return entriesOf(ctx, target.kind).filter(entry => wanted.test(String(entry['Name'])));
}

export function namespaceExists(ctx: CmdletContext, target: NamespaceTarget): boolean {
  return target.pattern === '' || namespaceMatches(ctx, target).length > 0;
}

function notFound(ctx: CmdletContext, target: NamespaceTarget): void {
  ctx.emitFailure(pathNotFound(namespacePath(target)));
}

function matchesOrReport(ctx: CmdletContext, target: NamespaceTarget): NamespaceEntry[] {
  const found = namespaceMatches(ctx, target);
  if (found.length === 0 && target.pattern !== '') notFound(ctx, target);
  return found;
}

export function resolveNamespacePaths(ctx: CmdletContext, target: NamespaceTarget): string[] {
  if (target.pattern === '') return [namespacePath(target, '')];
  return matchesOrReport(ctx, target).map(entry => namespacePath(target, String(entry['Name'])));
}

export function listNamespace(ctx: CmdletContext, target: NamespaceTarget, nameOnly = false): PSValue {
  const found = matchesOrReport(ctx, target);
  return (nameOnly ? found.map(entry => entry['Name']) : found) as PSValue;
}

function valueOf(ctx: CmdletContext, entry: NamespaceEntry, kind: NamespaceKind): PSValue {
  switch (kind) {
    case 'alias':
      return entry['Definition'];
    case 'function':
      return ctx.runtime.getFunctionBlock(String(entry['Name']));
    default:
      return entry['Value'];
  }
}

function scriptBlockOf(ctx: CmdletContext, value: PSValue): PSValue {
  return typeof value === 'string' ? ctx.runtime.scriptBlockFromText(value) : value;
}

function assign(ctx: CmdletContext, kind: NamespaceKind, name: string, value: PSValue): string | null {
  switch (kind) {
    case 'environment': {
      const store = ctx.providers.environment;
      if (!store) return "Cannot find drive. A drive with the name 'Env' does not exist.";
      if (value === null || value === undefined) store.remove(name);
      else store.set(name, psValueToString(value));
      return null;
    }
    case 'variable':
      ctx.env.set(name, value ?? null);
      return null;
    case 'function':
      return ctx.runtime.defineFunction(name, scriptBlockOf(ctx, value)) ? null : `Cannot convert the value to a script block for function '${name}'.`;
    case 'alias':
      if (typeof value !== 'string') return `Cannot convert the value to an alias definition for alias '${name}'.`;
      ctx.runtime.defineAlias(name, value, '');
      return null;
  }
}

function erase(ctx: CmdletContext, kind: NamespaceKind, name: string): void {
  switch (kind) {
    case 'environment':
      ctx.providers.environment?.remove(name);
      return;
    case 'variable':
      ctx.env.deleteInScope(name);
      return;
    case 'function':
      ctx.runtime.removeFunction(name);
      return;
    case 'alias':
      ctx.runtime.removeAlias(name);
      return;
  }
}

function leafOf(ctx: CmdletContext, target: NamespaceTarget): string | null {
  if (target.pattern === '') {
    ctx.emitError(NOT_IN_RANGE);
    return null;
  }
  return target.pattern;
}

export function newNamespaceItem(ctx: CmdletContext, target: NamespaceTarget, value: PSValue | undefined, force: boolean): PSValue {
  const name = leafOf(ctx, target);
  if (name === null) return null;
  if (value === undefined || value === null) {
    ctx.emitError('Value cannot be null.\nParameter name: value');
    return null;
  }
  if (namespaceItem(ctx, target.kind, name) !== null && !force) {
    ctx.emitError(`The item at path '${name}' already exists.`);
    return null;
  }
  const failure = assign(ctx, target.kind, name, value);
  if (failure !== null) {
    ctx.emitError(failure);
    return null;
  }
  return namespaceItem(ctx, target.kind, name);
}

export function setNamespaceItem(ctx: CmdletContext, target: NamespaceTarget, value: PSValue, passThru: boolean): PSValue {
  const name = leafOf(ctx, target);
  if (name === null) return null;
  const failure = assign(ctx, target.kind, name, value);
  if (failure !== null) {
    ctx.emitError(failure);
    return null;
  }
  return passThru ? namespaceItem(ctx, target.kind, name) : null;
}

export function removeNamespaceItems(ctx: CmdletContext, target: NamespaceTarget): void {
  if (leafOf(ctx, target) === null) return;
  for (const entry of matchesOrReport(ctx, target)) {
    const name = String(entry['Name']);
    if (ctx.shouldProcess(`Item: ${name}`, 'Remove Item')) erase(ctx, target.kind, name);
  }
}

export function renameNamespaceItem(ctx: CmdletContext, target: NamespaceTarget, newName: string, force: boolean, passThru: boolean): PSValue {
  if (leafOf(ctx, target) === null) return null;
  const [entry] = matchesOrReport(ctx, target);
  if (entry === undefined) return null;
  const name = String(entry['Name']);
  if (!ctx.shouldProcess(`Item: ${name} NewName: ${newName}`, 'Rename Item')) return null;
  if (name.toLowerCase() !== newName.toLowerCase()) {
    if (namespaceItem(ctx, target.kind, newName) !== null && !force) {
      ctx.emitError(`The item at path '${newName}' already exists.`);
      return null;
    }
    const failure = assign(ctx, target.kind, newName, valueOf(ctx, entry, target.kind));
    if (failure !== null) {
      ctx.emitError(failure);
      return null;
    }
    erase(ctx, target.kind, name);
  }
  return passThru ? namespaceItem(ctx, target.kind, newName) : null;
}

export function copyNamespaceItem(ctx: CmdletContext, from: NamespaceTarget, to: NamespaceTarget, passThru: boolean): PSValue {
  if (leafOf(ctx, from) === null) return null;
  const [entry] = matchesOrReport(ctx, from);
  if (entry === undefined) return null;
  const name = leafOf(ctx, to);
  if (name === null) return null;
  if (!ctx.shouldProcess(`Item: ${String(entry['Name'])} Destination: ${name}`, 'Copy Item')) return null;
  const failure = from.kind === to.kind ? assign(ctx, to.kind, name, valueOf(ctx, entry, from.kind)) : COPY_ACROSS_PROVIDERS;
  if (failure !== null) {
    ctx.emitError(failure);
    return null;
  }
  return passThru ? namespaceItem(ctx, to.kind, name) : null;
}

function functionBodyLines(ctx: CmdletContext, name: string): string[] {
  const source = ctx.runtime.getFunctionSource(name) ?? '';
  const braced = /^\s*\{[\s\S]*\}\s*$/.test(source);
  return (braced ? source.trim().slice(1, -1) : source).split(/\r?\n/);
}

export function readNamespaceContent(ctx: CmdletContext, target: NamespaceTarget): PSValue {
  const [entry] = target.pattern === '' ? [] : matchesOrReport(ctx, target);
  if (entry === undefined) {
    if (target.pattern === '') notFound(ctx, target);
    return null;
  }
  return target.kind === 'function' ? functionBodyLines(ctx, String(entry['Name'])) as unknown as PSValue : valueOf(ctx, entry, target.kind);
}

export function writeNamespaceContent(ctx: CmdletContext, target: NamespaceTarget, values: readonly PSValue[]): void {
  const name = leafOf(ctx, target);
  if (name === null) return;
  const failure = assign(ctx, target.kind, name, values.length === 1 ? values[0] : values as unknown as PSValue);
  if (failure !== null) ctx.emitError(failure);
}

export function seekRefusal(target: NamespaceTarget): string {
  return `The invocation of Seek on the '${NAMESPACE_DRIVES[target.kind].provider}' provider's content writer failed for path '${namespacePath(target)}'. Cannot call method. The content Seek method is not supported by this provider.`;
}

export const CLEAR_CONTENT_REFUSAL = 'Cannot perform the ClearContent operation. The ClearContent operation is not supported by this provider.';
