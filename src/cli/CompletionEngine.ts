import { argumentAccepts, argumentSuggestions, argumentCompletableValues } from './ArgumentTypes';
import type { CliSession } from './CliSession';
import type { CommandTable, TreeNode } from './CommandTable';
import { subtreeReachable, tokenize, uniqueChild } from './CommandParser';

export type CompletionTrigger = 'TAB' | 'QUESTION_MARK';

export interface Suggestion {
  readonly value: string;
  readonly description: string;
  readonly isArgument: boolean;
  readonly completable?: boolean;
}

export interface CompletionResult {
  readonly suggestions: readonly Suggestion[];
  readonly completion?: string;
}

export interface Cursor {
  readonly node: TreeNode;
  readonly prefix: string;
  readonly resolved: boolean;
}

export function locateCursor(
  table: CommandTable, input: string, session: CliSession,
): Cursor {
  const endsWithSpace = /\s$/.test(input);
  const tokens = tokenize(input);
  const walked = endsWithSpace ? tokens : tokens.slice(0, -1);
  const prefix = endsWithSpace ? '' : (tokens[tokens.length - 1] ?? '');

  let node = table.rootNode();
  for (const token of walked) {
    const child = uniqueChild(node, token, table, session);
    if (child) { node = child; continue; }

    const argument = table.argumentAt(node, session, AIDE);
    if (argument?.argument && argumentAccepts(argument.argument, token)) {
      node = argument;
      continue;
    }
    return { node, prefix, resolved: false };
  }
  return { node, prefix, resolved: true };
}

export function complete(
  table: CommandTable, input: string, session: CliSession, trigger: CompletionTrigger,
): CompletionResult {
  const cursor = locateCursor(table, input, session);
  if (!cursor.resolved) return { suggestions: [] };

  const suggestions = suggestionsAt(cursor, table, session, trigger);
  if (trigger === 'QUESTION_MARK') return { suggestions };

  const words = suggestions.filter(s => !s.isArgument || s.completable === true);
  return {
    suggestions,
    completion: words.length === 1 ? words[0].value : undefined,
  };
}

const AIDE = { modeStrict: true, forHelp: true } as const;

function suggestionsAt(
  cursor: Cursor, table: CommandTable, session: CliSession, trigger: CompletionTrigger,
): Suggestion[] {
  const lowered = cursor.prefix.toLowerCase();
  const out: Suggestion[] = [];

  for (const child of cursor.node.children.values()) {
    if (child.keyword === undefined) continue;
    if (!child.keyword.toLowerCase().startsWith(lowered)) continue;
    if (!subtreeReachable(child, table, session, AIDE)) continue;

    out.push({
      value: child.keyword,
      description: describe(child, table, session),
      isArgument: false,
    });
  }

  const argument = table.argumentAt(cursor.node, session, AIDE)?.argument;
  if (argument && trigger === 'QUESTION_MARK'
    && (argument.values || argument.alternatives || cursor.prefix.length === 0)) {
    for (const suggestion of argumentSuggestions(argument)) {
      if (!suggestion.keyword.toLowerCase().startsWith(lowered)) continue;
      out.push({
        value: suggestion.keyword, description: suggestion.description, isArgument: true,
      });
    }
  }

  if (argument && trigger === 'TAB') {
    for (const suggestion of argumentCompletableValues(argument)) {
      if (!suggestion.keyword.toLowerCase().startsWith(lowered)) continue;
      out.push({
        value: suggestion.keyword, description: suggestion.description,
        isArgument: true, completable: true,
      });
    }
  }

  const ici = table.specAt(cursor.node, session, AIDE);
  if (trigger === 'QUESTION_MARK' && ici && cursor.prefix.length === 0
    && !ici.existsOnlyNegated) {
    out.push({ value: '<cr>', description: '', isArgument: true });
  }

  return out.sort((left, right) => left.value.localeCompare(right.value));
}

function describe(node: TreeNode, table: CommandTable, session: CliSession): string {
  const legende = table.legendAt(node, session);
  if (legende) return legende;
  // La description suit le MODE : deux modes qui nomment la meme
  // commande ne la decrivent pas pareil, et prendre la premiere
  // declaree faisait decrire un pool DHCPv6 par les mots du pool IPv4.
  const ici = table.specAt(node, session, AIDE);
  if (ici) return ici.description;

  for (const child of node.children.values()) {
    if (!subtreeReachable(child, table, session, AIDE)) continue;
    const inherited = describe(child, table, session);
    if (inherited) return inherited;
  }
  const place = table.argumentAt(node, session, AIDE);
  if (place) {
    const herite = describe(place, table, session);
    if (herite) return herite;
  }
  if (node.specs.length > 0) return node.specs[0].description;
  return node.argumentChildren[0]
    ? describe(node.argumentChildren[0], table, session) : '';
}
