/**
 * CiscoPolicyCommands — prefix-lists & route-maps as real config
 * objects (PolicyRepository). Global config + config-route-map
 * sub-mode + their show family. Router-only.
 */
import type { CommandTrie } from '../CommandTrie';
import type { CommandSpec } from '@/cli/CommandTable';
import { specsFromTrieRegistrations } from '@/cli/commands/trieAdapter';
import { formatInvalidInput } from '../CommandTrie';
import { boundedInteger, type ArgumentSpec } from '@/cli/ArgumentTypes';
import { resolveEnumValue } from '@/cli/ArgumentTypes';
import type { PolicyRepository } from '../../inspection/config/PolicyRepository';
import {
  parseRouteMapClause, routeMapClauseAlternatives, type RouteMapClauseKind,
} from '../../router/policy/routeMapClauses';
import { INCOMPLETE_MESSAGE } from '../cli/CliDiagnostic';

interface Ctx {
  setMode(m: 'config-route-map' | 'config'): void;
  getSelectedRouteMap(): { name: string; seq: number } | null;
  setSelectedRouteMap(v: { name: string; seq: number } | null): void;
}

const ROUTE_MAP_SEQ_RANGE: readonly [number, number] = [0, 65535];

const ACTION_SPEC: ArgumentSpec = {
  name: 'action', type: 'ENUM',
  values: [
    { keyword: 'deny', description: 'Specify packets to reject' },
    { keyword: 'permit', description: 'Specify packets to forward' },
  ],
};

function lireAction(token: string | undefined): 'permit' | 'deny' | undefined {
  if (token === undefined) return undefined;
  return resolveEnumValue(ACTION_SPEC, token) as 'permit' | 'deny' | undefined;
}

function colonneDeIndex(tete: string, args: readonly string[], index: number): number {
  if (index < 0 || index > args.length) return tete.length + args.join(' ').length;
  return tete.length + args.slice(0, index).reduce((n, m) => n + m.length + 1, 0);
}

function colonneDuJeton(
  tete: string, args: readonly string[], jeton: string | undefined,
): number {
  return colonneDeIndex(tete, args, jeton === undefined ? -1 : args.indexOf(jeton));
}

export function buildPolicyConfig(
  configTrie: CommandTrie, routeMapTrie: CommandTrie,
  ctx: Ctx, repo: PolicyRepository,
): void {
  configTrie.registerGreedy('route-map', 'Configure a route-map', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    const name = args[0];
    const action = args[1] === undefined ? 'permit' : lireAction(args[1]);
    if (action === undefined) {
      return formatInvalidInput(colonneDuJeton('route-map ', args, args[1]));
    }
    const realSeq = args[2] === undefined
      ? 10
      : boundedInteger(args[2], ROUTE_MAP_SEQ_RANGE[0], ROUTE_MAP_SEQ_RANGE[1]);
    if (realSeq === null) {
      return formatInvalidInput(colonneDuJeton('route-map ', args, args[2]));
    }
    repo.ensureRouteMap(name, action, realSeq);
    ctx.setSelectedRouteMap({ name, seq: realSeq });
    ctx.setMode('config-route-map');
    return '';
  });
  configTrie.registerGreedy('no route-map', 'Remove a route-map', (args) => {
    if (args[0]) repo.removeRouteMap(args[0]);
    return '';
  });

  buildRouteMapSubmodeOn(routeMapTrie, ctx, repo);
}

export function buildRouteMapSubmodeOn(
  routeMapTrie: CommandTrie, ctx: Ctx, repo: PolicyRepository,
): void {
  const clause = () => {
    const sel = ctx.getSelectedRouteMap();
    return sel ? repo.ensureRouteMap(sel.name, 'permit', sel.seq) : null;
  };
  const poser = (kind: RouteMapClauseKind, args: string[]): string => {
    const lu = parseRouteMapClause(kind, args);
    if (!('line' in lu)) {
      if (lu.incomplete) return INCOMPLETE_MESSAGE;
      return formatInvalidInput(colonneDeIndex(`${kind} `, args, lu.at));
    }
    const c = clause();
    if (!c) return '';
    const list = kind === 'match' ? c.match : c.set;
    const value = lu.line.slice(kind.length + 1);
    if (!list.includes(value)) list.push(value);
    return '';
  };
  routeMapTrie.registerGreedy('match', 'Match clause', (args) => poser('match', args));
  routeMapTrie.registerGreedy('set', 'Set clause', (args) => poser('set', args));
  routeMapTrie.registerGreedy('no match', 'Remove match clause', (args) => {
    const c = clause(); if (!c) return '';
    const pattern = args.join(' ').toLowerCase();
    c.match = c.match.filter(l => !l.toLowerCase().startsWith(pattern));
    return '';
  });
  routeMapTrie.registerGreedy('no set', 'Remove set clause', (args) => {
    const c = clause(); if (!c) return '';
    const pattern = args.join(' ').toLowerCase();
    c.set = c.set.filter(l => !l.toLowerCase().startsWith(pattern));
    return '';
  });
  routeMapTrie.registerGreedy('description', 'Route-map description', (args) => {
    const c = clause(); if (c) c.description = args.join(' ');
    return '';
  });
}

const ROUTE_MAP_ARGUMENTS:
Readonly<Record<string, ArgumentSpec | readonly ArgumentSpec[] | null>> = {
  match: { name: 'critere', type: 'REST',
    description: 'Criterion the route must satisfy',
    alternatives: routeMapClauseAlternatives('match') },
  set: { name: 'action', type: 'REST',
    description: 'Value the route-map applies to a matching route',
    alternatives: routeMapClauseAlternatives('set') },
  description: { name: 'texte', type: 'REST', literal: 'LINE',
    description: 'Description of this route-map clause' },
};

export function routeMapSubmodeSpecs(
  ctx: Ctx, repo: PolicyRepository,
): CommandSpec[] {
  return specsFromTrieRegistrations(
    (collector) =>
      buildRouteMapSubmodeOn(collector as unknown as CommandTrie, ctx, repo),
    {
      modes: ['config-route-map'], minPrivilege: 15,
      undoFromNegatedPaths: true,
      argumentFor: (path) => ROUTE_MAP_ARGUMENTS[path],
    },
  );
}

export function registerPolicyShow(
  trie: CommandTrie, repo: PolicyRepository,
): void {
  trie.registerGreedy('show ip prefix-list', 'Display IP prefix-lists', (a) =>
    repo.renderPrefixLists(a.find((x) => !/^detail|summary$/.test(x)), false));
  trie.registerGreedy('show ipv6 prefix-list', 'Display IPv6 prefix-lists', (a) =>
    repo.renderPrefixLists(a.find((x) => !/^detail|summary$/.test(x)), true));
  trie.registerGreedy('show route-map', 'Display route-maps', (a) => {
    if (a.length > 1) return formatInvalidInput('show route-map '.length + a[0].length + 1);
    return repo.renderRouteMaps(a[0]);
  });
}

const POLICY_SHOW_ARGUMENTS: Readonly<Record<string, [string, string]>> = {
  'show ip prefix-list': ['WORD', 'Name of a prefix list'],
  'show ipv6 prefix-list': ['WORD', 'Name of a prefix list'],
  'show route-map': ['WORD', 'Route map name'],
};

export function policyShowSpecs(repo: PolicyRepository): CommandSpec[] {
  return specsFromTrieRegistrations(
    (collector) => registerPolicyShow(collector as unknown as CommandTrie, repo),
    {
      modes: ['user', 'privileged'],
      minPrivilege: 1,
      restDescriptionFor: (path) => POLICY_SHOW_ARGUMENTS[path]?.[1],
      restLiteralFor: (path) => POLICY_SHOW_ARGUMENTS[path]?.[0],
    },
  );
}
