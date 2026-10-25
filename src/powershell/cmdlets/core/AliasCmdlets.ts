import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import { psValueToString } from '@/powershell/runtime/PSExpansion';
import { PSRuntimeError } from '@/powershell/runtime/PSRuntimeError';
import { wildcardToRegex, hasWildcard } from '@/powershell/runtime/PSWildcard';

export interface AliasEntry {
  Name: string;
  Definition: string;
  Description: string;
  Options: string;
  CommandType: string;
}

function patterns(value: PSValue | undefined): string[] {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : [value]).map(psValueToString).filter(text => text !== '');
}

function aliasEntry(name: string, definition: string, description = ''): AliasEntry {
  return { Name: name, Definition: definition, Description: description, Options: 'None', CommandType: 'Alias' };
}

export function allAliases(ctx: CmdletContext): AliasEntry[] {
  const table = new Map<string, AliasEntry>();
  for (const cmdlet of ctx.runtime.listCmdlets()) {
    for (const alias of cmdlet.aliases) table.set(alias.toLowerCase(), aliasEntry(alias, cmdlet.displayName ?? cmdlet.name));
  }
  for (const user of ctx.runtime.listUserAliases()) table.set(user.name.toLowerCase(), aliasEntry(user.name, user.definition, user.description));
  return [...table.values()].sort((a, b) => a.Name.toLowerCase().localeCompare(b.Name.toLowerCase()));
}

export class GetAliasCmdlet implements ICmdlet {
  readonly name = 'get-alias';
  readonly aliases = ['gal'] as const;
  readonly parameters = ['Name', 'Definition', 'Exclude', 'Scope'] as const;

  execute(ctx: CmdletContext): PSValue {
    const names = patterns(ctx.named['name'] ?? ctx.positional[0]);
    const definitions = patterns(ctx.named['definition']);
    const excluded = patterns(ctx.named['exclude']).map(wildcardToRegex);
    const all = allAliases(ctx);
    const nameQueries = names.length > 0 || definitions.length === 0 ? (names.length > 0 ? names : ['*']) : [];
    const wanted: Array<{ text: string; kind: 'name' | 'definition' }> = [
      ...nameQueries.map(text => ({ text, kind: 'name' as const })),
      ...definitions.map(text => ({ text, kind: 'definition' as const })),
    ];
    const found = new Map<string, AliasEntry>();
    for (const { text, kind } of wanted) {
      const matcher = wildcardToRegex(text);
      const hits = all.filter(entry => matcher.test(kind === 'name' ? entry.Name : entry.Definition)
        && !excluded.some(pattern => pattern.test(entry.Name)));
      for (const hit of hits) found.set(hit.Name.toLowerCase(), hit);
      if (hits.length === 0 && !hasWildcard(text) && excluded.length === 0) {
        ctx.emitError(`Get-Alias : This command cannot find a matching alias because an alias with the ${kind} '${text}' does not exist.`);
      }
    }
    const result = [...found.values()].sort((a, b) => a.Name.toLowerCase().localeCompare(b.Name.toLowerCase()));
    return result.length === 0 ? null : result as unknown as PSValue;
  }
}

abstract class WriteAliasCmdlet implements ICmdlet {
  abstract readonly name: string;
  readonly aliases: readonly string[] = [];
  readonly parameters = ['Name', 'Value', 'Description', 'Option', 'PassThru', 'Scope', 'Force'] as const;
  readonly supportsShouldProcess = true as const;

  protected abstract readonly overwritesExisting: boolean;

  execute(ctx: CmdletContext): PSValue {
    const name = psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '');
    const definition = psValueToString(ctx.named['value'] ?? ctx.positional[1] ?? '');
    if (name === '' || definition === '') {
      throw new PSRuntimeError(`Cannot bind argument to parameter '${name === '' ? 'Name' : 'Value'}' because it is an empty string.`,
        'System.Management.Automation.ParameterBindingValidationException');
    }
    const description = psValueToString(ctx.named['description'] ?? '');
    const force = ctx.named['force'] === true;
    const exists = ctx.runtime.hasAlias(name);
    if (exists && !this.overwritesExisting && !force) {
      throw new PSRuntimeError(`The alias is not allowed, because an alias with the name '${name}' already exists.`,
        'System.Management.Automation.SessionStateException');
    }
    ctx.runtime.defineAlias(name, definition, description);
    return ctx.named['passthru'] === true ? aliasEntry(name, definition, description) as unknown as PSValue : null;
  }
}

export class NewAliasCmdlet extends WriteAliasCmdlet {
  readonly name = 'new-alias';
  protected readonly overwritesExisting = false;
}

export class SetAliasCmdlet extends WriteAliasCmdlet {
  readonly name = 'set-alias';
  readonly aliases: readonly string[] = ['sal'];
  protected readonly overwritesExisting = true;
}

export class RemoveAliasCmdlet implements ICmdlet {
  readonly name = 'remove-alias';
  readonly aliases = [] as const;
  readonly coreOnly = true as const;
  readonly parameters = ['Name', 'Scope', 'Force'] as const;

  execute(ctx: CmdletContext): PSValue {
    for (const name of patterns(ctx.named['name'] ?? ctx.positional[0])) {
      if (!ctx.runtime.removeAlias(name)) {
        throw new PSRuntimeError(`Cannot find alias because alias '${name}' does not exist.`, 'System.Management.Automation.ItemNotFoundException');
      }
    }
    return null;
  }
}
