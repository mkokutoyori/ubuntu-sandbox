import type { PSValue } from './PSEnvironment';

export interface PathInfoFacts {
  readonly path: string;
  readonly providerPath: string;
  readonly provider: string;
  readonly drive: string;
}

const PROVIDER_PREFIX = 'Microsoft.PowerShell.Core\\';

export const FILESYSTEM_QUALIFIER = `${PROVIDER_PREFIX}FileSystem::`;

export const qualifiedLocation = (path: string): string => (path.startsWith('\\\\') ? `${FILESYSTEM_QUALIFIER}${path}` : path);

export function namedRecord(name: string, text: string): Record<string, PSValue> {
  const record: Record<string, PSValue> = { Name: name };
  Object.defineProperty(record, 'toString', { value: () => text, enumerable: false });
  return record;
}

export function pathInfo(facts: PathInfoFacts): Record<string, PSValue> {
  const record: Record<string, PSValue> = {
    Path: facts.path,
    ProviderPath: facts.providerPath,
    Provider: namedRecord(facts.provider, `${PROVIDER_PREFIX}${facts.provider}`),
    Drive: namedRecord(facts.drive, facts.drive),
  };
  Object.defineProperty(record, 'toString', { value: () => facts.path, enumerable: false });
  return record;
}
