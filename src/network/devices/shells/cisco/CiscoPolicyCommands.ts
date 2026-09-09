/**
 * CiscoPolicyCommands — ce que le socle ne porte pas encore des
 * politiques : la famille `show` des prefix-lists et des route-maps.
 *
 * `route-map` et son sous-mode sont declares sur le socle
 * (`routeMapSpecs.ts`), engendres depuis la table des clauses que le
 * moteur evalue. Router-only.
 */
import type { CommandTrie } from '../CommandTrie';
import type { CommandSpec } from '@/cli/CommandTable';
import { specsFromTrieRegistrations } from '@/cli/commands/trieAdapter';
import { formatInvalidInput } from '../CommandTrie';
import type { PolicyRepository } from '../../inspection/config/PolicyRepository';

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
