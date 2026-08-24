import {
  argumentAccepts, outsideEveryAnnouncedRange, resolveEnumValue,
} from './ArgumentTypes';
import type { CliSession } from './CliSession';
import type { ReachabilityOptions } from './CommandTable';
import type { CommandSpec, CommandTable, TreeNode } from './CommandTable';

export type ParseResult =
  | { readonly status: 'empty' }
  | {
    readonly status: 'ok'; readonly spec: CommandSpec;
    readonly args: Record<string, string>; readonly negated: boolean;
  }
  | { readonly status: 'ambiguous'; readonly candidates: string[]; readonly token: string }
  | { readonly status: 'incomplete'; readonly consumed: number }
  | {
    readonly status: 'invalid'; readonly token: string; readonly position: number;
    readonly refusePar?: 'argument' | 'niveau';
  };

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
      const suivant = tokens[index + 1];
      const viables = suivant === undefined
        ? matches
        : matches.filter(m => accepteEnsuite(m, suivant, table, session));
      if (viables.length !== 1) {
        return { status: 'ambiguous', candidates: matches.map(m => m.keyword!), token };
      }
      node = viables[0];
      continue;
    }
    if (matches.length === 1) { node = matches[0]; continue; }

    // La place d'argument appartient au MODE qui l'a declaree : sans ce
    // filtre, le glouton d'un sous-mode avalait le mot d'un autre mode
    // et rendait « incomplete » une frappe que celui-ci refuse.
    const argument = table.argumentAt(node, session);
    if (argument?.argument?.type === 'REST') {
      if (outsideEveryAnnouncedRange(token, argument.argument.alternatives ?? [])) {
        return { status: 'invalid', token, position: index, refusePar: 'argument' };
      }
      args[argument.argument.name] = tokens.slice(index).join(' ');
      node = argument;
      break;
    }
    if (argument?.argument && argumentAccepts(argument.argument, token)) {
      // La valeur RANGEE est la canonique : le gestionnaire recevrait
      // sinon `warn` la ou il attend `warnings`, et une abreviation
      // acceptee qui ne fait rien serait pire qu'un refus.
      args[argument.argument.name] =
        resolveEnumValue(argument.argument, token) ?? token;
      node = argument;
      continue;
    }
    if (argument?.argument) {
      return { status: 'invalid', token, position: index, refusePar: 'argument' };
    }
    return { status: 'invalid', token, position: index };
  }

  // Une commande d'un AUTRE mode n'est pas la commande de celui-ci : la
  // traiter comme telle faisait repondre `% Invalid input` la ou le
  // noeud porte, dans ce mode, des continuations parfaitement valides.
  const spec = table.specAt(node, session);
  if (!spec) return { status: 'incomplete', consumed: tokens.length };
  if (spec.existsOnlyNegated && !negated) {
    return { status: 'incomplete', consumed: tokens.length };
  }
  if (!table.isReachable(spec, session)) {
    return {
      status: 'invalid', token: tokens[tokens.length - 1],
      position: tokens.length - 1, refusePar: 'niveau',
    };
  }
  if (negated && spec.undo === undefined) {
    return { status: 'invalid', token: 'no', position: 0 };
  }
  return { status: 'ok', spec, args, negated };
}

function accepteEnsuite(
  node: TreeNode, token: string, table: CommandTable, session: CliSession,
): boolean {
  if (keywordMatches(node, token, table, session).length > 0) return true;
  const argument = table.argumentAt(node, session)?.argument;
  return argument !== undefined && argumentAccepts(argument, token);
}

export function keywordMatches(
  node: TreeNode, token: string, table: CommandTable, session: CliSession,
): TreeNode[] {
  const lowered = token.toLowerCase();
  const children = [...node.children.values()];
  const reachable = children.filter(child => subtreeReachable(child, table, session));

  const exact = reachable.find(child => child.keyword?.toLowerCase() === lowered);
  if (exact) return [exact];

  if (children.some(child => child.keyword?.toLowerCase() === lowered)) return [];

  return reachable.filter(child => child.keyword?.toLowerCase().startsWith(lowered));
}

export function subtreeReachable(
  node: TreeNode, table: CommandTable, session: CliSession,
  options: ReachabilityOptions = {},
): boolean {
  if (node.specs.some(spec => table.isReachable(spec, session, options))) return true;
  for (const place of node.argumentChildren) {
    if (subtreeReachable(place, table, session, options)) return true;
  }

  for (const child of node.children.values()) {
    if (subtreeReachable(child, table, session, options)) return true;
  }
  return false;
}

export function uniqueChild(
  node: TreeNode, token: string, table: CommandTable, session: CliSession,
): TreeNode | undefined {
  const matches = keywordMatches(node, token, table, session);
  return matches.length === 1 ? matches[0] : undefined;
}
