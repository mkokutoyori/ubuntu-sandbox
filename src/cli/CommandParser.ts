import {
  argumentAccepts, isQuoted, outsideEveryAnnouncedRange, resolveEnumValue,
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

export interface TokenizeOptions {
  readonly escapesAnyCharacter?: boolean;
}

/**
 * Ce que la frappe contenait AVANT que les blancs ne soient reduits.
 *
 * Un argument `REST` etait rendu par `tokens.slice(i).join(' ')`, donc
 * `banner motd #Deux  blancs#` posait une banniere a un seul blanc : la
 * commande dont tout l'objet est de garder le texte tel quel le
 * reecrivait. Les DEBUTS de chaque jeton suffisent a retrouver la
 * tranche d'origine, et ils sont produits par le meme parcours — un
 * second decoupage finirait par ne plus dire la meme chose que le
 * premier.
 */
export interface TokensAvecPositions {
  readonly tokens: string[];
  readonly starts: number[];
}

export function tokenize(input: string, options?: TokenizeOptions): string[] {
  return tokenizeWithPositions(input, options).tokens;
}

export function tokenizeWithPositions(
  input: string, options?: TokenizeOptions,
): TokensAvecPositions {
  const anyCharacter = options?.escapesAnyCharacter === true;
  const out: string[] = [];
  const starts: number[] = [];
  let current = '';
  let quoted = false;
  let started = false;
  let escaped = false;
  let debut = 0;

  const flush = () => {
    out.push(escaped && !isQuoted(current) ? `"${current}"` : current);
    starts.push(debut);
    current = '';
    started = false;
    escaped = false;
  };

  for (let at = 0; at < input.length; at++) {
    const character = input[at];
    if (!started && !/\s/.test(character)) debut = at;
    if (character === '\\' && at + 1 < input.length
      && (anyCharacter || input[at + 1] === ' ')) {
      current += input[at + 1];
      started = true;
      escaped = true;
      at++;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      current += character;
      started = true;
      continue;
    }
    if (!quoted && /\s/.test(character)) {
      if (started) flush();
      continue;
    }
    current += character;
    started = true;
  }
  if (started) flush();
  return { tokens: out, starts };
}

export function tokenContent(token: string): string {
  return token.length >= 2 && token.startsWith('"') && token.endsWith('"')
    ? token.slice(1, -1)
    : token;
}

export function parseCommand(
  table: CommandTable, input: string, session: CliSession,
  options?: TokenizeOptions,
): ParseResult {
  const decoupe = tokenizeWithPositions(input, options);
  const all = decoupe.tokens;
  if (all.length === 0) return { status: 'empty' };

  const negated = all[0].toLowerCase() === 'no' && all.length > 1;
  const tokens = negated ? all.slice(1) : all;
  const debuts = negated ? decoupe.starts.slice(1) : decoupe.starts;

  let node = table.rootNode();
  const args: Record<string, string> = {};

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const matches = keywordMatches(node, token, table, session);

    if (matches.length > 1) {
      /*
       * L'abreviation se juge sur le MOT, jamais sur ce qui suit. Ce
       * bloc departageait les candidats en regardant si le mot suivant
       * leur convenait, si bien que `cl arp` passait — `clear` etant la
       * seule des deux branches a l'accepter — quand `cl` seul etait
       * refuse. Le meme prefixe decidait ou non selon la suite, et une
       * faute de frappe appliquait une commande que personne n'avait
       * tapee : `ip rout 192.168.9.0 …` posait la route. IOS tranche
       * l'inverse, sur une saisie qui porte pourtant un mot de plus
       * (`con t`, `co t`), et decrit la reparation comme « trouver QUEL
       * mot allonger ». Le trie portait la meme regle inventee ; les
       * deux moteurs la perdent ensemble, sans quoi la meme frappe
       * repondrait deux choses selon qui la sert.
       */
      return { status: 'ambiguous', candidates: matches.map(m => m.keyword!), token };
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
      args[argument.argument.name] = input.slice(debuts[index]).trimEnd();
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
