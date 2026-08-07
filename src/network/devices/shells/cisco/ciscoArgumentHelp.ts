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
const ENUM = (
  name: string, description: string, values: ReadonlyArray<readonly [string, string]>,
): ParamSpec => ({
  name, type: 'ENUM', description,
  values: values.map(([keyword, d]) => ({ keyword, description: d })),
});

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
  tries.configIf.describeArgs('speed', [ENUM('speed', 'Force speed', [
    ['10', 'Force 10 Mbps operation'],
    ['100', 'Force 100 Mbps operation'],
    ['1000', 'Force 1000 Mbps operation'],
    ['auto', 'Enable AUTO speed configuration'],
  ])]);
  tries.configIf.describeArgs('duplex', [ENUM('duplex', 'Set duplex mode', [
    ['auto', 'Enable AUTO duplex configuration'],
    ['full', 'Force full duplex operation'],
    ['half', 'Force half-duplex operation'],
  ])]);
  tries.configIf.describeArgs('bandwidth', [
    INT('kilobits', [1, 10000000], 'Bandwidth in kilobits'),
  ]);
  tries.configIf.describeArgs('mtu', [
    INT('bytes', [68, 9216], 'MTU size in bytes'),
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
  // `neighbor ?` proposait `activate`, `remote-as`, `weight`… avant
  // l'adresse, parce qu'aucun argument n'était déclaré : les mots-clés
  // extraits du gestionnaire remontaient d'un niveau. Ils sont bien de
  // cette commande, mais ils viennent APRÈS le voisin.
  tries.configRouter.describeArgs('neighbor', [
    IP('address', 'Neighbor address'),
  ]);
  tries.configRouter.describeArgs('default-metric', [
    INT('metric', [1, 16], 'Default metric'),
  ]);
  tries.configRouter.describeArgs('distance', [
    INT('distance', [1, 255], 'Administrative distance'),
  ]);
  tries.configRouter.describeArgs('maximum-paths', [
    INT('paths', [1, 32], 'Number of paths'),
  ]);
  tries.configRouter.describeArgs('redistribute', [
    ENUM('protocol', 'Source protocol to redistribute', [
      ['bgp', 'Border Gateway Protocol (BGP)'],
      ['connected', 'Connected'],
      ['eigrp', 'Enhanced Interior Gateway Routing Protocol (EIGRP)'],
      ['ospf', 'Open Shortest Path First (OSPF)'],
      ['static', 'Static routes'],
    ]),
  ]);
  tries.configRouterOspf.describeArgs('redistribute', [
    ENUM('protocol', 'Source protocol to redistribute', [
      ['bgp', 'Border Gateway Protocol (BGP)'],
      ['connected', 'Connected'],
      ['eigrp', 'Enhanced Interior Gateway Routing Protocol (EIGRP)'],
      ['rip', 'Routing Information Protocol (RIP)'],
      ['static', 'Static routes'],
    ]),
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
  // `encapsulation ?` offrait `isl` (absent d'un ISR G2) et `native`
  // (un mot-clé de `dot1q`, pas un encapsulage).
  tries.configIf.describeArgs('encapsulation', [
    ENUM('type', 'Encapsulation type', [
      ['dot1q', 'IEEE 802.1Q Virtual LAN'],
    ]),
  ]);
  // `eui-64` et `link-local` suivent le préfixe, ils ne le remplacent pas.
  tries.configIf.describeArgs('ipv6 address', [
    { name: 'prefix', type: 'WORD', description: 'IPv6 prefix', literal: 'X:X:X:X::X/<0-128>' },
  ]);
  tries.configIf.describeArgs('rate-limit', [
    ENUM('direction', 'Direction to rate limit', [
      ['input', 'Rate limit incoming traffic'],
      ['output', 'Rate limit outgoing traffic'],
    ]),
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
  tries.config.addCompletionKeywords('logging', [
    { keyword: 'host', description: 'Set syslog server IP address and parameters' },
    { keyword: 'buffered', description: 'Set buffered logging parameters' },
    { keyword: 'console', description: 'Set console logging parameters' },
    { keyword: 'monitor', description: 'Set terminal line (monitor) logging parameters' },
    { keyword: 'on', description: 'Enable logging to all supported destinations' },
    { keyword: 'trap', description: 'Set syslog server logging level' },
  ]);
  // `privilege ?` n'offrait que `level`, un mot-clé qui vient après le
  // mode : `privilege level` seul n'existe pas, IOS demande d'abord de
  // quel mode on parle.
  tries.config.describeArgs('privilege', [
    ENUM('mode', 'Command mode', [
      ['configure', 'Global configuration mode'],
      ['exec', 'Exec mode'],
      ['interface', 'Interface configuration mode'],
      ['line', 'Line configuration mode'],
    ]),
  ]);
  // `aaa authentication ?` retombait sur les mots-clés de la RACINE
  // `aaa` (il proposait `new-model`, `attempts`, `session-id`…), parce
  // que rien ne décrivait ce qui vient après. Chaque niveau porte
  // maintenant ses propres valeurs.
  tries.config.describeArgs('aaa', [
    ENUM('function', 'AAA function', [
      ['accounting', 'Accounting configurations parameters'],
      ['authentication', 'Authentication configurations parameters'],
      ['authorization', 'Authorization configurations parameters'],
      ['group', 'AAA server-group definitions'],
      ['local', 'AAA local authentication parameters'],
      ['new-model', 'Enable NEW access control commands and functions'],
      ['session-id', 'AAA Session ID'],
    ]),
  ]);
  tries.config.describeArgs('aaa authentication', [
    ENUM('service', 'Service to authenticate', [
      ['dot1x', 'Set authentication lists for IEEE 802.1x'],
      ['enable', 'Set authentication list for enable'],
      ['login', 'Set authentication lists for logins'],
      ['ppp', 'Set authentication lists for ppp'],
    ]),
  ]);
  tries.config.describeArgs('aaa authorization', [
    ENUM('service', 'Service to authorize', [
      ['commands', 'For exec (shell) commands'],
      ['config-commands', 'For configuration mode commands'],
      ['exec', 'For starting an exec (shell)'],
      ['network', 'For network services (PPP, SLIP, ARAP)'],
      ['reverse-access', 'For reverse access connections'],
    ]),
  ]);
  tries.config.describeArgs('aaa accounting', [
    ENUM('service', 'Service to account for', [
      ['commands', 'For exec (shell) commands'],
      ['connection', 'For outbound connections'],
      ['exec', 'For starting an exec (shell)'],
      ['network', 'For network services (PPP, SLIP, ARAP)'],
      ['system', 'For system events'],
    ]),
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
  // `transport ?` listait `all`/`none`/`ssh`/`telnet` : ce sont les
  // MÉTHODES, un niveau trop haut. IOS n'offre ici que la direction.
  tries.configLine.describeArgs('transport', [
    ENUM('direction', 'Transport direction', [
      ['input', 'Define which protocols to use when connecting to the terminal server'],
      ['output', 'Define which protocols to use for outgoing connections'],
    ]),
  ]);
  for (const dir of ['input', 'output']) {
    tries.configLine.describeArgs(`transport ${dir}`, [
      ENUM('protocol', 'Transport protocol', [
        ['all', 'All protocols'],
        ['none', 'No protocols'],
        ['ssh', 'TCP/IP SSH protocol'],
        ['telnet', 'TCP/IP Telnet protocol'],
      ]),
    ]);
  }

  tries.privileged.describeArgs('reload', [
    { name: 'when', type: 'STRING', description: 'Reload reason', optional: true,
      literal: 'LINE' },
  ]);
  tries.privileged.addCompletionKeywords('reload', [
    { keyword: 'at', description: 'Reload at a specific time/date' },
    { keyword: 'cancel', description: 'Cancel pending reload' },
    { keyword: 'in', description: 'Reload after a time interval' },
  ]);

  for (const trie of [tries.configStdNacl, tries.configExtNacl]) {
    for (const verbe of ['permit', 'deny']) {
      trie.addCompletionKeywords(verbe, [
        { keyword: 'any', description: 'Any source host' },
        { keyword: 'host', description: 'A single host address' },
      ]);
    }
  }
  for (const verbe of ['permit', 'deny']) {
    for (const proto of ['ip', 'tcp', 'udp', 'icmp']) {
      tries.configExtNacl.describeArgs(`${verbe} ${proto}`, [
        ENUM('source', 'Source address', [
          ['A.B.C.D', 'Source address'],
          ['any', 'Any source host'],
          ['host', 'A single source host'],
          ['object-group', 'Source object group'],
        ]),
      ]);
    }
    tries.configExtNacl.describeArgs(`${verbe} tcp any any eq`, [
      ENUM('port', 'Port number or name', [
        ['<0-65535>', 'Port number'],
        ['domain', 'Domain Name Server (53)'],
        ['ftp', 'File Transfer Protocol (21)'],
        ['telnet', 'Telnet (23)'],
        ['www', 'World Wide Web (HTTP, 80)'],
      ]),
    ]);
  }

  for (const trie of [tries.configStdNacl, tries.configExtNacl]) {
    trie.describeArgs('permit', [
      { name: 'source', type: 'IP_ADDR', description: 'Source address', optional: true },
    ]);
    trie.describeArgs('deny', [
      { name: 'source', type: 'IP_ADDR', description: 'Source address', optional: true },
    ]);
    trie.requireArgs('permit', 1);
    trie.requireArgs('deny', 1);
  }

  tries.config.requireArgs('interface', 1);
  tries.config.requireArgs('ip dhcp pool', 1);
  tries.config.requireArgs('enable secret', 1);
  tries.config.requireArgs('enable password', 1);
  tries.config.requireArgs('access-list', 2);
  tries.config.requireArgs('logging', 1);
  tries.config.requireArgs('ntp', 1);
  tries.config.requireArgs('ip nat', 1);
  tries.config.requireArgs('ip dhcp', 1);
  tries.configIf.requireArgs('encapsulation', 2);
  tries.configLine.requireArgs('transport input', 1);
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
  tries.configIf.describeArgs('channel-group', [
    INT('group', [1, 64], 'Channel group number'),
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
    INT('bytes', [68, 9216], 'MTU size in bytes'),
  ]);

  tries.config.describeArgs('vlan', [
    INT('vlan', [1, 4094], 'ISL VLAN IDs 1-4094'),
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
