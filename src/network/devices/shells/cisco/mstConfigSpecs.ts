import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { CommandSpec } from '@/cli/CommandTable';

const MODE = ['config-mst'] as const;

export interface MstConfigHost {
  poserNom(nom: string): string;
  effacerNom(): string;
  poserRevision(revision: number): string;
  effacerRevision(): string;
  associerVlans(instance: number, vlans: string): string;
  dissocierVlans(instance: number, vlans: string): string;
  retirerInstance(instance: number): string;
  abandonner(): string;
  regionEnService(): string;
  regionEnAttente(): string;
}

const NOM: ArgumentSpec = {
  name: 'nom', type: 'WORD', description: 'MST configuration name',
};

const REVISION: ArgumentSpec = {
  name: 'revision', type: 'INT', range: [0, 65535],
  description: 'Configuration revision number',
};

const INSTANCE: ArgumentSpec = {
  name: 'instance', type: 'INT', range: [0, 4094],
  description: 'MST instance number',
};

const VLANS: ArgumentSpec = {
  name: 'vlans', type: 'REST', literal: 'LINE', restMinWords: 1,
  description: 'VLAN range, example: 10-20,30',
};

export function mstConfigSpecs(ctx: () => MstConfigHost): CommandSpec[] {
  return [
    {
      id: 'mst-name',
      path: ['name', NOM],
      description: 'Set the MST region name',
      undoDescription: 'Clear the MST region name',
      modes: MODE, minPrivilege: 15,
      undoOmitsArguments: true,
      run: (_s, args) => ctx().poserNom(args.nom),
      undo: () => ctx().effacerNom(),
    },
    {
      id: 'mst-revision',
      path: ['revision', REVISION],
      description: 'Set the MST region revision number',
      undoDescription: 'Return the revision number to its default',
      modes: MODE, minPrivilege: 15,
      undoOmitsArguments: true,
      run: (_s, args) => ctx().poserRevision(Number(args.revision)),
      undo: () => ctx().effacerRevision(),
    },
    {
      id: 'mst-instance-vlan',
      path: ['instance', INSTANCE, 'vlan', VLANS],
      description: 'Map VLANs to an MST instance',
      undoDescription: 'Remove VLANs from an MST instance',
      modes: MODE, minPrivilege: 15,
      run: (_s, args) => ctx().associerVlans(Number(args.instance), args.vlans),
      undo: (_s, args) => ctx().dissocierVlans(Number(args.instance), args.vlans),
    },
    {
      id: 'mst-instance-entiere',
      path: ['instance', INSTANCE],
      description: 'Map VLANs to an MST instance',
      undoDescription: 'Return an MST instance to the default mapping',
      modes: MODE, minPrivilege: 15,
      existsOnlyNegated: true,
      run: () => '% Incomplete command.',
      undo: (_s, args) => ctx().retirerInstance(Number(args.instance)),
    },
    {
      id: 'mst-abort',
      path: ['abort'],
      description: 'Leave the MST region sub-mode discarding the changes',
      modes: MODE, minPrivilege: 15,
      run: () => ctx().abandonner(),
    },
    {
      id: 'mst-show-current',
      path: ['show', 'current'],
      description: 'Show the MST region currently in service',
      modes: MODE, minPrivilege: 15,
      run: () => ctx().regionEnService(),
    },
    {
      id: 'mst-show-pending',
      path: ['show', 'pending'],
      description: 'Show the MST region edited but not yet committed',
      modes: MODE, minPrivilege: 15,
      run: () => ctx().regionEnAttente(),
    },
  ];
}

export const MST_CONFIG_LEGENDS: ReadonlyArray<
  readonly [readonly string[], string, readonly string[]]
> = [
  [['show'], 'Show the MST region', [...MODE]],
];
