import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { CommandSpec } from '@/cli/CommandTable';

export interface SnoopingConfigHost {
  applyIgmp(words: readonly string[], on: boolean): string;
  applyPim(words: readonly string[], on: boolean): string;
}

const CONFIG = Object.freeze(['config']);

export const SNOOPING_QUERY_INTERVAL: readonly [number, number] = [1, 18000];

const VLAN: ArgumentSpec = {
  name: 'vlan', type: 'VLAN_ID', description: 'VLAN the setting applies to',
};

/**
 * L'adresse de source du questionneur, TYPEE.
 *
 * Elle etait validee par `^\d{1,3}(\.\d{1,3}){3}$`, qui accepte
 * `999.999.999.999` — l'exemple que la regle des types de ce depot cite
 * mot pour mot. Le questionneur pose cette adresse dans les requetes
 * qu'il emet : hors domaine, elle designe une source que rien sur le
 * reseau ne peut joindre.
 */
const ADRESSE: ArgumentSpec = {
  name: 'adresse', type: 'IP_ADDR', description: 'Source address of the queries',
};

const INTERVALLE: ArgumentSpec = {
  name: 'secondes', type: 'INT', range: SNOOPING_QUERY_INTERVAL,
  description: 'Seconds between general queries',
};

const PORT_ROUTEUR: ArgumentSpec = {
  name: 'iface', type: 'INTERFACE', description: 'Port towards the multicast router',
};

export function snoopingConfigSpecs(ctx: () => SnoopingConfigHost): CommandSpec[] {
  const igmp = (
    id: string, chemin: CommandSpec['path'],
    description: string, mots: (args: Readonly<Record<string, string>>) => string[],
    sansValeur?: boolean,
  ): CommandSpec => ({
    id, path: chemin, description,
    modes: CONFIG, minPrivilege: 15,
    ...(sansValeur ? { undoOmitsArguments: true } : {}),
    run: (_s, args) => ctx().applyIgmp(mots(args), true),
    undo: (_s, args) => ctx().applyIgmp(mots(args), false),
  });

  const questionneur = (
    prefixe: CommandSpec['path'],
    amont: (args: Readonly<Record<string, string>>) => string[],
    suffixe: string,
  ): CommandSpec[] => [
    igmp(`ip-igmp-snooping${suffixe}-querier`, [...prefixe, 'querier'],
      'Act as the IGMP querier for this domain', (a) => [...amont(a), 'querier']),
    igmp(`ip-igmp-snooping${suffixe}-querier-address`,
      [...prefixe, 'querier', 'address', ADRESSE],
      'Source address of the queries',
      (a) => [...amont(a), 'querier', 'address', a.adresse ?? ''], true),
    igmp(`ip-igmp-snooping${suffixe}-querier-interval`,
      [...prefixe, 'querier', 'query-interval', INTERVALLE],
      'Seconds between general queries',
      (a) => [...amont(a), 'querier', 'query-interval', a.secondes ?? ''], true),
  ];

  return [
    igmp('ip-igmp-snooping', ['ip', 'igmp', 'snooping'],
      'Enable IGMP snooping', () => []),
    ...questionneur(['ip', 'igmp', 'snooping'], () => [], ''),
    igmp('ip-igmp-snooping-vlan', ['ip', 'igmp', 'snooping', 'vlan', VLAN],
      'Enable IGMP snooping on a VLAN', (a) => ['vlan', a.vlan]),
    igmp('ip-igmp-snooping-vlan-immediate-leave',
      ['ip', 'igmp', 'snooping', 'vlan', VLAN, 'immediate-leave'],
      'Leave the group without waiting for the last-member query',
      (a) => ['vlan', a.vlan, 'immediate-leave']),
    /*
     * `mrouter interface <port>` : le mot-cle `interface` est EXIGE,
     * comme sur IOS. Le glouton s'en passait — il cherchait `interface`
     * et, faute de le trouver, prenait le reste de la ligne pour un nom
     * de port — donc `mrouter Fa0/1` passait aussi. Une forme que le
     * constructeur a inventee n'est pas une forme de la commande.
     */
    igmp('ip-igmp-snooping-vlan-mrouter',
      ['ip', 'igmp', 'snooping', 'vlan', VLAN, 'mrouter', 'interface', PORT_ROUTEUR],
      'Static connection to a multicast router',
      (a) => ['vlan', a.vlan, 'mrouter', 'interface', a.iface]),
    ...questionneur(['ip', 'igmp', 'snooping', 'vlan', VLAN],
      (a) => ['vlan', a.vlan], '-vlan'),
    {
      id: 'ip-pim-snooping',
      path: ['ip', 'pim', 'snooping'],
      description: 'Enable PIM snooping',
      modes: CONFIG, minPrivilege: 15,
      run: () => ctx().applyPim([], true),
      undo: () => ctx().applyPim([], false),
    },
    {
      id: 'ip-pim-snooping-vlan',
      path: ['ip', 'pim', 'snooping', 'vlan', VLAN],
      description: 'Enable PIM snooping on a VLAN',
      modes: CONFIG, minPrivilege: 15,
      run: (_s, args) => ctx().applyPim(['vlan', args.vlan], true),
      undo: (_s, args) => ctx().applyPim(['vlan', args.vlan], false),
    },
  ];
}
