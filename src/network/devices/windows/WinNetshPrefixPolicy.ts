import { IPv6Address } from '../../core/types';
import type { PolicyEntry } from '../../layers/internet/DestinationSelection';
import { policyPrefixText, type PrefixPolicyStoreName } from './PrefixPolicyStore';
import type { WinCommandContext } from './WinCommandExecutor';

export type PrefixPolicyVerb = 'add' | 'set' | 'delete' | 'show';

const SYNTAX_ERROR = 'The syntax supplied for this command is not valid. Check help for the correct syntax.';
const ELEVATION_REQUIRED = 'The requested operation requires elevation.';
const PARAMETER_INCORRECT = 'The parameter is incorrect.';
const UINT32_MAX = 4294967295;

const STORE_VALUES = `       store          - One of the following values:
                        active: Change only lasts until next boot.
                        persistent: Change is persistent (default).`;

const USAGE: Record<PrefixPolicyVerb, string> = {
  add: `Usage: add prefixpolicy [prefix=]<IPv6 address>/<integer>
             [precedence=]<integer> [label=]<integer>
             [[store=]active|persistent]

Parameters:

       Tag              Value
       prefix         - Prefix for which to add a policy.
       precedence     - Precedence value in the policy table, used for
                        sorting destination addresses.
       label          - Label value that allows for policies that prefer a
                        particular source address prefix for use with a
                        destination address prefix.
${STORE_VALUES}

Remarks: Adds a source and destination address selection policy for
         a given prefix.

Example:

       add prefixpolicy ::/96 3 4
`,
  set: `Usage: set prefixpolicy [prefix=]<IPv6 address>/<integer> [precedence=]<integer>
             [label=]<integer> [[store=]active|persistent]

Parameters:

       Tag              Value
       prefix         - Prefix for which to add a policy.
       precedence     - Precedence value for ordering.
       label          - Label value for matching.
${STORE_VALUES}

Remarks: Modifies a source and destination address selection policy
         for a given prefix.

Example:

       set prefixpolicy ::/96 3 4
`,
  delete: `Usage: delete prefixpolicy [prefix=]<IPv6 address>/<integer>
             [[store=]active|persistent]

Parameters:

       Tag              Value
       prefix         - Prefix for which to add a policy.
       store          - One of the following values:
                        active: Deletion only lasts until next boot.
                        persistent: Deletion is persistent (default).

Remarks: Deletes the source and destination address selection policy
         for a given prefix.

Example:

       delete prefixpolicy ::/96
`,
  show: `Usage: show prefixpolicies [[store=]active|persistent]

Parameters:

       Tag         Value
       store     - One of the following values:
                   active: Show information in the stack (default).
                   persistent: Show persistent information.

Remarks: Shows prefix policy entries used in source and destination
         address selection.
`,
};

const TAGS: Record<PrefixPolicyVerb, readonly string[]> = {
  add: ['prefix', 'precedence', 'label', 'store'],
  set: ['prefix', 'precedence', 'label', 'store'],
  delete: ['prefix', 'store'],
  show: ['store'],
};

function bindArguments(tokens: readonly string[], tags: readonly string[]): Map<string, string> | null {
  const bound = new Map<string, string>();
  const positional: string[] = [];
  for (const token of tokens) {
    const equals = token.indexOf('=');
    if (equals <= 0) {
      positional.push(token);
      continue;
    }
    const tag = tags.find((candidate) => candidate === token.slice(0, equals).toLowerCase());
    if (tag === undefined || bound.has(tag)) return null;
    bound.set(tag, token.slice(equals + 1));
  }
  const free = tags.filter((tag) => !bound.has(tag));
  if (positional.length > free.length) return null;
  positional.forEach((value, index) => bound.set(free[index], value));
  return bound;
}

function parsePrefix(text: string): { readonly prefix: IPv6Address; readonly length: number } | null {
  const slash = text.lastIndexOf('/');
  if (slash < 0 || text.includes('%')) return null;
  const prefix = IPv6Address.tryParse(text.slice(0, slash));
  const digits = text.slice(slash + 1);
  if (prefix === null || !/^[0-9]{1,3}$/.test(digits)) return null;
  const length = Number(digits);
  return length <= 128 ? { prefix, length } : null;
}

function parseUnsigned(text: string): number | null {
  if (!/^[0-9]+$/.test(text)) return null;
  const value = Number(text);
  return value <= UINT32_MAX ? value : null;
}

function parseStore(text: string | undefined): PrefixPolicyStoreName | null {
  if (text === undefined) return 'persistent';
  const lowered = text.toLowerCase();
  return lowered === 'active' || lowered === 'persistent' ? lowered : null;
}

function showTable(ctx: WinCommandContext, store: PrefixPolicyStoreName): string {
  const lines = [
    `Querying ${store} state...`, '', 'Precedence  Label  Prefix', '----------  -----  --------------------------------',
  ];
  for (const row of ctx.prefixPolicies.listed(store)) {
    lines.push(`${String(row.precedence).padStart(10)}  ${String(row.label).padStart(5)}  ${policyPrefixText(row)}`);
  }
  lines.push('');
  return lines.join('\n');
}

export function netshPrefixPolicy(ctx: WinCommandContext, verb: PrefixPolicyVerb, tokens: readonly string[]): string {
  if (tokens.some((token) => token === '?' || token === '/?' || token.toLowerCase() === 'help')) return USAGE[verb];
  const bound = bindArguments(tokens, TAGS[verb]);
  const syntax = `${SYNTAX_ERROR}\n\n${USAGE[verb]}`;
  if (bound === null) return syntax;

  if (verb === 'show') {
    const store = parseStore(bound.get('store') ?? 'active');
    return store === null ? PARAMETER_INCORRECT : showTable(ctx, store);
  }

  const required = verb === 'delete' ? ['prefix'] : ['prefix', 'precedence', 'label'];
  if (required.some((tag) => !bound.has(tag))) return syntax;
  const target = parsePrefix(bound.get('prefix') as string);
  const store = parseStore(bound.get('store'));
  const precedence = verb === 'delete' ? 0 : parseUnsigned(bound.get('precedence') as string);
  const label = verb === 'delete' ? 0 : parseUnsigned(bound.get('label') as string);
  if (target === null || store === null || precedence === null || label === null) return PARAMETER_INCORRECT;
  if (!ctx.isElevated()) return ELEVATION_REQUIRED;

  if (verb === 'delete') {
    return ctx.prefixPolicies.delete(store, target.prefix, target.length) === 'ok' ? 'Ok.' : 'Element not found.';
  }
  const row: PolicyEntry = { prefix: target.prefix, length: target.length, precedence, label };
  const outcome = verb === 'add' ? ctx.prefixPolicies.add(store, row) : ctx.prefixPolicies.set(store, row);
  if (outcome === 'exists') return 'The object already exists.';
  return outcome === 'ok' ? 'Ok.' : 'Element not found.';
}
