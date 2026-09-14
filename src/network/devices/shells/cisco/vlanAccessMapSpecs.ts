import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { CommandSpec } from '@/cli/CommandTable';

const MODE = ['config-access-map'] as const;

export interface VlanAccessMapHost {
  poserAction(action: 'forward' | 'drop'): string;
  ajouterListes(famille: 'ip' | 'mac', noms: readonly string[]): string;
  retirerListes(famille: 'ip' | 'mac', noms: readonly string[]): string;
}

const ACTION: ArgumentSpec = {
  name: 'action', type: 'ENUM',
  description: 'Action to take on matching traffic',
  values: [
    { keyword: 'drop', description: 'Drop the traffic' },
    { keyword: 'forward', description: 'Forward the traffic' },
  ],
};

const LISTES: ArgumentSpec = {
  name: 'listes', type: 'REST', literal: 'WORD', restMinWords: 1,
  description: 'Access list name',
};

const noms = (args: Record<string, string>): string[] =>
  args.listes.trim().split(/\s+/).filter(Boolean);

export function vlanAccessMapSpecs(ctx: () => VlanAccessMapHost): CommandSpec[] {
  const specs: CommandSpec[] = [{
    id: 'vacl-action',
    path: ['action', ACTION],
    description: 'Set the access-map action',
    modes: MODE, minPrivilege: 15,
    run: (_s, args) => ctx().poserAction(args.action as 'forward' | 'drop'),
  }];

  for (const famille of ['ip', 'mac'] as const) {
    specs.push({
      id: `vacl-match-${famille}`,
      path: ['match', famille, 'address', LISTES],
      description: `Match a${famille === 'ip' ? 'n IP' : ' MAC'} ACL`,
      undoDescription: 'Remove an ACL from this map',
      modes: MODE, minPrivilege: 15,
      run: (_s, args) => ctx().ajouterListes(famille, noms(args)),
      undo: (_s, args) => ctx().retirerListes(famille, noms(args)),
    });
  }
  return specs;
}

export const VLAN_ACCESS_MAP_LEGENDS: ReadonlyArray<
  readonly [readonly string[], string, readonly string[]]
> = [
  [['match'], 'Set the access-map match criteria', [...MODE]],
  [['match', 'ip'], 'Internet Protocol', [...MODE]],
  [['match', 'mac'], 'MAC configuration', [...MODE]],
];
