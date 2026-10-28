/**
 * CiscoPolicyCommands — ce que le socle ne porte pas encore des
 * politiques : la famille `show` des prefix-lists et des route-maps.
 *
 * `route-map` et son sous-mode sont declares sur le socle
 * (`routeMapSpecs.ts`), engendres depuis la table des clauses que le
 * moteur evalue. Router-only.
 */
import type { CommandSpec } from '@/cli/CommandTable';
import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { PolicyRepository } from '../../inspection/config/PolicyRepository';

const PREFIX_LIST_VIEW: ArgumentSpec = {
  name: 'view', type: 'REST', optional: true, literal: 'WORD',
  description: 'Name of a prefix list',
  alternatives: [
    { keyword: 'detail', description: 'Detailed information' },
    { keyword: 'summary', description: 'Summary of the prefix lists' },
  ],
};

const ROUTE_MAP_NAME: ArgumentSpec = {
  name: 'name', type: 'WORD', optional: true, description: 'Route map name',
};

export function policyShowSpecs(repo: PolicyRepository): CommandSpec[] {
  const base = { modes: ['user', 'privileged'], minPrivilege: 1 };
  const prefixLists = (v6: boolean): CommandSpec => ({
    ...base,
    id: v6 ? 'show-ipv6-prefix-list' : 'show-ip-prefix-list',
    path: ['show', v6 ? 'ipv6' : 'ip', 'prefix-list', PREFIX_LIST_VIEW],
    description: v6 ? 'Display IPv6 prefix-lists' : 'Display IP prefix-lists',
    run: (_session, args) => repo.renderPrefixLists(
      (args.view ?? '').trim().split(/\s+/).find((x) => x !== '' && !/^(detail|summary)$/.test(x)),
      v6),
  });
  return [
    prefixLists(false),
    prefixLists(true),
    {
      ...base, id: 'show-route-map', path: ['show', 'route-map', ROUTE_MAP_NAME],
      description: 'Display route-maps',
      run: (_session, args) => repo.renderRouteMaps(args.name),
    },
  ];
}
