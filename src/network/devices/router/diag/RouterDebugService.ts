export type DebugCategory =
  | 'crypto.isakmp'
  | 'crypto.ipsec'
  | 'crypto.ikev2'
  | 'crypto.pki'
  | 'crypto.pki.transactions'
  | 'crypto.pki.messages'
  | 'ip.ospf.adj'
  | 'ip.ospf.events'
  | 'ip.ospf.spf'
  | 'ip.ospf.hello'
  | 'ip.ospf.packet'
  | 'ip.ospf.lsa-generation'
  | 'ip.rip'
  | 'ip.eigrp'
  | 'ip.bgp'
  | 'ip.routing'
  | 'ip.icmp'
  | 'ip.packet'
  | 'ip.tcp'
  | 'ip.udp'
  | 'ip.nat'
  | 'ip.arp'
  | 'ip.dhcp.server'
  | 'ip.ssh'
  | 'ip.nhrp'
  | 'standby'
  | 'vrrp'
  | 'glbp'
  | 'track'
  | 'ip.sla.trace'
  | 'aaa.authentication'
  | 'aaa.authorization'
  | 'aaa.accounting'
  | 'radius'
  | 'tacacs'
  | 'ntp.events'
  | 'ntp.packets';

export interface DebugFlag {
  category: DebugCategory;
  enabledAtMs: number;
  scope?: string;
}

export class RouterDebugService {
  private readonly flags: Map<DebugCategory, DebugFlag> = new Map();

  enable(category: DebugCategory, scope?: string): string {
    this.flags.set(category, { category, enabledAtMs: Date.now(), scope });
    return `${RouterDebugService.label(category)} debugging is on${scope ? ' for ' + scope : ''}`;
  }

  disable(category: DebugCategory): string {
    this.flags.delete(category);
    return `${RouterDebugService.label(category)} debugging is off`;
  }

  isEnabled(category: DebugCategory): boolean { return this.flags.has(category); }

  list(): readonly DebugFlag[] {
    return [...this.flags.values()].sort((a, b) => a.category.localeCompare(b.category));
  }

  disableAll(): string {
    const n = this.flags.size;
    this.flags.clear();
    return n === 0 ? 'All possible debugging has been turned off' : `${n} debug flag${n === 1 ? '' : 's'} have been turned off`;
  }

  static label(category: DebugCategory): string {
    switch (category) {
      case 'crypto.isakmp': return 'Crypto ISAKMP';
      case 'crypto.ipsec': return 'Crypto IPSec';
      case 'crypto.ikev2': return 'IKEv2';
      case 'crypto.pki': return 'Crypto PKI';
      case 'crypto.pki.transactions': return 'PKI Transactions';
      case 'crypto.pki.messages': return 'PKI Messages';
      case 'ip.ospf.adj': return 'OSPF adjacency';
      case 'ip.ospf.events': return 'OSPF events';
      case 'ip.ospf.spf': return 'OSPF SPF';
      case 'ip.ospf.hello': return 'OSPF Hello';
      case 'ip.ospf.packet': return 'OSPF packet';
      case 'ip.ospf.lsa-generation': return 'OSPF LSA generation';
      case 'ip.rip': return 'RIP';
      case 'ip.eigrp': return 'EIGRP';
      case 'ip.bgp': return 'BGP';
      case 'ip.routing': return 'IP routing';
      case 'ip.icmp': return 'IP ICMP';
      case 'ip.packet': return 'IP packet';
      case 'ip.tcp': return 'IP TCP';
      case 'ip.udp': return 'IP UDP';
      case 'ip.nat': return 'IP NAT';
      case 'ip.arp': return 'IP ARP';
      case 'ip.dhcp.server': return 'IP DHCP server';
      case 'ip.ssh': return 'SSH';
      case 'ip.nhrp': return 'NHRP';
      case 'standby': return 'HSRP';
      case 'vrrp': return 'VRRP';
      case 'glbp': return 'GLBP';
      case 'track': return 'TRACK';
      case 'ip.sla.trace': return 'IP SLA';
      case 'aaa.authentication': return 'AAA Authentication';
      case 'aaa.authorization': return 'AAA Authorization';
      case 'aaa.accounting': return 'AAA Accounting';
      case 'radius': return 'RADIUS';
      case 'tacacs': return 'TACACS+';
      case 'ntp.events': return 'NTP events';
      case 'ntp.packets': return 'NTP packets';
    }
  }

  format(): string {
    if (this.flags.size === 0) return 'No debug flags are enabled';
    return this.list()
      .map(f => `${RouterDebugService.label(f.category)} debugging is on${f.scope ? ' for ' + f.scope : ''}`)
      .join('\n');
  }
}
