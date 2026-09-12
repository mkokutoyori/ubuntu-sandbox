import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { CommandSpec } from '@/cli/CommandTable';

export interface SnoopingViewHost {
  igmpSnoopingGlobal(vlan?: string): string;
  igmpSnoopingGroups(vlan?: string): string;
  igmpSnoopingMrouter(): string;
  igmpSnoopingQuerier(): string;
  pimSnooping(words: readonly string[]): string;
}

const EXEC = Object.freeze(['user', 'privileged']);

const VLAN: ArgumentSpec = {
  name: 'vlan', type: 'VLAN_ID', description: 'VLAN the view is restricted to',
};

const VLAN_FACULTATIF: ArgumentSpec = { ...VLAN, optional: true };

const VUES_IGMP: ReadonlyArray<readonly [string, string]> = [
  ['mrouter', 'IGMP snooping multicast router ports'],
  ['querier', 'IGMP snooping querier status'],
];

const VUES_PIM: ReadonlyArray<readonly [string, string]> = [
  ['group', 'PIM snooping group state'],
  ['neighbor', 'PIM snooping neighbours'],
];

export function snoopingViewSpecs(ctx: () => SnoopingViewHost): CommandSpec[] {
  const vue = (
    id: string, chemin: CommandSpec['path'], description: string,
    rendu: (args: Readonly<Record<string, string>>) => string,
  ): CommandSpec => ({
    id, path: chemin, description,
    modes: EXEC, minPrivilege: 1,
    run: (_session, args) => rendu(args),
  });

  return [
    vue('show-ip-igmp-snooping', ['show', 'ip', 'igmp', 'snooping'],
      'Display IGMP snooping state', () => ctx().igmpSnoopingGlobal()),
    /*
     * `vlan` sans numero rend la vue globale, comme le gestionnaire l'a
     * toujours fait — d'ou la place FACULTATIVE. Elle est TYPEE, ce que
     * le glouton ne pouvait pas etre : `vlan 5000` est refuse a la place
     * ou l'operateur s'est trompe, et non au fond du rendu.
     */
    vue('show-ip-igmp-snooping-vlan', ['show', 'ip', 'igmp', 'snooping', 'vlan',
      VLAN_FACULTATIF], 'IGMP snooping information for a VLAN',
    (args) => ctx().igmpSnoopingGlobal(args.vlan || undefined)),
    vue('show-ip-igmp-snooping-groups', ['show', 'ip', 'igmp', 'snooping', 'groups'],
      'IGMP snooping multicast group information', () => ctx().igmpSnoopingGroups()),
    vue('show-ip-igmp-snooping-groups-vlan',
      ['show', 'ip', 'igmp', 'snooping', 'groups', 'vlan', VLAN],
      'Groups of one VLAN', (args) => ctx().igmpSnoopingGroups(args.vlan)),
    ...VUES_IGMP.map(([mot, description]) =>
      vue(`show-ip-igmp-snooping-${mot}`, ['show', 'ip', 'igmp', 'snooping', mot],
        description,
        () => mot === 'mrouter' ? ctx().igmpSnoopingMrouter() : ctx().igmpSnoopingQuerier())),
    vue('show-ip-pim-snooping', ['show', 'ip', 'pim', 'snooping'],
      'Display PIM snooping state', () => ctx().pimSnooping([])),
    ...VUES_PIM.map(([mot, description]) =>
      vue(`show-ip-pim-snooping-${mot}`, ['show', 'ip', 'pim', 'snooping', mot],
        description, () => ctx().pimSnooping([mot]))),
  ];
}
