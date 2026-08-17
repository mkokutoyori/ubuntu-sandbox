import { argumentAccepts } from './ArgumentTypes';
import type { CliSession } from './CliSession';
import type { CommandSpec, CommandTable, TreeNode } from './CommandTable';

export type ParseResult =
  | { readonly status: 'empty' }
  | {
    readonly status: 'ok'; readonly spec: CommandSpec;
    readonly args: Record<string, string>; readonly negated: boolean;
  }
  | { readonly status: 'ambiguous'; readonly candidates: string[]; readonly token: string }
  | { readonly status: 'incomplete'; readonly consumed: number }
  | { readonly status: 'invalid'; readonly token: string; readonly position: number };

export function tokenize(input: string): string[] {
  return input.trim().split(/\s+/).filter(Boolean);
}

export function parseCommand(
  table: CommandTable, input: string, session: CliSession,
): ParseResult {
  const all = tokenize(input);
  if (all.length === 0) return { status: 'empty' };

  const negated = all[0].toLowerCase() === 'no' && all.length > 1;
  const tokens = negated ? all.slice(1) : all;

  let node = table.rootNode();
  const args: Record<string, string> = {};

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const matches = keywordMatches(node, token, table, session);

    if (matches.length > 1) {
      return { status: 'ambiguous', candidates: matches.map(m => m.keyword!), token };
    }
    if (matches.length === 1) { node = matches[0]; continue; }

    const argument = node.argumentChild;
    if (argument?.argument?.type === 'REST') {
      args[argument.argument.name] = tokens.slice(index).join(' ');
      node = argument;
      break;
    }
    if (argument?.argument && argumentAccepts(argument.argument, token)) {
      args[argument.argument.name] = token;
      node = argument;
      continue;
    }
    return { status: 'invalid', token, position: index };
  }

  const spec = node.spec;
  if (!spec) return { status: 'incomplete', consumed: tokens.length };
  if (!table.isReachable(spec, session)) {
    return { status: 'invalid', token: tokens[tokens.length - 1], position: tokens.length - 1 };
  }
  if (negated && spec.undo === undefined) {
    return { status: 'invalid', token: 'no', position: 0 };
  }
  return { status: 'ok', spec, args, negated };
}

export function keywordMatches(
  node: TreeNode, token: string, table: CommandTable, session: CliSession,
): TreeNode[] {
  const lowered = token.toLowerCase();
  const reachable = [...node.children.values()]
    .filter(child => subtreeReachable(child, table, session));

  const exact = reachable.find(child => child.keyword?.toLowerCase() === lowered);
  if (exact) return [exact];

  return reachable.filter(child => child.keyword?.toLowerCase().startsWith(lowered));
}

export function subtreeReachable(
  node: TreeNode, table: CommandTable, session: CliSession,
): boolean {
  if (node.spec && table.isReachable(node.spec, session)) return true;
  if (node.argumentChild && subtreeReachable(node.argumentChild, table, session)) return true;

  for (const child of node.children.values()) {
    if (subtreeReachable(child, table, session)) return true;
  }
  return false;
}

export function uniqueChild(
  node: TreeNode, token: string, table: CommandTable, session: CliSession,
): TreeNode | undefined {
  const matches = keywordMatches(node, token, table, session);
  return matches.length === 1 ? matches[0] : undefined;
}
