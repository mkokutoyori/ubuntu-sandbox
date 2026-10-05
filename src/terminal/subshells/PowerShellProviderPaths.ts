import { openingQuoteOf, quotePath, splitPathSeparator, stripQuotes } from '@/network/devices/windows/PathCompletion';

export interface ProviderPathSources {
  registrySubkeys(path: string): readonly string[];
  environmentNames(): readonly string[];
}

const REGISTRY_DRIVE = /^(?:HKLM|HKCU):/i;
const REGISTRY_ROOT = /^(?:HKLM|HKCU):$/i;
const ENVIRONMENT_DRIVE = /^Env:/i;

function byName(left: string, right: string): number {
  return left.toLowerCase().localeCompare(right.toLowerCase());
}

function completeRegistryKey(sources: ProviderPathSources, bare: string, quote: string): string[] {
  if (REGISTRY_ROOT.test(bare)) return [quotePath(`${bare}\\`, quote, 'powershell')];
  const { directory, name } = splitPathSeparator(bare);
  const typedDirectory = directory.replace(/\//g, '\\');
  const lowered = name.toLowerCase();
  return sources.registrySubkeys(typedDirectory.slice(0, -1))
    .filter(key => key.toLowerCase().startsWith(lowered))
    .sort(byName)
    .map(key => quotePath(`${typedDirectory}${key}\\`, quote, 'powershell'));
}

function completeEnvironmentName(sources: ProviderPathSources, bare: string, quote: string): string[] {
  const drive = /^Env:[\\/]?/i.exec(bare)?.[0] ?? 'Env:';
  const lowered = bare.slice(drive.length).toLowerCase();
  return sources.environmentNames()
    .filter(variable => variable.toLowerCase().startsWith(lowered))
    .sort(byName)
    .map(variable => quotePath(`${drive.replace(/\//g, '\\')}${variable}`, quote, 'powershell'));
}

export function completeProviderPath(sources: ProviderPathSources, token: string): string[] | null {
  const quote = openingQuoteOf(token, 'powershell');
  const bare = stripQuotes(token, quote);
  if (REGISTRY_DRIVE.test(bare)) return completeRegistryKey(sources, bare, quote);
  if (ENVIRONMENT_DRIVE.test(bare)) return completeEnvironmentName(sources, bare, quote);
  return null;
}
