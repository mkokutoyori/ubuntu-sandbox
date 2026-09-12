import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { CommandSpec } from '@/cli/CommandTable';
import { STORM_CONTROL_TYPES } from './stormControlSyntax';

export interface SwitchExecViewHost {
  ipTraffic(): string;
  dhcpStatistics(): string;
  dhcpLease(): string;
  dhcpDatabase(): string;
  dhcpSnoopingStatistics(): string;
  stormControl(type: string | null): string;
}

const EXEC = Object.freeze(['user', 'privileged']);

/**
 * Le filtre de `show storm-control`, declare plutot que subi.
 *
 * Le glouton faisait `types.includes(filtre) ? [filtre] : types` : un
 * mot inconnu ne restreignait rien et la vue rendait les TROIS sortes.
 * Une vue dont le filtre est ignore montre plus que ce qu'on lui a
 * demande, ce qui est le defaut de la lecture correspondant au critere
 * range sans etre evalue.
 *
 * Les trois sortes sont celles que `stormControlSyntax` fait deja
 * autorite pour la configuration : une seule liste pour la pose et pour
 * la vue.
 */
const SORTE_DE_TEMPETE: ArgumentSpec = {
  name: 'sorte', type: 'ENUM', optional: true,
  description: 'Traffic type the view is restricted to',
  values: STORM_CONTROL_TYPES.map((mot) => ({
    keyword: mot, description: `${mot[0].toUpperCase()}${mot.slice(1)} storm control`,
  })),
};

type VueSansArgument = {
  [K in keyof SwitchExecViewHost]: SwitchExecViewHost[K] extends () => string ? K : never
}[keyof SwitchExecViewHost];

type Vue = readonly [string, readonly string[], string, VueSansArgument];

const VUES: readonly Vue[] = [
  ['show-ip-traffic', ['show', 'ip', 'traffic'],
    'IP traffic statistics', 'ipTraffic'],
  ['show-ip-dhcp-statistics', ['show', 'ip', 'dhcp', 'statistics'],
    'Display DHCP server statistics', 'dhcpStatistics'],
  ['show-ip-dhcp-lease', ['show', 'ip', 'dhcp', 'lease'],
    'Display DHCP client leases', 'dhcpLease'],
  ['show-ip-dhcp-database', ['show', 'ip', 'dhcp', 'database'],
    'Display DHCP database agents', 'dhcpDatabase'],
  ['show-ip-dhcp-snooping-statistics', ['show', 'ip', 'dhcp', 'snooping', 'statistics'],
    'Display DHCP snooping statistics', 'dhcpSnoopingStatistics'],
];

export function switchExecViewSpecs(ctx: () => SwitchExecViewHost): CommandSpec[] {
  return [
    ...VUES.map(([id, chemin, description, rendu]): CommandSpec => ({
      id,
      path: [...chemin],
      description,
      modes: EXEC, minPrivilege: 1,
      run: () => ctx()[rendu](),
    })),
    {
      id: 'show-storm-control',
      path: ['show', 'storm-control', SORTE_DE_TEMPETE],
      description: 'Display storm-control settings',
      modes: EXEC, minPrivilege: 1,
      run: (_session, args) => ctx().stormControl(args.sorte || null),
    },
  ];
}
