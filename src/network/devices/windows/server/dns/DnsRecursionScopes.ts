export const DEFAULT_RECURSION_SCOPE = '.';

export interface RecursionScopeView {
  readonly name: string;
  readonly forwarders: readonly string[];
  readonly enableRecursion: boolean;
}

export interface RecursionScopeChanges {
  readonly forwarders?: readonly string[];
  readonly enableRecursion?: boolean;
}

export const RECURSION_SCOPE_REFUSALS = {
  missing: 'The scope does not exist.',
  exists: 'The scope already exists.',
  isDefault: 'The scope is the same as the default scope.',
  referenced: 'The server scope cannot be deleted because it is referenced by a DNS Policy.',
} as const;

interface StoredScope {
  readonly name: string;
  forwarders: string[];
  enableRecursion: boolean;
}

export function isDefaultRecursionScope(name: string): boolean {
  return name.trim() === DEFAULT_RECURSION_SCOPE;
}

function keyOf(name: string): string {
  return name.trim().toLowerCase();
}

function viewOf(scope: StoredScope): RecursionScopeView {
  return { name: scope.name, forwarders: [...scope.forwarders], enableRecursion: scope.enableRecursion };
}

export class DnsRecursionScopes {
  private readonly scopes = new Map<string, StoredScope>();

  list(): RecursionScopeView[] {
    return [...this.scopes.values()].map(viewOf);
  }

  find(name: string): RecursionScopeView | null {
    const found = this.scopes.get(keyOf(name));
    return found === undefined ? null : viewOf(found);
  }

  create(name: string, forwarders: readonly string[], enableRecursion: boolean): string | null {
    if (isDefaultRecursionScope(name)) return RECURSION_SCOPE_REFUSALS.isDefault;
    if (this.scopes.has(keyOf(name))) return RECURSION_SCOPE_REFUSALS.exists;
    this.scopes.set(keyOf(name), { name, forwarders: [...forwarders], enableRecursion });
    return null;
  }

  change(name: string, changes: RecursionScopeChanges): string | null {
    const scope = this.scopes.get(keyOf(name));
    if (scope === undefined) return RECURSION_SCOPE_REFUSALS.missing;
    if (changes.forwarders !== undefined) scope.forwarders = [...changes.forwarders];
    if (changes.enableRecursion !== undefined) scope.enableRecursion = changes.enableRecursion;
    return null;
  }

  remove(name: string, isReferenced: (name: string) => boolean): string | null {
    if (isDefaultRecursionScope(name)) return RECURSION_SCOPE_REFUSALS.isDefault;
    const scope = this.scopes.get(keyOf(name));
    if (scope === undefined) return RECURSION_SCOPE_REFUSALS.missing;
    if (isReferenced(scope.name)) return RECURSION_SCOPE_REFUSALS.referenced;
    this.scopes.delete(keyOf(name));
    return null;
  }
}
