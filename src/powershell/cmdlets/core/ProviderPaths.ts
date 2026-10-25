import type { CmdletContext } from '../CmdletContext';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import { psValueToString } from '@/powershell/runtime/PSExpansion';
import { pathInfo } from '@/powershell/runtime/PSPathInfo';
import { DRIVE_QUALIFIER } from '@/powershell/runtime/PSLocationState';
import { isRegistryPath, registryProviderPath } from '@/network/devices/windows/PSRegistryProvider';

export type NamespaceKind = 'environment' | 'function' | 'alias' | 'variable';

export const NAMESPACE_DRIVES: Readonly<Record<NamespaceKind, { readonly drive: string; readonly provider: string }>> = {
  environment: { drive: 'Env', provider: 'Environment' },
  function: { drive: 'Function', provider: 'Function' },
  alias: { drive: 'Alias', provider: 'Alias' },
  variable: { drive: 'Variable', provider: 'Variable' },
};

const namespaceEntries = Object.entries(NAMESPACE_DRIVES) as Array<[NamespaceKind, { drive: string; provider: string }]>;

export const FOREIGN_DRIVES: Readonly<Record<string, readonly string[]>> = {
  registry: ['HKLM', 'HKCU'],
  ...Object.fromEntries(namespaceEntries.map(([kind, { drive }]) => [kind, [drive]])),
};

const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  registry: 'Registry',
  ...Object.fromEntries(namespaceEntries.map(([kind, { provider }]) => [kind, provider])),
};

export interface Declared {
  readonly Name: string;
  readonly Root: string;
}

export const qualifierOf = (path: string): string | null => DRIVE_QUALIFIER.exec(path)?.[1] ?? null;

export function foreignDrive(name: string): { provider: string; drive: string } | null {
  for (const [provider, drives] of Object.entries(FOREIGN_DRIVES)) {
    const drive = drives.find(candidate => candidate.toLowerCase() === name.toLowerCase());
    if (drive !== undefined) return { provider, drive };
  }
  return null;
}

export function declaredDrive(ctx: CmdletContext, name: string): Declared | null {
  const declared = (ctx.runtime.getVariable('__drives__') as Record<string, PSValue> | null) ?? {};
  const found = declared[name.toLowerCase()] as Record<string, PSValue> | undefined;
  if (found === undefined) return null;
  const drive = { Name: psValueToString(found['Name']), Root: psValueToString(found['Root']) };
  return drive.Root === '' || drive.Root.toLowerCase() === `${drive.Name.toLowerCase()}:\\` ? null : drive;
}

export function mappedPath(declared: Declared, path: string): string {
  const relative = path.slice(declared.Name.length + 2);
  return relative === '' ? declared.Root : `${declared.Root.replace(/\\+$/, '')}\\${relative}`;
}

function providerOfLocation(path: string): string {
  const qualifier = qualifierOf(path);
  const found = qualifier === null ? null : foreignDrive(qualifier);
  return found === null ? 'FileSystem' : PROVIDER_NAMES[found.provider];
}

export function providerPathOf(ctx: CmdletContext, path: string): string {
  const qualifier = qualifierOf(path);
  const found = qualifier === null ? null : foreignDrive(qualifier);
  if (qualifier !== null && found !== null && found.provider !== 'registry') return path.replace(DRIVE_QUALIFIER, '').replace(/^[\\/]+/, '');
  const declared = qualifier === null ? null : declaredDrive(ctx, qualifier);
  if (declared !== null && found === null) {
    const mapped = mappedPath(declared, path);
    return isRegistryPath(mapped) ? registryProviderPath(mapped) : mapped;
  }
  return isRegistryPath(path) ? registryProviderPath(path) : path;
}

function driveNameOf(ctx: CmdletContext, path: string): string {
  const qualifier = qualifierOf(path);
  if (qualifier === null) return 'C';
  return foreignDrive(qualifier)?.drive ?? declaredDrive(ctx, qualifier)?.Name ?? qualifier.toUpperCase();
}

export function pathInfoOf(ctx: CmdletContext, path: string): Record<string, PSValue> {
  return pathInfo({
    path,
    providerPath: providerPathOf(ctx, path),
    provider: providerOfLocation(path),
    drive: driveNameOf(ctx, path),
  });
}
