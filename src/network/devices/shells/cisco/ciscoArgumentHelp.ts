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
  tries.configRouterOspf.describeArgs('network', [
    IP('network', 'Network number'),
    { ...IP('wildcard', 'OSPF wild card bits'), optional: true },
  ]);

  tries.configIf.describeArgs('ip helper-address', [
    IP('address', 'IP destination address'),
  ]);
  tries.configIf.describeArgs('ip ospf cost', [
    INT('cost', [1, 65535], 'Cost'),
  ]);
  tries.configIf.describeArgs('ip ospf priority', [
    INT('priority', [0, 255], 'Priority'),
  ]);
  tries.configIf.describeArgs('ip ospf hello-interval', [
    INT('seconds', [1, 65535], 'Seconds'),
  ]);
  tries.configIf.describeArgs('ip ospf dead-interval', [
    INT('seconds', [1, 65535], 'Seconds'),
  ]);
  tries.configIf.describeArgs('standby', [
    INT('group', [0, 255], 'Group number'),
  ]);
  tries.configIf.describeArgs('vrrp', [
    INT('group', [1, 255], 'Group number'),
  ]);
  tries.configIf.describeArgs('description', [
    { name: 'text', type: 'STRING', description: 'Up to 240 characters describing this interface' },
  ]);

  tries.config.describeArgs('ip domain-name', [
    { name: 'name', type: 'WORD', description: 'Default domain name', literal: 'WORD' },
  ]);
  tries.config.describeArgs('ip name-server', [
    IP('address', 'Domain server IP address'),
  ]);
  tries.config.describeArgs('logging host', [
    IP('address', 'IP address of the syslog server'),
  ]);
  tries.config.describeArgs('banner motd', [
    { name: 'delimiter', type: 'STRING', description: 'Message text, delimited by a chosen character' },
  ]);

  tries.configLine.describeArgs('exec-timeout', [
    INT('minutes', [0, 35791], 'Timeout in minutes'),
    { name: 'seconds', type: 'INT', description: 'Timeout in seconds', optional: true,
      range: [0, 2147483] },
  ]);
  tries.configLine.describeArgs('password', [
    { name: 'password', type: 'STRING', description: 'The UNENCRYPTED (cleartext) line password' },
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
}

export interface SwitchArgumentHelpTries {
  config: CommandTrie;
  configIf: CommandTrie;
  configLine: CommandTrie;
  configVlan: CommandTrie;
}

export function describeCiscoSwitchArguments(tries: SwitchArgumentHelpTries): void {
  tries.configIf.describeArgs('ip address', [
    IP('address', 'IP address'),
    MASK('IP subnet mask'),
  ]);
  tries.configIf.describeArgs('switchport access vlan', [
    INT('vlan', [1, 4094], 'VLAN of the VLAN interface'),
  ]);
  tries.configIf.describeArgs('switchport trunk native vlan', [
    INT('vlan', [1, 4094], 'Native VLAN of the trunk port'),
  ]);
  tries.configIf.describeArgs('switchport port-security maximum', [
    INT('maximum', [1, 8192], 'Maximum addresses'),
  ]);
  tries.configIf.describeArgs('channel-group', [
    INT('group', [1, 48], 'Channel group number'),
  ]);
  tries.configIf.describeArgs('spanning-tree cost', [
    INT('cost', [1, 200000000], 'Change an interface path cost'),
  ]);
  tries.configIf.describeArgs('spanning-tree port-priority', [
    INT('priority', [0, 240], 'Change an interface priority'),
  ]);
  tries.configIf.describeArgs('description', [
    LINE('text', 'Up to 240 characters describing this interface'),
  ]);
  tries.configIf.describeArgs('mtu', [
    INT('bytes', [1500, 9198], 'MTU size in bytes'),
  ]);

  tries.config.describeArgs('vlan', [
    INT('vlan', [1, 4094], 'ISL VLAN IDs 1-4094'),
  ]);
  tries.config.describeArgs('spanning-tree vlan', [
    INT('vlan', [1, 4094], 'VLAN Switch Spanning Tree'),
  ]);
  tries.config.describeArgs('hostname', [
    WORD('name', 'This system\'s network name'),
  ]);
  tries.config.describeArgs('ip default-gateway', [
    IP('address', 'IP address of default gateway'),
  ]);
  tries.config.describeArgs('ip domain-name', [
    WORD('name', 'Default domain name'),
  ]);
  tries.config.describeArgs('ip name-server', [
    IP('address', 'Domain server IP address'),
  ]);
  tries.config.describeArgs('logging host', [
    IP('address', 'IP address of the syslog server'),
  ]);
  tries.config.describeArgs('ntp server', [
    IP('address', 'IP address of peer'),
  ]);
  tries.config.describeArgs('snmp-server community', [
    WORD('community', 'SNMP community string'),
  ]);

  tries.configVlan.describeArgs('name', [
    WORD('name', 'The ascii name for the VLAN'),
  ]);

  tries.configLine.describeArgs('exec-timeout', [
    INT('minutes', [0, 35791], 'Timeout in minutes'),
    { name: 'seconds', type: 'INT', description: 'Timeout in seconds', optional: true,
      range: [0, 2147483] },
  ]);
  tries.configLine.describeArgs('password', [
    LINE('password', 'The UNENCRYPTED (cleartext) line password'),
  ]);
}
