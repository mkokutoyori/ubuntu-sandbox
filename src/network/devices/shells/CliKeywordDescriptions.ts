/**
 * Default `?` help descriptions for CLI keywords that appear as
 * intermediate trie nodes (e.g. the `dhcp` in `show ip dhcp binding`).
 *
 * When a command path is registered, intermediate nodes are created with a
 * placeholder description equal to their own keyword. Rendering that
 * placeholder verbatim produced "dhcp   dhcp" style help lines — unlike
 * IOS/VRP, which always describe every keyword. This dictionary supplies
 * vendor-neutral descriptions for the common protocol/feature keywords;
 * `descriptionForKeyword` is the single lookup used by the help renderer.
 */

const KEYWORD_DESCRIPTIONS: ReadonlyMap<string, string> = new Map<string, string>([
  ['aaa', 'Authentication, Authorization and Accounting'],
  ['access-lists', 'Access lists'],
  ['arp', 'Address Resolution Protocol'],
  ['as-path', 'BGP autonomous-system path filter'],
  ['bfd', 'Bidirectional Forwarding Detection'],
  ['bgp', 'Border Gateway Protocol'],
  ['bootp', 'Bootstrap Protocol'],
  ['cache', 'Cache entries'],
  ['cdp', 'Cisco Discovery Protocol'],
  ['cef', 'Cisco Express Forwarding'],
  ['community-list', 'BGP community list'],
  ['crypto', 'Encryption and key management'],
  ['dhcp', 'Dynamic Host Configuration Protocol'],
  ['dns', 'Domain Name System'],
  ['domain', 'IP domain configuration'],
  ['dot1x', 'IEEE 802.1X port-based authentication'],
  ['eigrp', 'Enhanced Interior Gateway Routing Protocol'],
  ['flow', 'NetFlow'],
  ['gdoi', 'Group Domain of Interpretation'],
  ['glbp', 'Gateway Load Balancing Protocol'],
  ['hsrp', 'Hot Standby Router Protocol'],
  ['http', 'Hypertext Transfer Protocol'],
  ['icmp', 'Internet Control Message Protocol'],
  ['igmp', 'Internet Group Management Protocol'],
  ['ikev2', 'Internet Key Exchange version 2'],
  ['interface', 'Interface configuration'],
  ['ip', 'Internet Protocol'],
  ['ipsec', 'IP Security'],
  ['ipv6', 'Internet Protocol version 6'],
  ['isakmp', 'Internet Security Association and Key Management Protocol'],
  ['lacp', 'Link Aggregation Control Protocol'],
  ['lldp', 'Link Layer Discovery Protocol'],
  ['local', 'Local settings'],
  ['mac', 'MAC configuration'],
  ['multicast', 'IP multicast'],
  ['nat', 'Network Address Translation'],
  ['nbar', 'Network-Based Application Recognition'],
  ['netflow', 'NetFlow statistics'],
  ['nhrp', 'Next Hop Resolution Protocol'],
  ['no', 'Negate a command or set its defaults'],
  ['ntp', 'Network Time Protocol'],
  ['ospf', 'Open Shortest Path First'],
  ['pim', 'Protocol Independent Multicast'],
  ['pki', 'Public Key Infrastructure'],
  ['policy', 'Policy configuration'],
  ['proxy-arp', 'Proxy ARP'],
  ['radius', 'RADIUS authentication'],
  ['rip', 'Routing Information Protocol'],
  ['route', 'Route information'],
  ['sla', 'Service Level Agreement'],
  ['snmp', 'Simple Network Management Protocol'],
  ['ssh', 'Secure Shell'],
  ['static', 'Static entries'],
  ['stp', 'Spanning Tree Protocol'],
  ['summary-address', 'Summary address entries'],
  ['tacacs', 'TACACS+ authentication'],
  ['tcp', 'Transmission Control Protocol'],
  ['udp', 'User Datagram Protocol'],
  ['vlan', 'VLAN configuration'],
  ['vrf', 'VPN Routing/Forwarding'],
  ['vrrp', 'Virtual Router Redundancy Protocol'],
  ['vtp', 'VLAN Trunking Protocol'],
  ['vxlan', 'Virtual Extensible LAN'],
]);

/**
 * Best-effort description for a keyword whose registration left only the
 * keyword-as-description placeholder. Returns an empty string when the
 * keyword is unknown — the help renderer then shows a blank description,
 * which is still better than echoing the keyword twice.
 */
export function descriptionForKeyword(keyword: string): string {
  return KEYWORD_DESCRIPTIONS.get(keyword.toLowerCase()) ?? '';
}
