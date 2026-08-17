import { argumentAccepts, argumentPlaceholder } from './ArgumentTypes';
import type { CliSession } from './CliSession';
import type { CommandTable, TreeNode } from './CommandTable';
import { subtreeReachable, tokenize, uniqueChild } from './CommandParser';

export type CompletionTrigger = 'TAB' | 'QUESTION_MARK';

export interface Suggestion {
  readonly value: string;
  readonly description: string;
  readonly isArgument: boolean;
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

    const argument = node.argumentChild;
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

  const words = suggestions.filter(s => !s.isArgument);
  return {
    suggestions,
    completion: words.length === 1 ? words[0].value : undefined,
  };
}

function suggestionsAt(
  cursor: Cursor, table: CommandTable, session: CliSession, trigger: CompletionTrigger,
): Suggestion[] {
  const lowered = cursor.prefix.toLowerCase();
  const out: Suggestion[] = [];

  for (const child of cursor.node.children.values()) {
    if (child.keyword === undefined) continue;
    if (!child.keyword.toLowerCase().startsWith(lowered)) continue;
    if (!subtreeReachable(child, table, session)) continue;

    out.push({
      value: child.keyword,
      description: describe(child),
      isArgument: false,
    });
  }

  const argument = cursor.node.argumentChild?.argument;
  if (argument && trigger === 'QUESTION_MARK') {
    // Un argument ENUMERE a un domaine fini : l'aide le DECRIT valeur par
    // valeur au lieu d'annoncer un type muet, ce qui est tout l'interet
    // de `logging console ?` — les huit severites avec leur numero.
    if (argument.values) {
      for (const value of argument.values) {
        if (!value.keyword.toLowerCase().startsWith(lowered)) continue;
        out.push({ value: value.keyword, description: value.description, isArgument: true });
      }
    } else if (cursor.prefix.length === 0) {
      out.push({
        value: argumentPlaceholder(argument),
        description: argument.name,
        isArgument: true,
      });
    }
  }

  if (trigger === 'QUESTION_MARK' && cursor.node.spec && cursor.prefix.length === 0
    && table.isReachable(cursor.node.spec, session)) {
    out.push({ value: '<cr>', description: '', isArgument: true });
  }

  return out.sort((left, right) => left.value.localeCompare(right.value));
}

function describe(node: TreeNode): string {
  if (node.spec) return node.spec.description;

  for (const child of node.children.values()) {
    const inherited = describe(child);
    if (inherited) return inherited;
  }
  return node.argumentChild ? describe(node.argumentChild) : '';
}
