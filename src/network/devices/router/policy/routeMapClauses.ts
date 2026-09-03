import { boundedInteger } from '@/cli/ArgumentTypes';
import { isValidIPv4 } from '@/network/core/ip';
import {
  BGP_ORIGINS, BGP_WEIGHT_MAX, BGP_ATTRIBUTE_MAX, isBgpWellKnownCommunity,
} from '@/network/bgp/attributes';

export interface RouteMapClauseSpec {
  readonly words: readonly string[];
  readonly description: string;
  readonly judge: (tail: readonly string[]) => TailVerdict;
}

export type TailVerdict = null | 'incomplete' | { readonly at: number };

const OK: TailVerdict = null;

function entier(min: number, max: number, repetable = false): RouteMapClauseSpec['judge'] {
  return (tail) => {
    if (tail.length === 0) return 'incomplete';
    const bornes = repetable ? tail.length : 1;
    for (let i = 0; i < bornes; i++) {
      if (boundedInteger(tail[i], min, max) === null) return { at: i };
    }
    return tail.length > bornes ? { at: bornes } : OK;
  };
}

function motsFermes(mots: readonly string[]): RouteMapClauseSpec['judge'] {
  const admis = new Set(mots);
  return (tail) => {
    if (tail.length === 0) return 'incomplete';
    return admis.has(tail[0].toLowerCase()) ? OK : { at: 0 };
  };
}

function motLibre(minimum = 1): RouteMapClauseSpec['judge'] {
  return (tail) => (tail.length < minimum ? 'incomplete' : OK);
}

const PRECEDENCE_NAMES = [
  'routine', 'priority', 'immediate', 'flash', 'flash-override',
  'critical', 'internet', 'network',
] as const;

const ROUTE_TYPES = [
  'external', 'internal', 'level-1', 'level-2', 'local', 'nssa-external',
] as const;

const METRIC_TYPES = ['internal', 'external', 'type-1', 'type-2'] as const;

const LEVELS = ['level-1', 'level-2', 'level-1-2', 'stub-area', 'backbone'] as const;

const NEXT_HOP_KEYWORDS = ['peer-address', 'self'] as const;

function jugerMetrique(tail: readonly string[]): TailVerdict {
  if (tail.length === 0) return 'incomplete';
  if (tail.length === 1) {
    const signe = /^[+-]/.test(tail[0]) ? tail[0].slice(1) : tail[0];
    return boundedInteger(signe, 0, BGP_ATTRIBUTE_MAX) === null ? { at: 0 } : OK;
  }
  if (tail.length !== 5) return { at: 1 };
  for (let i = 0; i < 5; i++) {
    if (boundedInteger(tail[i], 0, BGP_ATTRIBUTE_MAX) === null) return { at: i };
  }
  return OK;
}

function jugerCommunaute(tail: readonly string[]): TailVerdict {
  if (tail.length === 0) return 'incomplete';
  for (let i = 0; i < tail.length; i++) {
    const mot = tail[i].toLowerCase();
    if (mot === 'additive') return i === 0 ? { at: 0 } : OK;
    if (isBgpWellKnownCommunity(mot)) continue;
    const paire = mot.match(/^(\d+):(\d+)$/);
    if (paire) {
      if (boundedInteger(paire[1], 0, 65535) === null) return { at: i };
      if (boundedInteger(paire[2], 0, 65535) === null) return { at: i };
      continue;
    }
    if (boundedInteger(mot, 1, BGP_ATTRIBUTE_MAX) === null) return { at: i };
  }
  return OK;
}

function jugerSautSuivant(tail: readonly string[]): TailVerdict {
  if (tail.length === 0) return 'incomplete';
  for (let i = 0; i < tail.length; i++) {
    const mot = tail[i].toLowerCase();
    if ((NEXT_HOP_KEYWORDS as readonly string[]).includes(mot)) continue;
    if (!isValidIPv4(tail[i])) return { at: i };
  }
  return OK;
}

function jugerPrecedence(tail: readonly string[]): TailVerdict {
  if (tail.length === 0) return 'incomplete';
  const mot = tail[0].toLowerCase();
  if ((PRECEDENCE_NAMES as readonly string[]).includes(mot)) return OK;
  return boundedInteger(mot, 0, 7) === null ? { at: 0 } : OK;
}

function jugerAsPath(tail: readonly string[]): TailVerdict {
  if (tail.length === 0) return 'incomplete';
  const tete = tail[0].toLowerCase();
  if (tete === 'tag') return OK;
  if (tete !== 'prepend') return { at: 0 };
  if (tail.length === 1) return 'incomplete';
  for (let i = 1; i < tail.length; i++) {
    if (boundedInteger(tail[i], 1, BGP_ATTRIBUTE_MAX) === null) return { at: i };
  }
  return OK;
}

function jugerOrigine(tail: readonly string[]): TailVerdict {
  if (tail.length === 0) return 'incomplete';
  const mot = tail[0].toLowerCase();
  if (!(BGP_ORIGINS as readonly string[]).includes(mot)) return { at: 0 };
  if (mot !== 'egp') return tail.length > 1 ? { at: 1 } : OK;
  if (tail.length === 1) return 'incomplete';
  return boundedInteger(tail[1], 1, BGP_ATTRIBUTE_MAX) === null ? { at: 1 } : OK;
}

function jugerLongueur(tail: readonly string[]): TailVerdict {
  if (tail.length < 2) return 'incomplete';
  for (let i = 0; i < 2; i++) {
    if (boundedInteger(tail[i], 0, BGP_ATTRIBUTE_MAX) === null) return { at: i };
  }
  return OK;
}

export const ROUTE_MAP_MATCH_CLAUSES: readonly RouteMapClauseSpec[] = Object.freeze([
  { words: ['as-path'], description: 'Match BGP AS path list', judge: entier(1, 500, true) },
  { words: ['community'], description: 'Match BGP community list', judge: motLibre() },
  { words: ['extcommunity'], description: 'Match BGP/VPN extended community list',
    judge: motLibre() },
  { words: ['interface'], description: 'Match first hop interface of route',
    judge: motLibre() },
  { words: ['ip', 'address'], description: 'Match address of route or match packet',
    judge: motLibre() },
  { words: ['ip', 'next-hop'], description: 'Match next-hop address of route',
    judge: motLibre() },
  { words: ['ip', 'route-source'], description: 'Match advertising source address of route',
    judge: motLibre() },
  { words: ['ipv6', 'address'], description: 'Match IPv6 address of route',
    judge: motLibre() },
  { words: ['ipv6', 'next-hop'], description: 'Match IPv6 next-hop address of route',
    judge: motLibre() },
  { words: ['length'], description: 'Packet length', judge: jugerLongueur },
  { words: ['metric'], description: 'Match metric of route',
    judge: entier(0, BGP_ATTRIBUTE_MAX) },
  { words: ['route-type'], description: 'Match route-type of route',
    judge: motsFermes(ROUTE_TYPES) },
  { words: ['tag'], description: 'Match tag of route',
    judge: entier(0, BGP_ATTRIBUTE_MAX, true) },
]);

export const ROUTE_MAP_SET_CLAUSES: readonly RouteMapClauseSpec[] = Object.freeze([
  { words: ['as-path'], description: 'Prepend string for a BGP AS-path attribute',
    judge: jugerAsPath },
  { words: ['automatic-tag'], description: 'Automatically compute TAG value',
    judge: (tail) => (tail.length ? { at: 0 } : OK) },
  { words: ['comm-list'], description: 'Set BGP community list (for deletion)',
    judge: motLibre(2) },
  { words: ['community'], description: 'BGP community attribute', judge: jugerCommunaute },
  { words: ['default', 'interface'], description: 'Default output interface',
    judge: motLibre() },
  { words: ['interface'], description: 'Output interface', judge: motLibre() },
  { words: ['ip', 'default', 'next-hop'], description: 'Default next hop address',
    judge: jugerSautSuivant },
  { words: ['ip', 'df'], description: "Set IP Don't Fragment bit", judge: entier(0, 1) },
  { words: ['ip', 'next-hop'], description: 'Next hop address', judge: jugerSautSuivant },
  { words: ['ip', 'precedence'], description: 'Set IP precedence field',
    judge: jugerPrecedence },
  { words: ['ipv6', 'next-hop'], description: 'IPv6 next hop address',
    judge: motLibre() },
  { words: ['level'], description: 'Where to import route', judge: motsFermes(LEVELS) },
  { words: ['local-preference'], description: 'BGP local preference path attribute',
    judge: entier(0, BGP_ATTRIBUTE_MAX) },
  { words: ['metric'], description: 'Metric value for destination routing protocol',
    judge: jugerMetrique },
  { words: ['metric-type'], description: 'Type of metric for destination routing protocol',
    judge: motsFermes(METRIC_TYPES) },
  { words: ['origin'], description: 'BGP origin code', judge: jugerOrigine },
  { words: ['tag'], description: 'Tag value for destination routing protocol',
    judge: entier(0, BGP_ATTRIBUTE_MAX) },
  { words: ['weight'], description: 'BGP weight for routing table',
    judge: entier(0, BGP_WEIGHT_MAX) },
]);

export type RouteMapClauseKind = 'match' | 'set';

function clausesOf(kind: RouteMapClauseKind): readonly RouteMapClauseSpec[] {
  return kind === 'match' ? ROUTE_MAP_MATCH_CLAUSES : ROUTE_MAP_SET_CLAUSES;
}

export interface RouteMapClauseProblem {
  readonly at: number;
  readonly incomplete?: boolean;
}

export function parseRouteMapClause(
  kind: RouteMapClauseKind, args: readonly string[],
): { line: string } | RouteMapClauseProblem {
  if (args.length === 0) return { at: 0, incomplete: true };

  const candidates = clausesOf(kind).filter(
    (c) => c.words[0] === args[0].toLowerCase());
  if (candidates.length === 0) return { at: 0 };

  const spec = candidates
    .slice()
    .sort((a, b) => b.words.length - a.words.length)
    .find((c) => c.words.every((w, i) => w === (args[i] ?? '').toLowerCase()));
  if (!spec) {
    const profondeur = Math.max(...candidates.map((c) => c.words.length));
    for (let i = 1; i < profondeur; i++) {
      if (args[i] === undefined) return { at: i, incomplete: true };
    }
    return { at: 1 };
  }

  const verdict = spec.judge(args.slice(spec.words.length));
  if (verdict === 'incomplete') return { at: args.length, incomplete: true };
  if (verdict !== null) return { at: spec.words.length + verdict.at };
  return { line: [kind, ...args].join(' ') };
}

/**
 * Les alternatives que l'aide annonce sont les TETES de la meme table.
 */
export function routeMapClauseAlternatives(
  kind: RouteMapClauseKind,
): ReadonlyArray<{ keyword: string; description: string }> {
  const vues = new Map<string, string>();
  for (const c of clausesOf(kind)) {
    if (!vues.has(c.words[0])) vues.set(c.words[0], c.description);
  }
  return [...vues].map(([keyword, description]) => ({ keyword, description }));
}
