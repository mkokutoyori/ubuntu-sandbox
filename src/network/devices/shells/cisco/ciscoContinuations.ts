import type { CommandTrie } from '../CommandTrie';
import { descriptionForKeyword } from '../CliKeywordDescriptions';

/**
 * Les suites d'un noeud glouton, ECRITES.
 *
 * L'aide les DERIVAIT du texte source des gestionnaires : un mot cite
 * dans le corps d'une fonction devenait une continuation proposee. La
 * mesure a montre que ce qu'elle produit aujourd'hui est juste — 331
 * paires, toutes de vrais mots-cles d'IOS — mais le mecanisme lie
 * l'aide au CODE, et ce depot a deja paye la facture : reecrire le
 * corps de `no privilege` pour qu'il delegue son analyse a fait
 * disparaitre le mot `level` de son source, donc de son aide, en
 * silence.
 *
 * Ces tables sont le releve de ce que l'extraction produisait, verifie
 * mot par mot contre la syntaxe d'IOS. Elles sont desormais la source :
 * un mot ne s'ajoute plus en ecrivant du code, il s'ajoute en
 * l'ecrivant ici, et une reecriture de gestionnaire ne peut plus
 * defaire l'aide.
 *
 * `SOCLE` est ce que les DEUX plateformes portent ; les deux autres
 * tables ne sont appliquees qu'a la leur, pour qu'une declaration ne
 * fabrique jamais un noeud sur une machine qui n'a pas la commande.
 */
export type ContinuationTable = Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;

/** Ce que le routeur ET le commutateur portent. */
export const SOCLE: ContinuationTable = {
  config: {
    'clock summer-time': ['recurring'],
    'enable password': ['level'],
    'enable secret': ['level'],
    'ip community-list': ['expanded', 'standard'],
    'ip host': ['ns'],
    'ip http access-class': ['ipv4'],
    'login block-for': ['attempts', 'within'],
    'no banner': ['exec', 'incoming', 'login'],
    'no ip host': ['ns'],
    'radius': ['server'],
    'sntp server': ['prefer'],
  },
  configAaaGroup: {
    'no server': ['name'],
    'server': ['name'],
  },
  configRadiusServer: {
    'address': ['acct-port', 'auth-port', 'ipv4'],
  },
  configTacacsServer: {
    'address': ['ipv4'],
  },
  configView: {
    'commands': ['all', 'exclude', 'include-exclusive'],
  },
  privileged: {
    'clear aaa local user lockout': ['username'],
    'debug aaa': ['accounting', 'authentication', 'authorization'],
    'debug condition': ['interface', 'ip', 'vrf'],
    'debug ntp': ['events', 'packets'],
    'no debug aaa': ['accounting', 'authentication', 'authorization'],
    'no debug condition': ['all', 'interface', 'ip', 'vrf'],
    'no debug ip': ['arp', 'bgp', 'eigrp', 'icmp', 'nhrp', 'packet', 'pim', 'rip', 'routing', 'ssh', 'tcp', 'udp'],
    'no debug ntp': ['events', 'packets'],
    'show archive log config': ['statistics'],
    'show glbp': ['brief'],
    'show parser view': ['all'],
    'show standby': ['brief'],
    'show vrrp': ['brief'],
    'sntp server': ['prefer'],
  },
  user: {
    'clear aaa local user lockout': ['username'],
    'show glbp': ['brief'],
    'show interfaces': ['description'],
    'show standby': ['brief'],
    'show vrrp': ['brief'],
  },
};

/** Ce que seul un routeur IOS porte. */
export const ROUTEUR_SEUL: ContinuationTable = {
  config: {
    'class-map': ['inspect', 'match-all', 'match-any', 'type'],
    'crypto ipsec security-policy': ['dst', 'in', 'out', 'proto', 'src'],
    'crypto isakmp keepalive': ['on-demand'],
    'crypto isakmp key': ['hostname'],
    'crypto map': ['dynamic', 'ipsec-isakmp'],
    'crypto pki import': ['certificate', 'pem'],
    'event manager applet': ['authorization'],
    'ip flow-cache': ['active', 'inactive', 'timeout'],
    'ip flow-export': ['destination', 'source', 'version'],
    'ip nat inside source static': ['interface'],
    'no crypto isakmp key': ['hostname'],
    'no ip nat inside source static': ['tcp', 'udp'],
    'no ip prefix-list': ['seq'],
    'no ip sla reaction-configuration': ['react'],
    'policy-map': ['inspect', 'type'],
    'route-map': ['deny'],
    'router ospf': ['vrf'],
    'zone-pair security': ['destination', 'source'],
  },
  configCaTrustpoint: {
    'auto-enroll': ['regenerate'],
    'enrollment': ['profile', 'self-signed', 'selfsigned', 'terminal', 'url'],
    'revocation-check': ['crl-or-ocsp', 'crl-then-ocsp', 'none', 'ocsp'],
  },
  configCmap: {
    'match': ['access-group', 'any', 'name', 'protocol'],
  },
  configCp: {
    'service-policy': ['input', 'output'],
  },
  configExtNacl: {
    'sequence': ['deny', 'permit'],
  },
  configIf: {
    'bfd': ['echo', 'multiplier', 'template'],
    'frame-relay': ['interface-dlci', 'inverse-arp', 'ip', 'lmi-type', 'map'],
    'ip address': ['negotiated', 'secondary'],
    'ip authentication mode eigrp': ['hmac-sha-256', 'md5'],
    'ip flow monitor': ['output'],
    'ip forward-protocol udp': ['bootpc', 'bootps'],
    'ip nhrp': ['authentication', 'holdtime', 'map', 'multicast', 'network-id', 'nhs', 'redirect', 'shortcut'],
    'ip ospf database-filter': ['all', 'out'],
    'ip verify unicast': ['any', 'reachable-via', 'reverse-path', 'source'],
    'ipv6 address': ['eui-64', 'link-local'],
    'ipv6 ospf': ['area'],
    'negotiation': ['auto'],
    'no ip access-group': ['in', 'out'],
    'no ip address': ['secondary'],
    'tunnel path-mtu-discovery': ['age-timer', 'min-mtu'],
    'tunnel protection ipsec profile': ['shared'],
  },
  configIpv6Dhcp: {
    'address prefix': ['lifetime'],
  },
  configPmap: {
    'class': ['inspect', 'type'],
  },
  configStdNacl: {
    'sequence': ['deny', 'permit'],
  },
  configTimeRange: {
    'periodic': ['to'],
  },
  configTrack: {
    'delay': ['down', 'up'],
    'object': ['not', 'weight'],
    'threshold': ['down', 'up'],
  },
  configZonePair: {
    'service-policy': ['inspect', 'type'],
  },
  privileged: {
    'clear crypto session': ['remote'],
    'show bfd neighbors': ['details'],
    'show flow monitor': ['cache'],
    'show interfaces': ['accounting', 'description', 'rate-limit', 'stats', 'summary'],
    'show ip igmp groups': ['detail'],
    'show ip sla statistics': ['aggregated', 'details'],
    'show ipv6 interface': ['brief'],
    'show track': ['brief', 'up'],
    'show traffic-shape': ['statistics'],
  },
  user: {
    'show bfd neighbors': ['details'],
    'show flow monitor': ['cache'],
    'show interfaces': ['accounting', 'rate-limit', 'stats', 'summary'],
    'show ip eigrp interfaces': ['detail'],
    'show ip eigrp neighbors': ['detail'],
    'show ip eigrp topology': ['all-links'],
    'show ip igmp groups': ['detail'],
    'show ip sla statistics': ['aggregated', 'details'],
    'show ipv6 interface': ['brief'],
    'show track': ['brief', 'up'],
    'show traffic-shape': ['statistics'],
  },
};

/** Ce que seul un Catalyst porte. */
export const COMMUTATEUR_SEUL: ContinuationTable = {
  config: {
    'ip access-list': ['standard'],
    'ip arp inspection filter': ['static', 'vlan'],
    'ip igmp snooping': ['immediate-leave', 'mrouter', 'querier', 'vlan'],
    'line': ['aux', 'console', 'vty'],
    'no ip igmp snooping': ['immediate-leave', 'mrouter', 'querier', 'vlan'],
    'no spanning-tree': ['backbonefast', 'bpdufilter', 'bpduguard', 'default', 'loopguard', 'pathcost', 'portfast', 'uplinkfast', 'vlan'],
    'spanning-tree mst': ['priority'],
    'track': ['interface', 'ip', 'routing'],
    'vtp mode': ['client', 'off', 'server', 'transparent'],
  },
  configAccessMap: {
    'action': ['drop', 'forward'],
  },
  configIf: {
    'channel-group': ['active', 'auto', 'desirable', 'mode', 'on', 'passive'],
    'dot1x pae': ['authenticator'],
    'dot1x timeout': ['quiet-period'],
    'glbp': ['decrement', 'delay', 'host-dependent', 'ip', 'key-string', 'md5', 'minimum', 'priority', 'round-robin', 'track', 'weighted'],
    'interface': ['range'],
    'l2protocol-tunnel': ['cdp', 'lldp', 'stp', 'vtp'],
    'lacp rate': ['fast', 'normal'],
    'no glbp': ['preempt'],
    'no spanning-tree': ['bpdufilter', 'bpduguard', 'guard', 'loop', 'portfast', 'vlan'],
    'no standby': ['preempt'],
    'no switchport port-security mac-address': ['sticky'],
    'no vrrp': ['preempt'],
    'spanning-tree': ['disable', 'enable', 'loop', 'root'],
    'standby': ['decrement', 'delay', 'ip', 'minimum', 'priority', 'text', 'version'],
    'switchport mode private-vlan trunk': ['host', 'promiscuous'],
    'switchport port-security aging type': ['absolute', 'inactivity'],
    'switchport port-security mac-address': ['sticky'],
    'switchport port-security violation': ['protect', 'restrict', 'shutdown'],
    'switchport trunk allowed vlan': ['add', 'all', 'except', 'none', 'remove'],
    'switchport trunk encapsulation': ['dot1q', 'negotiate'],
    'switchport trunk pruning vlan': ['add', 'except', 'none', 'remove'],
    'switchport voice vlan': ['dot1p', 'none', 'untagged'],
    'udld port': ['aggressive'],
    'vrrp': ['advertise', 'decrement', 'delay', 'ip', 'minimum', 'priority'],
  },
  configMst: {
    'no': ['instance', 'name', 'revision'],
  },
  configVlan: {
    'private-vlan': ['association', 'community', 'isolated', 'primary'],
  },
  privileged: {
    'clear port-security': ['all', 'configured', 'dynamic', 'sticky'],
    'no debug ip': ['nat'],
    'show ip igmp snooping': ['groups', 'mrouter', 'querier', 'vlan'],
  },
  user: {
    'show interfaces': ['etherchannel', 'status', 'switchport'],
    'show ip igmp snooping': ['groups', 'mrouter', 'querier', 'vlan'],
    'show monitor session': ['all'],
  },
};

export interface SocleContinuation {
  readonly keyword: string;
  readonly description: string;
  readonly afterArguments: true;
  readonly argument: null;
}

export function continuationsPourLeSocle(
  path: string, ...tables: readonly ContinuationTable[]
): readonly SocleContinuation[] | undefined {
  const mots = new Set<string>();
  for (const table of tables) {
    for (const chemins of Object.values(table)) {
      for (const mot of chemins[path] ?? []) mots.add(mot);
    }
  }
  if (mots.size === 0) return undefined;
  return [...mots].sort().map(keyword => ({
    keyword,
    description: descriptionForKeyword(keyword),
    afterArguments: true as const,
    argument: null,
  }));
}

export function appliquerContinuations(
  tries: Readonly<Record<string, CommandTrie | undefined>>,
  ...tables: readonly ContinuationTable[]
): void {
  for (const table of tables) {
    for (const [nom, chemins] of Object.entries(table)) {
      const trie = tries[nom];
      if (!trie) continue;
      for (const [chemin, mots] of Object.entries(chemins)) {
        trie.declareContinuations(chemin, mots);
      }
    }
  }
}
