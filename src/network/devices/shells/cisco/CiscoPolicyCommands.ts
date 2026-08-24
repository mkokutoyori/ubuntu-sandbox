/**
 * CiscoPolicyCommands — prefix-lists & route-maps as real config
 * objects (PolicyRepository). Global config + config-route-map
 * sub-mode + their show family. Router-only.
 */
import type { CommandTrie } from '../CommandTrie';
import type { CommandSpec } from '@/cli/CommandTable';
import { specsFromTrieRegistrations } from '@/cli/commands/trieAdapter';
import { formatInvalidInput } from '../CommandTrie';
import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { PolicyRepository, PrefixListEntry }
  from '../../inspection/config/PolicyRepository';

interface Ctx {
  setMode(m: 'config-route-map' | 'config'): void;
  getSelectedRouteMap(): { name: string; seq: number } | null;
  setSelectedRouteMap(v: { name: string; seq: number } | null): void;
}

/** Parse `[seq N] {permit|deny} A.B.C.D/L [ge X] [le Y]`. */
function parsePrefixEntry(args: string[], repo: PolicyRepository,
                          name: string, v6: boolean): PrefixListEntry | null {
  let i = 0;
  let seq: number | undefined;
  if (args[i] === 'seq') { seq = parseInt(args[i + 1], 10); i += 2; }
  const action = args[i] === 'deny' ? 'deny' : 'permit';
  i += 1;
  const prefix = args[i++];
  if (!prefix) return null;
  const entry: PrefixListEntry = {
    seq: seq ?? repo.nextPrefixSeq(name, v6), action, prefix,
  };
  for (; i < args.length; i++) {
    if (args[i] === 'ge') entry.ge = parseInt(args[++i], 10);
    else if (args[i] === 'le') entry.le = parseInt(args[++i], 10);
  }
  return entry;
}

export function buildPolicyConfig(
  configTrie: CommandTrie, routeMapTrie: CommandTrie,
  ctx: Ctx, repo: PolicyRepository,
): void {
  const prefixHandler = (v6: boolean) => (args: string[]): string => {
    if (args.length < 2) return '% Incomplete command.';
    const [name, ...rest] = args;
    const e = parsePrefixEntry(rest, repo, name, v6);
    if (!e) return '% Incomplete command.';
    repo.addPrefix(name, e, v6);
    return '';
  };
  configTrie.registerGreedy('ip prefix-list', 'Build a prefix list',
    prefixHandler(false));
  configTrie.registerGreedy('ipv6 prefix-list', 'Build an IPv6 prefix list',
    prefixHandler(true));
  configTrie.registerGreedy('no ip prefix-list', 'Remove a prefix list', (a) => {
    const seqIdx = a.indexOf('seq');
    repo.removePrefixList(a[0], seqIdx >= 0 ? parseInt(a[seqIdx + 1], 10) : undefined);
    return '';
  });
  configTrie.registerGreedy('no ipv6 prefix-list', 'Remove an IPv6 prefix list', (a) => {
    repo.removePrefixList(a[0], undefined, true);
    return '';
  });

  configTrie.registerGreedy('route-map', 'Configure a route-map', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    const name = args[0];
    const action = args[1] === 'deny' ? 'deny' : 'permit';
    const seq = parseInt(args[2], 10);
    const realSeq = Number.isNaN(seq) ? 10 : seq;
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
  const addClause = (list: string[], args: string[]) => {
    const value = args.join(' ');
    if (!list.includes(value)) list.push(value);
  };
  routeMapTrie.registerGreedy('match', 'Match clause', (args) => {
    const c = clause();
    if (c) addClause(c.match, args);
    return '';
  });
  routeMapTrie.registerGreedy('set', 'Set clause', (args) => {
    const c = clause();
    if (c) addClause(c.set, args);
    return '';
  });
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
    description: 'Criterion the route must satisfy' },
  set: { name: 'action', type: 'REST',
    description: 'Value the route-map applies to a matching route' },
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
