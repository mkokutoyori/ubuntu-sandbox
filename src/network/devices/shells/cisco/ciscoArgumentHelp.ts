import type { CommandTrie, ParamSpec } from '../CommandTrie';
import { estTypeSansNumero } from './CiscoConfigCommands';

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

const IFACE = (description: string): ParamSpec =>
  ({ name: 'interface', type: 'INTERFACE', description });
const MAC = (description: string): ParamSpec =>
  ({ name: 'mac', type: 'MAC_ADDR', description });

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
  configRouteMap: CommandTrie;
  configTimeRange: CommandTrie;
  configTrack: CommandTrie;
  configRouterOnly: CommandTrie;
}

/**
 * IOS ne nomme pas ses arguments, il les TYPE. Un nœud greedy sans
 * spécification retombait sur un `WORD` de dernier recours PORTANT LA
 * DESCRIPTION DU PARENT — `cdp timer ?` répondait
 * `WORD  Advertisement period (sec)` là où IOS répond `<5-254>  Rate at
 * which CDP packets are sent (in sec)`. La différence n'est pas
 * cosmétique : le premier n'apprend pas les bornes, et laisse croire
 * qu'un nom conviendrait.
 *
 * Trois traitements, un par situation :
 *
 * 1. la commande prend un argument ⇒ il est TYPÉ et décrit
 *    (`describeArgs`) ;
 * 2. la commande n'en prend aucun ⇒ le `WORD` disparaît
 *    (`takesNoArgument`), et `?` n'offre plus que `<cr>` ;
 * 3. l'argument EST un nom libre ⇒ il reste `WORD`, mais avec sa
 *    propre description au lieu de celle du parent.
 */
function describeArgumentTypes(tries: ArgumentHelpTries): void {
  // ── Commandes sans argument : le `WORD` était une invention ──
  for (const path of [
    'cdp run', 'ip cef', 'ip multicast-routing', 'ip source-route',
    'lldp run', 'service password-encryption', 'sntp unicast',
  ]) tries.config.takesNoArgument(path);
  for (const path of ['fair-queue']) tries.configIf.takesNoArgument(path);

  // ── EXEC privilégié ──
  tries.privileged.describeArgs('clear counters', [
    { ...IFACE('Clear counters on this interface'), optional: true },
  ]);
  tries.privileged.describeArgs('clock set', [
    { name: 'time', type: 'WORD', description: 'Current time', literal: 'hh:mm:ss' },
  ]);
  tries.privileged.describeArgs('delete', [WORD('file', 'File to be deleted')]);
  tries.privileged.describeArgs('dir', [
    { ...WORD('filesystem', 'Filesystem or directory to list'), optional: true },
  ]);
  tries.privileged.describeArgs('more', [WORD('file', 'File to display')]);
  tries.privileged.describeArgs('verify', [WORD('file', 'File to verify')]);
  tries.privileged.describeArgs('mkdir', [WORD('directory', 'Directory to create')]);
  tries.privileged.describeArgs('rmdir', [WORD('directory', 'Directory to remove')]);
  tries.privileged.describeArgs('squeeze', [WORD('filesystem', 'Filesystem to squeeze')]);
  tries.privileged.describeArgs('configure replace', [
    WORD('url', 'Configuration file URL'),
  ]);
  tries.privileged.describeArgs('disconnect', [
    { ...INT('connection', [1, 16], 'Connection number'), optional: true },
  ]);
  tries.privileged.describeArgs('resume', [
    { ...INT('connection', [1, 16], 'Connection number'), optional: true },
  ]);
  for (const cmd of ['ping', 'traceroute']) {
    tries.privileged.describeArgs(cmd, [
      { name: 'destination', type: 'WORD', description: 'Destination address or hostname',
        literal: 'A.B.C.D', optional: true },
    ]);
  }
  for (const cmd of ['ssh', 'telnet']) {
    tries.privileged.describeArgs(cmd, [
      { name: 'host', type: 'WORD', description: 'IP address or hostname of a remote system',
        literal: 'A.B.C.D' },
    ]);
  }
  for (const [cmd, description] of [
    ['show access-lists', 'Access list name or number'],
    ['show class-map', 'Class map name'],
    ['show route-map', 'Route map name'],
    ['show time-range', 'Time range name'],
  ] as const) {
    tries.privileged.describeArgs(cmd, [{ ...WORD('name', description), optional: true }]);
  }
  tries.privileged.describeArgs('show ip eigrp topology', [
    { ...ENUM('scope', 'Topology detail to display', [
      ['all-links', 'Show all links in topology table'],
    ]), optional: true },
  ]);
  tries.privileged.describeArgs('show ip eigrp neighbors', [
    { ...ENUM('detail', 'Neighbour detail to display', [
      ['detail', 'Show detailed peer information'],
    ]), optional: true },
  ]);
  tries.privileged.describeArgs('show ip eigrp interfaces', [
    { ...ENUM('detail', 'Interface detail to display', [
      ['detail', 'Show detailed interface information'],
    ]), optional: true },
  ]);
  tries.privileged.describeArgs('clear ip eigrp', [
    { ...ENUM('target', 'What to clear', [
      ['neighbors', 'Clear EIGRP neighbour adjacencies'],
      ['traffic', 'Clear EIGRP traffic statistics'],
    ]), optional: true },
  ]);
  tries.privileged.describeArgs('show arp', [
    { ...IP('address', 'ARP entry address'), optional: true },
  ]);
  tries.privileged.describeArgs('show adjacency', [
    { ...IFACE('Adjacencies on this interface'), optional: true },
  ]);
  tries.privileged.describeArgs('show line', [
    { ...INT('line', [0, 16], 'Line number'), optional: true },
  ]);
  tries.privileged.describeArgs('show controllers', [
    { ...IFACE('Controller of this interface'), optional: true },
  ]);
  for (const path of [
    'show boot', 'show buffers', 'show environment', 'show hosts', 'show memory',
    'show reload', 'show sockets', 'show ssh', 'show stacks', 'show terminal',
    'show bgp', 'show flash:',
  ]) tries.privileged.takesNoArgument(path);
  for (const [famille, description] of [
    ['debug cdp', 'CDP event to debug'],
    ['debug eigrp', 'EIGRP event to debug'],
    ['debug glbp', 'GLBP event to debug'],
    ['debug lldp', 'LLDP event to debug'],
    ['debug radius', 'RADIUS event to debug'],
    ['debug standby', 'HSRP event to debug'],
    ['debug tacacs', 'TACACS+ event to debug'],
    ['debug vrrp', 'VRRP event to debug'],
  ] as const) {
    tries.privileged.describeArgs(famille, [{ ...WORD('event', description), optional: true }]);
  }
  tries.privileged.describeArgs('debug interface', [
    { ...IFACE('Interface to debug'), optional: true },
  ]);

  // ── Configuration globale ──
  tries.config.describeArgs('alias', [
    ENUM('mode', 'Command mode of the alias', [
      ['configure', 'Global configuration mode'],
      ['exec', 'Exec mode'],
      ['interface', 'Interface configuration mode'],
      ['router', 'Router configuration mode'],
    ]),
    WORD('alias', 'Alias name'),
    LINE('command', 'Command the alias stands for'),
  ]);
  for (const mode of ['configure', 'exec', 'interface', 'router']) {
    tries.config.describeArgs(`alias ${mode}`, [
      WORD('alias', 'Alias name'),
      LINE('command', 'Command the alias stands for'),
    ]);
  }
  tries.config.describeArgs('clock set', [
    { name: 'time', type: 'WORD', description: 'Current time', literal: 'hh:mm:ss' },
  ]);
  tries.configIf.describeArgs('interface', [IFACE('Interface to configure')]);
  tries.config.describeArgs('no alias', [
    ENUM('mode', 'Command mode of the alias', [
      ['configure', 'Global configuration mode'],
      ['exec', 'Exec mode'],
      ['interface', 'Interface configuration mode'],
      ['router', 'Router configuration mode'],
    ]),
  ]);
  tries.config.describeArgs('arp', [IP('address', 'IP address of ARP entry'), MAC('48-bit hardware address')]);
  tries.config.describeArgs('no arp', [IP('address', 'IP address of ARP entry')]);
  tries.config.describeArgs('boot system', [WORD('image', 'System image file name')]);
  tries.config.describeArgs('cdp holdtime', [
    INT('seconds', [10, 255], 'Length of time receiver must keep this packet'),
  ]);
  tries.config.describeArgs('cdp timer', [
    INT('seconds', [5, 254], 'Rate at which CDP packets are sent'),
  ]);
  tries.config.describeArgs('lldp holdtime', [
    INT('seconds', [0, 65535], 'Length of time receiver must keep this packet'),
  ]);
  tries.config.describeArgs('lldp timer', [
    INT('seconds', [5, 65534], 'Rate at which LLDP packets are sent'),
  ]);
  tries.config.describeArgs('lldp reinit', [
    INT('seconds', [2, 5], 'Delay before re-initialisation'),
  ]);
  tries.config.describeArgs('lldp holdtime-multiplier', [
    INT('multiplier', [2, 10], 'TTL multiplier applied to the timer'),
  ]);
  tries.config.describeArgs('clock timezone', [
    WORD('zone', 'Name of time zone'),
    INT('offset', [-23, 23], 'Hours offset from UTC'),
  ]);
  tries.config.describeArgs('config-register', [
    { name: 'value', type: 'WORD', description: 'Configuration register value', literal: '0x0-0xFFFF' },
  ]);
  tries.config.describeArgs('ip default-network', [IP('network', 'Default network number')]);
  tries.config.describeArgs('ip host', [WORD('name', 'Name of host'), IP('address', 'Host IP address')]);
  tries.config.describeArgs('login delay', [
    INT('seconds', [1, 65535], 'Delay between successive login attempts'),
  ]);
  tries.config.describeArgs('no access-list', [
    INT('number', [1, 2699], 'Access list number'),
  ]);
  tries.config.describeArgs('no interface', [IFACE('Interface to remove')]);
  tries.config.describeArgs('logging source-interface', [
    IFACE('Interface used as the source address of syslog messages'),
  ]);
  tries.config.describeArgs('ipv6 route', [
    { name: 'prefix', type: 'WORD', description: 'IPv6 prefix', literal: 'X:X:X:X::X/<0-128>' },
  ]);
  // La forme nue est acceptée sur IOS et vaut `debug uptime` : le canal
  // est donc OPTIONNEL, sans quoi une commande valide serait refusée.
  tries.config.describeArgs('service timestamps', [
    { name: 'channel', type: 'ENUM', description: 'Message class to timestamp', optional: true,
      values: [
        { keyword: 'debug', description: 'Timestamp debug messages' },
        { keyword: 'log', description: 'Timestamp log messages' },
      ] },
  ]);
  // Les NOMS restent des `WORD`, mais avec leur propre description.
  tries.config.describeArgs('username', [WORD('name', 'Name of the local user')]);
  tries.config.describeArgs('ip domain-list', [WORD('name', 'Domain name to append to the list')]);
  tries.privileged.describeArgs('clear host', [WORD('name', 'Host entry to delete')]);

  for (const [path, description] of [
    ['flow exporter', 'Name of the Flexible NetFlow exporter'],
    ['flow monitor', 'Name of the Flexible NetFlow monitor'],
    ['flow record', 'Name of the Flexible NetFlow record'],
    ['ip prefix-list', 'Name of a prefix list'],
    ['ip vrf', 'VRF name'],
    ['ipv6 access-list', 'Name of the IPv6 access list'],
    ['ipv6 prefix-list', 'Name of an IPv6 prefix list'],
    ['key chain', 'Name of the key chain'],
    ['time-range', 'Name of the time range'],
    ['zone security', 'Name of the security zone'],
    ['no route-map', 'Name of the route map'],
    ['no username', 'Name of the local user'],
  ] as const) {
    tries.config.describeArgs(path, [WORD('name', description)]);
  }
  for (const [path, description] of [
    ['crypto dynamic-map', 'Name of the dynamic crypto map'],
    ['crypto keyring', 'Name of the ISAKMP keyring'],
    ['vrf definition', 'VRF name'],
  ] as const) {
    tries.configRouterOnly.describeArgs(path, [WORD('name', description)]);
  }
  tries.config.describeArgs('router bgp', [
    INT('as-number', [1, 65535], 'Autonomous system number'),
  ]);
  tries.config.describeArgs('track', [
    INT('object', [1, 1000], 'Tracked object number'),
  ]);
  tries.config.describeArgs('no track', [
    INT('object', [1, 1000], 'Tracked object number'),
  ]);
  for (const [path, description] of [
    ['priority-list', 'Priority list number'],
    ['queue-list', 'Custom queue list number'],
  ] as const) {
    tries.config.describeArgs(path, [INT('list', [1, 16], description)]);
  }

  // ── Configuration d'interface ──
  tries.configIf.describeArgs('arp timeout', [
    INT('seconds', [0, 2147483], 'Seconds an ARP cache entry stays valid'),
  ]);
  tries.configIf.describeArgs('delay', [
    INT('tens-of-microseconds', [1, 16777215], 'Throughput delay, in tens of microseconds'),
  ]);
  tries.configIf.describeArgs('keepalive', [
    INT('seconds', [0, 32767], 'Keepalive period'),
  ]);
  tries.configIf.describeArgs('load-interval', [
    INT('seconds', [30, 600], 'Load calculation interval, in multiples of 30'),
  ]);
  tries.configIf.describeArgs('ip mtu', [INT('bytes', [68, 9216], 'IP MTU, in bytes')]);
  tries.configIf.describeArgs('max-reserved-bandwidth', [
    INT('percent', [1, 100], 'Percent of interface bandwidth reservable'),
  ]);
  tries.configIf.describeArgs('tx-ring-limit', [
    INT('packets', [1, 32767], 'Transmit ring size, in packets'),
  ]);
  tries.configIf.describeArgs('tunnel key', [
    INT('key', [0, 4294967295], 'Tunnel identification key'),
  ]);
  tries.configIf.describeArgs('tunnel destination', [IP('address', 'Destination address of the tunnel')]);
  tries.configIf.describeArgs('tunnel source', [IFACE('Interface used as the tunnel source')]);
  tries.configIf.describeArgs('ip unnumbered', [IFACE('Interface whose address is borrowed')]);
  tries.configIf.describeArgs('tunnel mode', [
    ENUM('mode', 'Tunnel encapsulation mode', [
      ['gre', 'Generic Route Encapsulation'],
      ['ipip', 'IP over IP encapsulation'],
      ['ipsec', 'IPSec tunnel encapsulation'],
    ]),
  ]);
  tries.configIf.describeArgs('tunnel vrf', [WORD('name', 'VRF used to reach the tunnel destination')]);
  tries.configIf.describeArgs('crypto map', [WORD('name', 'Name of the crypto map')]);
  tries.configIf.describeArgs('zone-member security', [WORD('zone', 'Name of the security zone')]);
  tries.configIf.describeArgs('custom-queue-list', [INT('list', [1, 16], 'Custom queue list number')]);
  tries.configIf.describeArgs('priority-group', [INT('group', [1, 16], 'Priority group number')]);
  tries.configIf.describeArgs('bfd interval', [
    INT('milliseconds', [50, 9999], 'Transmit interval, in milliseconds'),
  ]);
  tries.configIf.describeArgs('bfd neighbor', [IP('address', 'Address of the BFD neighbor')]);
  tries.configIf.describeArgs('ipv6 eigrp', [INT('as-number', [1, 65535], 'Autonomous system number')]);
  for (const [path, kind] of [
    ['glbp', 'GLBP'], ['no glbp', 'GLBP'],
    ['no standby', 'HSRP'], ['no vrrp', 'VRRP'],
  ] as const) {
    tries.configIf.describeArgs(path, [INT('group', [0, 255], `${kind} group number`)]);
  }
  tries.configIf.takesNoArgument('no rate-limit');

  // ── route-map, time-range, track : la priorité pédagogique ──
  tries.configRouteMap.describeArgs('description', [
    LINE('text', 'Up to 100 characters describing this route-map'),
  ]);
  for (const path of ['match', 'no match']) {
    tries.configRouteMap.describeArgs(path, [
      ENUM('criterion', 'Match values from routing table', [
        ['as-path', 'Match BGP AS path list'],
        ['community', 'Match BGP community list'],
        ['interface', 'Match first hop interface of route'],
        ['ip', 'IP specific information'],
        ['length', 'Packet length'],
        ['metric', 'Match metric of route'],
        ['tag', 'Match tag of route'],
      ]),
    ]);
  }
  for (const path of ['set', 'no set']) {
    tries.configRouteMap.describeArgs(path, [
      ENUM('action', 'Set values in destination routing protocol', [
        ['as-path', 'Prepend string for a BGP AS-path attribute'],
        ['community', 'BGP community attribute'],
        ['interface', 'Output interface'],
        ['ip', 'IP specific information'],
        ['local-preference', 'BGP local preference path attribute'],
        ['metric', 'Metric value for destination routing protocol'],
        ['metric-type', 'Type of metric for destination routing protocol'],
        ['origin', 'BGP origin code'],
        ['tag', 'Tag value for destination routing protocol'],
        ['weight', 'BGP weight for routing table'],
      ]),
    ]);
  }
  tries.configTimeRange.describeArgs('absolute', [
    ENUM('bound', 'Bound of the absolute range', [
      ['end', 'Ending time and date'],
      ['start', 'Starting time and date'],
    ]),
  ]);
  tries.configTrack.describeArgs('track', [INT('object', [1, 1000], 'Tracked object number')]);
  tries.configTrack.describeArgs('no delay', [
    ENUM('transition', 'State transition whose delay is removed', [
      ['down', 'Delay before reporting the object down'],
      ['up', 'Delay before reporting the object up'],
    ]),
  ]);
  tries.configTrack.describeArgs('no object', [
    INT('object', [1, 1000], 'Object number to remove from the list'),
  ]);

  // ── DHCP ──

  // ── Listes d'accès nommées ──
  for (const trie of [tries.configStdNacl, tries.configExtNacl]) {
    trie.describeArgs('remark', [LINE('text', 'Comment up to 100 characters')]);
    trie.describeArgs('no', [INT('sequence', [1, 2147483647], 'Sequence number of the entry to remove')]);
  }
  tries.configExtNacl.describeArgs('evaluate', [WORD('name', 'Name of the reflexive access list')]);

  // ── Modes routeur ──
  // `timers bgp` n'appartient qu'à BGP, et ce mode partage un seul arbre
  // avec RIP : le proposer partout revenait à offrir sous `router rip` un
  // mot que la même machine refuse ensuite.
  tries.configRouter.describeArgs('timers', [
    ENUM('family', 'Timer family to adjust', [
      ['basic', 'Basic routing timers'],
    ]),
  ]);
  tries.configRouter.describeArgs('router-id', [IP('router-id', 'Router identifier in IP address format')]);
  tries.configRouter.describeArgs('aggregate-address', [
    IP('address', 'Aggregate prefix'),
    MASK('Aggregate mask'),
  ]);
  tries.configRouter.describeArgs('address-family', [
    ENUM('family', 'Address family', [
      ['ipv4', 'Address family IPv4'],
      ['ipv6', 'Address family IPv6'],
      ['vpnv4', 'Address family VPNv4'],
    ]),
  ]);
  for (const path of ['default-information', 'no default-information']) {
    tries.configRouter.describeArgs(path, [
      ENUM('control', 'Default route control', [
        ['originate', 'Distribute a default route'],
      ]),
    ]);
  }
  tries.configRouter.describeArgs('offset-list', [
    INT('access-list', [0, 99], 'Access list of networks to apply the offset to'),
  ]);
  tries.configRouter.describeArgs('output-delay', [
    INT('milliseconds', [8, 50], 'Interpacket delay for RIP updates'),
  ]);
  tries.configRouter.describeArgs('flash-update-threshold', [
    INT('seconds', [0, 30], 'Suppress a flash update within this many seconds of a regular update'),
  ]);
  for (const path of ['validate-update-source', 'no validate-update-source']) {
    tries.configRouter.takesNoArgument(path);
  }
  tries.configRouter.describeArgs('distribute-list', [
    ENUM('filter', 'Filter to apply', [
      ['gateway', 'Filtering incoming updates based on gateway'],
      ['prefix', 'Filter prefixes in routing updates'],
    ]),
  ]);
  // ── `<cr>` ne s'annonce que si la commande se valide vraiment ──
  //
  // `<cr>` promet une chose et une seule : vous pouvez valider ici.
  // Il s'affiche des qu'un noeud porte une action et que son ARITE
  // MINIMALE vaut zero — et `requiredArity` la deduit des parametres
  // declares non optionnels, dont ces noeuds-la n'ont aucun. La machine
  // annoncait donc qu'on pouvait valider une commande a laquelle il
  // manque un mot, et la validation repondait `% Incomplete command.`
  //
  // La liste vient d'un balayage de l'arbre d'aide
  // (`probe-aide-cr-tient-sa-promesse.test.ts`), pas d'une inspection a
  // l'oeil : c'est lui qui les a nommees, et lui qui nommera la suivante.
  for (const chemin of [
    'class-map', 'class-map match-all', 'class-map match-any',
    'clock', 'crypto map', 'ip community-list', 'ip sla',
    'no logging', 'policy-map',
    'privilege configure', 'privilege exec', 'privilege interface', 'privilege line',
    'route-map', 'sntp server', 'zone-pair security',
  ]) tries.config.requireArgs(chemin, 1);
  for (const chemin of [
    'ip access-group', 'ip ospf',
    'rate-limit input', 'rate-limit output',
  ]) tries.configIf.requireArgs(chemin, 1);
  for (const chemin of ['show logging last', 'show running-config interface']) {
    tries.privileged.requireArgs(chemin, 1);
  }
  // Ces chemins-la existent et fonctionnent : seule leur ARITE manquait,
  // si bien qu'ils annoncaient `<cr>` et refusaient ensuite au caret le
  // mot qui manquait. Trouves par le balayage des promesses non tenues.
  tries.privileged.requireArgs('copy', 2);
  tries.privileged.requireArgs('terminal', 1);
  // `enable algorithm-type ?` rendait `level` et `secret` — les mots du
  // rang SUIVANT — alors qu'IOS y attend l'algorithme. Meme faute que
  // `ip access-group`, meme remede : declarer le rang.
  tries.config.describeArgs('enable algorithm-type', [
    ENUM('algorithm', 'Algorithm to hash the secret with', [
      ['md5', 'Select MD5 as the hashing algorithm'],
      ['scrypt', 'Select scrypt as the hashing algorithm'],
      ['sha256', 'Select PBKDF2 with SHA256 as the hashing algorithm'],
    ]),
    ENUM('kind', 'What to set', [['secret', 'Assign the privileged level secret']]),
    LINE('secret', 'The UNENCRYPTED (cleartext) enable secret'),
  ]);
  tries.config.requireArgs('enable algorithm-type', 3);
  tries.config.requireArgs('ip scp', 2);
  tries.config.requireArgs('no ip scp', 2);
  tries.config.requireArgs('no line', 2);
  tries.privileged.requireArgs('send', 1);
  tries.configIf.requireArgs('ip rip', 1);
  tries.configIf.requireArgs('ip rip authentication', 2);
  // Quand le mot suivant est ABSORBE par un noeud glouton, l'arite seule
  // ne suffit pas : c'est le meme nombre d'arguments qui, selon leur
  // contenu, complete la commande ou non. `privilege exec` en porte
  // trois au minimum (le mode, le verbe, la commande visee), et
  // `rate-limit input` attend encore son debit.
  tries.config.requireArgs('privilege', 3);
  tries.configIf.requireArgs('rate-limit', 2);
  // `class-map NOM` se valide ; `class-map match-all` attend son nom.
  // Un seul argument dans les deux cas — seul son contenu les separe.
  tries.config.executableWhen('class-map',
    (args) => !(args.length === 1 && /^match-(all|any)$/i.test(args[0])));

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
    ENUM('action', 'Specify packets to forward or reject', [
      ['deny', 'Specify packets to reject'],
      ['permit', 'Specify packets to forward'],
    ]),
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
  tries.config.describeArgs('ntp peer', [
    IP('address', 'IP address of peer'),
  ]);
  // Les arguments de `ntp` portaient la description de LEUR PARENT :
  // `ntp access-group ?` repondait « WORD  Control NTP access » au lieu
  // de nommer les quatre familles qu'IOS accepte. Chacun decrit
  // desormais ce qu'il attend vraiment.
  tries.config.describeArgs('ntp access-group', [
    { name: 'kind', type: 'ENUM', description: 'Access control type',
      values: [
        { keyword: 'peer', description: 'Provide full access' },
        { keyword: 'serve', description: 'Provide server and query access' },
        { keyword: 'serve-only', description: 'Provide only server access' },
        { keyword: 'query-only', description: 'Allow only control queries' },
      ] },
    INT('access-list', [1, 199], 'Access list number'),
  ]);
  tries.config.describeArgs('ntp master', [
    { ...INT('stratum', [1, 15], 'Stratum number'), optional: true },
  ]);
  tries.config.describeArgs('ntp authentication-key', [
    INT('number', [1, 4294967295], 'Key number'),
    { name: 'algo', type: 'ENUM', description: 'Authentication type',
      values: [{ keyword: 'md5', description: 'MD5 authentication' }] },
    WORD('key', 'Authentication key'),
  ]);
  tries.config.describeArgs('ntp allow', [
    { name: 'mode', type: 'ENUM', description: 'Allow processing of packet modes',
      values: [{ keyword: 'mode', description: 'Allow processing of control mode packets' }] },
    { name: 'control', type: 'ENUM', description: 'Control mode packets',
      values: [{ keyword: 'control', description: 'Allow processing of control mode packets' }] },
  ]);
  tries.config.describeArgs('ntp trusted-key', [
    INT('number', [1, 4294967295], 'Key number'),
  ]);
  tries.config.describeArgs('ntp source', [
    WORD('interface', 'Interface to use for source address'),
  ]);
  tries.config.describeArgs('snmp-server community', [
    WORD('community', 'SNMP community string'),
    { name: 'access', type: 'ENUM', description: 'Access privileges', optional: true,
      values: [
        { keyword: 'ro', description: 'Read-only access with this community string' },
        { keyword: 'rw', description: 'Read-write access with this community string' },
      ] },
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


  tries.configRouter.describeArgs('network', [
    IP('network', 'Network number'),
  ]);
  tries.configRouter.describeArgs('no network', [
    IP('network', 'Network number'),
  ]);
  tries.configRouter.describeArgs('no timers', [
    ENUM('family', 'Timer family to restore', [['basic', 'Basic routing timers']]),
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
  tries.configRouter.describeArgs('no distance', [
    INT('distance', [1, 255], 'Administrative distance'),
  ]);
  tries.configRouter.describeArgs('no maximum-paths', [
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
  const MODE_DE_PRIVILEGE = () => ENUM('mode', 'Command mode', [
    ['configure', 'Global configuration mode'],
    ['exec', 'Exec mode'],
    ['interface', 'Interface configuration mode'],
    ['line', 'Line configuration mode'],
  ]);
  tries.config.describeArgs('privilege', [MODE_DE_PRIVILEGE()]);
  // La forme qui RETIRE prend le meme argument que celle qui pose : sans
  // sa propre description, `no privilege ?` recopiait celle de son
  // parent, c'est-a-dire la phrase qui decrit la commande entiere la ou
  // IOS nomme ce qu'il attend.
  tries.config.describeArgs('no privilege', [MODE_DE_PRIVILEGE()]);
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
  tries.config.describeArgs('no aaa', [
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
  // Les QUATRE bannieres d'IOS, pas seulement `motd` : `banner ?` n'en
  // proposait qu'une, donc les trois autres etaient acceptees, rendues
  // dans la configuration, et introuvables par l'aide.
  tries.config.describeArgs('banner', [
    ENUM('type', 'Type of banner', [
      ['exec', 'Set EXEC process creation banner'],
      ['incoming', 'Set incoming terminal line banner'],
      ['login', 'Set login banner'],
      ['motd', 'Set Message of the Day banner'],
    ]),
  ]);
  for (const genre of ['motd', 'login', 'exec', 'incoming']) {
    tries.config.describeArgs(`banner ${genre}`, [
      { name: 'delimiter', type: 'STRING', description: 'Message text, delimited by a chosen character' },
    ]);
  }
  // `crypto key generate rsa ?` ne repondait que `<cr>` : les trois
  // mots-cles que la commande consomme vraiment n'etaient nulle part.
  tries.config.describeArgs('crypto key generate rsa', [
    { ...ENUM('option', 'Key generation options', [
      ['general-keys', 'Generate a general purpose RSA key pair'],
      ['label', 'Provide a label for the key pair'],
      ['modulus', 'Provide number of modulus bits on the command line'],
      ['usage-keys', 'Generate separate signature and encryption keys'],
    ]), optional: true },
  ]);

  tries.configLine.describeArgs('exec-timeout', [
    INT('minutes', [0, 35791], 'Timeout in minutes'),
    { name: 'seconds', type: 'INT', description: 'Timeout in seconds', optional: true,
      range: [0, 2147483] },
  ]);
  // `tacacs server <nom>` et `tacacs-server host <adresse>` : les deux
  // mots-clés absorbent leur argument, et faute de le décrire l'aide
  // reproposait la liste d'options à sa place.
  tries.config.describeArgs('tacacs server', [
    WORD('name', 'Name for the TACACS+ server configuration'),
  ]);
  tries.config.describeArgs('tacacs-server host', [
    { ...IP('address', 'IP address of the TACACS+ server'), literal: 'Hostname or A.B.C.D' },
  ]);
  tries.config.addCompletionKeywords('tacacs-server host', [
    { keyword: 'key', description: 'per-server encryption key' },
    { keyword: 'port', description: 'TCP port number' },
    { keyword: 'timeout', description: 'Time to wait for this TACACS server to reply' },
  ]);
  tries.config.describeArgs('no tacacs-server host', [
    { ...IP('address', 'IP address of the TACACS+ server'), literal: 'Hostname or A.B.C.D' },
  ]);

  // Les réglages de la liaison série. Ils étaient les seuls nœuds de ce
  // mode dont l'aide venait de l'EXTRACTION du code : les vingt-deux
  // commandes de `line` partagent un aiguillage, donc chacune se voyait
  // proposer les mots-clés des vingt et une autres — `speed ?` répondait
  // `authentication`, `autocommand`, `banner`. Les valeurs ci-dessous
  // sont celles d'IOS.
  // `source-interface` était le SEUL mot-clé légitime que l'extraction
  // apportait à un nœud dont le corps est partagé — les quatre écritures
  // de `ip domain lookup`, sur les deux plateformes. Il est déclaré, ce
  // qui est aussi la seule façon de lui donner une description.
  for (const chemin of ['ip domain-lookup', 'ip domain lookup',
    'no ip domain-lookup', 'no ip domain lookup']) {
    tries.config.registerSuggestions(chemin, [
      { keyword: 'source-interface', description: 'Source interface for packets' },
    ]);
  }
  tries.privileged.describeArgs('enable view', [
    { ...WORD('view', 'View name'), optional: true },
  ]);
  tries.config.describeArgs('parser view', [
    WORD('view', 'View name'),
  ]);
  tries.config.describeArgs('no parser view', [
    WORD('view', 'View name'),
  ]);
  // `transport ?` listait `all`/`none`/`ssh`/`telnet` : ce sont les
  // MÉTHODES, un niveau trop haut. IOS n'offre ici que la direction.

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

  describeArgumentTypes(tries);

  // Une place qui accepte PLUSIEURS formes, et la direction qui suit.
  //
  // `ip access-group ?` rendait `in`/`out` — l'aide de la place
  // SUIVANTE — donc elle sautait en silence un argument obligatoire.
  // La direction est declaree comme second parametre : elle revient
  // d'elle-meme une fois la liste nommee, sans qu'une suggestion ait a
  // deviner a quel rang elle appartient.
  const DIRECTION = ENUM('direction', 'Filter direction', [
    ['in', 'Inbound packets'],
    ['out', 'Outbound packets'],
  ]);
  const LISTE_IP: ParamSpec = {
    name: 'access-list', type: 'WORD', description: 'Access-list name',
    alternatives: [
      { literal: '<1-199>', description: 'IP access list (standard or extended)' },
      { literal: '<1300-2699>', description: 'IP expanded access list (standard or extended)' },
      { literal: 'WORD', description: 'Access-list name' },
    ],
  };
  tries.configIf.describeArgs('ip access-group', [LISTE_IP, DIRECTION]);
  tries.configIf.describeArgs('service-policy', [
    ENUM('direction', 'Policy direction', [
      ['input', 'Assign policy-map to the input of an interface'],
      ['output', 'Assign policy-map to the output of an interface'],
    ]),
    WORD('policy-map', 'Policy-map name'),
  ]);

  tries.config.requireArgs('interface', 1);
  // Un type seul compte pour un argument, donc l'arité est satisfaite —
  // et pourtant la commande est incomplète. Le prédicat le dit.
  tries.config.executableWhen('interface',
    (args) => !(args.length === 1 && estTypeSansNumero(args[0])));
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
  tries.configLine.describeArgs('login-timeout', [
    INT('seconds', [1, 300], 'Timeout in seconds'),
  ]);
  tries.configLine.describeArgs('password', [
    LINE('password', 'The UNENCRYPTED (cleartext) line password'),
  ]);
  tries.config.describeArgs('parser view', [
    WORD('view', 'View name'),
  ]);
  tries.config.describeArgs('no parser view', [
    WORD('view', 'View name'),
  ]);
}
