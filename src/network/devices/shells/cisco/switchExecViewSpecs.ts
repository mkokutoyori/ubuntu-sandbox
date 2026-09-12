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
  etherChannel(words: readonly string[]): string;
  interfacesTrunk(): string;
  interfacesCounters(iface: string | null): string;
  queuingInterface(iface: string): string;
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
const PORT_FACULTATIF: ArgumentSpec = {
  name: 'iface', type: 'INTERFACE', optional: true,
  description: 'Counters of one interface only',
};

const PORT_EXIGE: ArgumentSpec = {
  name: 'iface', type: 'INTERFACE', description: 'Interface to describe',
};

const GROUPE: ArgumentSpec = {
  name: 'groupe', type: 'INT', range: [1, 64], description: 'Channel group number',
};

const VUES_ETHERCHANNEL: ReadonlyArray<readonly [string, string]> = [
  ['detail', 'Detailed EtherChannel state'],
  ['load-balance', 'Load-balancing policy of the channels'],
  ['port-channel', 'Port-channel information'],
  ['summary', 'One-line summary per channel-group'],
];

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
    {
      id: 'show-interfaces-trunk',
      path: ['show', 'interfaces', 'trunk'],
      description: 'Display trunking ports',
      modes: EXEC, minPrivilege: 1,
      run: () => ctx().interfacesTrunk(),
    },
    {
      id: 'show-interfaces-counters',
      path: ['show', 'interfaces', 'counters', PORT_FACULTATIF],
      description: 'Display interface counters',
      modes: EXEC, minPrivilege: 1,
      run: (_session, args) => ctx().interfacesCounters(args.iface || null),
    },
    {
      id: 'show-queuing-interface',
      path: ['show', 'queuing', 'interface', PORT_EXIGE],
      description: 'Display the 802.1p trust state of an interface',
      modes: EXEC, minPrivilege: 1,
      run: (_session, args) => ctx().queuingInterface(args.iface),
    },
    /*
     * Les quatre formes que le gestionnaire HONORE, declarees une par
     * une. Il en reconnaissait quatre et laissait tout le reste tomber
     * dans un `return 'EtherChannel: no detail'` — une phrase qu'aucun
     * IOS ne rend et qui a l'air d'une reponse. `load-balance` etait la
     * quatrieme : honoree par le moteur, annoncee par personne.
     */
    {
      id: 'show-etherchannel',
      path: ['show', 'etherchannel'],
      description: 'Display EtherChannel information',
      modes: EXEC, minPrivilege: 1,
      run: () => ctx().etherChannel([]),
    },
    ...VUES_ETHERCHANNEL.map(([mot, description]): CommandSpec => ({
      id: `show-etherchannel-${mot}`,
      path: ['show', 'etherchannel', mot],
      description,
      modes: EXEC, minPrivilege: 1,
      run: () => ctx().etherChannel([mot]),
    })),
    {
      id: 'show-etherchannel-groupe-port-channel',
      path: ['show', 'etherchannel', GROUPE, 'port-channel'],
      description: 'Port-channel information for one group',
      modes: EXEC, minPrivilege: 1,
      run: (_session, args) => ctx().etherChannel([args.groupe, 'port-channel']),
    },
  ];
}
