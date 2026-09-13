import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { CommandSpec } from '@/cli/CommandTable';
import { UDLD_MESSAGE_TIME_RANGE } from '../../../udld/types';

export interface SwitchGlobalHost {
  monitorSession(words: readonly string[], negate: boolean): string;
  setUdldGlobalMode(mode: 'normal' | 'aggressive' | 'disabled'): string;
  setUdldHelloInterval(seconds: number): string;
  selectVlanAccessMap(name: string, sequence: string | undefined): string;
  dropVlanAccessMap(name: string, sequence: string | undefined): string;
  applyVlanFilter(name: string, vlans: string): string;
  dropVlanFilter(name: string, vlans: string | undefined): string;
}

const CONFIG = Object.freeze(['config']);

export const ACCESS_MAP_MODE = 'config-access-map';

const SESSION: ArgumentSpec = {
  name: 'session', type: 'INT', range: [1, 66], description: 'SPAN session number',
};

const IFACE: ArgumentSpec = {
  name: 'interface', type: 'INTERFACE', description: 'Interface to mirror',
};

const SENS: ArgumentSpec = {
  name: 'sens', type: 'ENUM', optional: true, description: 'Traffic direction to mirror',
  values: [
    { keyword: 'both', description: 'Mirror received and transmitted traffic' },
    { keyword: 'rx', description: 'Mirror received traffic only' },
    { keyword: 'tx', description: 'Mirror transmitted traffic only' },
  ],
};

const INTERVALLE: ArgumentSpec = {
  name: 'secondes', type: 'INT', range: UDLD_MESSAGE_TIME_RANGE,
  description: 'Interval between UDLD probe messages, in seconds',
};

const NOM_DE_CARTE: ArgumentSpec = {
  name: 'nom', type: 'WORD', description: 'VLAN access map name',
};

const RANG: ArgumentSpec = {
  name: 'rang', type: 'INT', range: [0, 65535], optional: true,
  description: 'Sequence number of this entry',
};

const LISTE_DE_VLAN: ArgumentSpec = {
  name: 'vlans', type: 'WORD', literal: 'WORD',
  pattern: /^\d+(-\d+)?(,\d+(-\d+)?)*$/,
  description: 'VLANs the access map filters',
};

const MODES_UDLD: ReadonlyArray<readonly [string, 'normal' | 'aggressive', string]> = [
  ['aggressive', 'aggressive', 'Enable UDLD in aggressive mode on fibre ports'],
  ['enable', 'normal', 'Enable UDLD in normal mode on fibre ports'],
];

export function switchGlobalSpecs(ctx: () => SwitchGlobalHost): CommandSpec[] {
  const mirroir = (
    verbe: 'source' | 'destination', description: string, places: readonly ArgumentSpec[],
  ): CommandSpec => ({
    id: `monitor-session-${verbe}`,
    path: ['monitor', 'session', SESSION, verbe, 'interface', ...places],
    description,
    modes: CONFIG, minPrivilege: 15,
    run: (_s, args) => ctx().monitorSession(
      [args.session, verbe, 'interface', args.interface,
        ...(args.sens ? [args.sens] : [])], false),
    undo: (_s, args) => ctx().monitorSession(
      [args.session, verbe, 'interface', args.interface], true),
  });

  return [
    mirroir('source', 'Mirror the traffic of an interface', [IFACE, SENS]),
    mirroir('destination', 'Send the mirrored traffic to an interface', [IFACE]),
    {
      id: 'no-monitor-session',
      path: ['monitor', 'session', SESSION],
      description: 'Configure a SPAN session',
      modes: CONFIG, minPrivilege: 15,
      existsOnlyNegated: true,
      run: () => '% Incomplete command.',
      undo: (_s, args) => ctx().monitorSession([args.session], true),
    },
    ...MODES_UDLD.map(([mot, mode, description]): CommandSpec => ({
      id: `udld-${mot}`,
      path: ['udld', mot],
      description,
      modes: CONFIG, minPrivilege: 15,
      run: () => ctx().setUdldGlobalMode(mode),
      undo: () => ctx().setUdldGlobalMode('disabled'),
    })),
    /*
     * `no udld` tout seul eteint UDLD, la ou `udld` tout seul est
     * incomplet : la negation d'une famille n'a pas a redire quel mode
     * on quitte. La forme nue n'existe donc QUE niee.
     */
    {
      id: 'no-udld',
      path: ['udld'],
      description: 'UDLD global configuration',
      modes: CONFIG, minPrivilege: 15,
      existsOnlyNegated: true,
      run: () => '% Incomplete command.',
      undo: () => ctx().setUdldGlobalMode('disabled'),
    },
    {
      id: 'udld-message-time',
      path: ['udld', 'message', 'time', INTERVALLE],
      description: 'Set the message interval',
      modes: CONFIG, minPrivilege: 15,
      undoOmitsArguments: true,
      run: (_s, args) => ctx().setUdldHelloInterval(Number(args.secondes)),
      undo: () => ctx().setUdldHelloInterval(-1),
    },
    {
      id: 'vlan-access-map',
      path: ['vlan', 'access-map', NOM_DE_CARTE, RANG],
      description: 'Configure a VLAN access map',
      modes: CONFIG, minPrivilege: 15,
      enters: ACCESS_MAP_MODE,
      run: (_s, args) => ctx().selectVlanAccessMap(args.nom, args.rang || undefined),
      undo: (_s, args) => ctx().dropVlanAccessMap(args.nom, args.rang || undefined),
    },
    {
      id: 'vlan-filter',
      path: ['vlan', 'filter', NOM_DE_CARTE, 'vlan-list', LISTE_DE_VLAN],
      description: 'Apply a VLAN access map to VLANs',
      modes: CONFIG, minPrivilege: 15,
      run: (_s, args) => ctx().applyVlanFilter(args.nom, args.vlans),
      undo: (_s, args) => ctx().dropVlanFilter(args.nom, args.vlans),
    },
    {
      id: 'no-vlan-filter',
      path: ['vlan', 'filter', NOM_DE_CARTE],
      description: 'Apply a VLAN access map to VLANs',
      modes: CONFIG, minPrivilege: 15,
      existsOnlyNegated: true,
      run: () => '% Incomplete command.',
      undo: (_s, args) => ctx().dropVlanFilter(args.nom, undefined),
    },
  ];
}
