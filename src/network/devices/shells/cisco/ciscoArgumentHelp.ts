import type { CommandTrie, ParamSpec } from '../CommandTrie';

const IP = (name: string, description: string): ParamSpec =>
  ({ name, type: 'IP_ADDR', description });
const MASK = (description: string): ParamSpec =>
  ({ name: 'mask', type: 'SUBNET_MASK', description });
const INT = (
  name: string, range: readonly [number, number], description: string,
): ParamSpec => ({ name, type: 'INT', description, range });
const WORD = (name: string, description: string): ParamSpec =>
  ({ name, type: 'WORD', description });
const LINE = (name: string, description: string): ParamSpec =>
  ({ name, type: 'STRING', description });

/**
 * Ce que l'aide d'IOS DIT derrière un argument déjà saisi.
 *
 * La marche d'aide de `CommandTrie` sait désormais consommer un argument
 * (`docs/PRD-CLI-Fidelite-IOS.md` §1.1, couche A) ; sans déclaration,
 * elle rend les mots-clés qui peuvent suivre, ce qui est déjà juste mais
 * muet là où IOS annonce un type. Ces déclarations sont la couche B, et
 * elles se posent commande par commande — celles-ci sont les cas relevés
 * par la relecture. Le mécanisme (`describeArgs`) vaut pour toutes les
 * autres, qui restent à déclarer.
 */
export interface ArgumentHelpTries {
  config: CommandTrie;
  configIf: CommandTrie;
  configLine: CommandTrie;
  configDhcp: CommandTrie;
  configRouter: CommandTrie;
  configRouterOspf: CommandTrie;
  configStdNacl: CommandTrie;
  configExtNacl: CommandTrie;
  privileged: CommandTrie;
}

export function describeCiscoArguments(tries: ArgumentHelpTries): void {
  tries.configIf.describeArgs('ip address', [
    IP('address', 'IP address'),
    MASK('IP subnet mask'),
  ]);
  tries.configIf.describeArgs('encapsulation dot1q', [
    INT('vlan', [1, 4094], 'IEEE 802.1Q VLAN ID'),
  ]);
  tries.configIf.describeArgs('speed', [
    { name: 'speed', type: 'WORD', description: 'Force speed (10|100|1000|auto)',
      literal: '10' },
  ]);
  tries.configIf.describeArgs('bandwidth', [
    INT('kilobits', [1, 10000000], 'Bandwidth in kilobits'),
  ]);
  tries.configIf.describeArgs('mtu', [
    INT('bytes', [64, 1500], 'MTU size in bytes'),
  ]);

  tries.config.describeArgs('access-list', [
    INT('number', [1, 2699], 'Access list number'),
  ]);
  tries.config.describeArgs('ip route', [
    IP('prefix', 'Destination prefix'),
    MASK('Destination prefix mask'),
  ]);
  tries.config.describeArgs('ip ssh time-out', [
    INT('seconds', [1, 120], 'SSH time-out interval in seconds'),
  ]);
  tries.config.describeArgs('ntp server', [
    IP('address', 'IP address of peer'),
  ]);
  tries.config.describeArgs('snmp-server community', [
    WORD('community', 'SNMP community string'),
  ]);
  tries.config.describeArgs('ip dhcp excluded-address', [
    IP('low', 'Low IP address'),
    { ...IP('high', 'High IP address'), optional: true },
  ]);
  tries.config.describeArgs('router ospf', [
    INT('process-id', [1, 65535], 'Process ID'),
  ]);
  tries.config.describeArgs('router eigrp', [
    INT('as-number', [1, 65535], 'Autonomous system number'),
  ]);
  tries.config.describeArgs('hostname', [
    WORD('name', 'This system\'s network name'),
  ]);

  tries.configDhcp.describeArgs('network', [
    IP('network', 'Network number'),
    { ...MASK('Network mask'), optional: true },
  ]);
  tries.configDhcp.describeArgs('lease', [
    INT('days', [0, 365], 'Days'),
    { ...INT('hours', [0, 23], 'Hours'), optional: true },
    { ...INT('minutes', [0, 59], 'Minutes'), optional: true },
  ]);
  tries.configDhcp.describeArgs('default-router', [
    IP('address', 'Default router IP address'),
  ]);
  tries.configDhcp.describeArgs('dns-server', [
    IP('address', 'DNS server IP address'),
  ]);

  tries.configRouterOspf.describeArgs('router-id', [
    IP('router-id', 'OSPF router-id in IP address format'),
  ]);
  tries.configRouter.describeArgs('network', [
    IP('network', 'Network number'),
  ]);

  tries.privileged.describeArgs('reload', [
    { name: 'when', type: 'STRING', description: 'Reload reason', optional: true,
      literal: 'LINE' },
  ]);

  for (const trie of [tries.configStdNacl, tries.configExtNacl]) {
    trie.describeArgs('permit', [
      { name: 'source', type: 'IP_ADDR', description: 'Source address', optional: true },
    ]);
    trie.describeArgs('deny', [
      { name: 'source', type: 'IP_ADDR', description: 'Source address', optional: true },
    ]);
  }
  void LINE;
}
