/**
 * Huawei VRP router — DHCP & NAT gap-analysis (~300 steps).
 * DHCP global/interface pools (gateway/dns/lease/option/static-bind/
 * excluded), DHCP relay, DHCPv6, DHCP snooping; NAT outbound (PAT)/
 * address-group/static/server, plus their display/reset families.
 */
import { describe, it } from 'vitest';
import {
  buildHuaweiLab, dumpRouter, resetSim, regressionSweep, sweep, each,
  type RouterStepInput,
} from './_router-suite';

describe('debug-dump: huawei-router-dhcp-nat', () => {
  it('writes the transcript', async () => {
    resetSim();
    const { topology } = buildHuaweiLab();
    const steps: RouterStepInput[] = [
      { section: 'base addressing', cmd: 'system-view' },
      'interface GigabitEthernet0/0/0',
      'ip address 192.168.1.1 255.255.255.0',
      'undo shutdown',
      'quit',
      'interface GigabitEthernet0/0/1',
      'ip address 10.0.0.1 255.255.255.252',
      'undo shutdown',
      'quit',
      'dhcp enable',
      'return',

      { section: 'DHCP global pools', cmd: 'system-view' },
      ...sweep(6, (i) => [
        `ip pool VLAN${i * 10}`,
        `network 192.168.${i}.0 mask 255.255.255.0`,
        `gateway-list 192.168.${i}.1`,
        `dns-list 8.8.8.8 8.8.4.4`,
        `domain-name vlan${i * 10}.lab`,
        `lease day ${i} hour 12 minute 30`,
        `excluded-ip-address 192.168.${i}.1 192.168.${i}.10`,
        `netbios-type h-node`,
        `nbns-list 192.168.${i}.2`,
        `option 43 sub-option 3 ascii 10.1.1.${i}`,
        `option 150 ip-address 192.168.${i}.3`,
        `static-bind ip-address 192.168.${i}.50 mac-address 00e0-fc00-000${i}`,
        'quit',
      ]),
      'ip pool INFINITE',
      'network 172.16.0.0 mask 255.255.0.0',
      'lease unlimited',
      'quit',
      'return',
      'display ip pool',
      'display ip pool name VLAN10',
      'display dhcp server statistics',
      'display dhcp server conflict all',

      { section: 'DHCP interface pool', cmd: 'system-view' },
      'interface GigabitEthernet0/0/0',
      'dhcp select interface',
      'dhcp server dns-list 8.8.8.8',
      'dhcp server lease day 1',
      'dhcp server excluded-ip-address 192.168.1.1 192.168.1.9',
      'dhcp server static-bind ip-address 192.168.1.60 mac-address 00e0-fc11-2233',
      'quit',
      'return',
      'display dhcp server interface GigabitEthernet0/0/0',

      { section: 'DHCP relay', cmd: 'system-view' },
      'interface GigabitEthernet0/0/0',
      'dhcp select relay',
      'dhcp relay server-ip 10.0.0.2',
      'dhcp relay server-ip 10.0.0.3',
      'dhcp relay information enable',
      'dhcp relay information strategy keep',
      'quit',
      'return',
      'display dhcp relay all',
      'display dhcp relay statistics',

      { section: 'DHCPv6', cmd: 'system-view' },
      'dhcpv6 pool V6POOL',
      'address prefix 2001:db8:1::/64',
      'dns-server 2001:4860:4860::8888',
      'dns-domain-name v6.lab',
      'quit',
      'interface GigabitEthernet0/0/0',
      'ipv6 enable',
      'ipv6 address 2001:db8:1::1/64',
      'dhcpv6 server V6POOL',
      'undo ipv6 nd ra halt',
      'quit',
      'return',
      'display dhcpv6 pool',
      'display dhcpv6 server',

      { section: 'DHCP snooping', cmd: 'system-view' },
      'dhcp snooping enable',
      'dhcp snooping enable ipv4',
      'interface GigabitEthernet0/0/1',
      'dhcp snooping trusted',
      'dhcp snooping check dhcp-rate enable',
      'dhcp snooping check dhcp-rate 100',
      'quit',
      'return',
      'display dhcp snooping',
      'display dhcp snooping interface GigabitEthernet0/0/1',

      { section: 'NAT outbound / PAT', cmd: 'system-view' },
      'acl 2000',
      'rule 5 permit source 192.168.1.0 0.0.0.255',
      'quit',
      'acl 2001',
      'rule 5 permit source 192.168.2.0 0.0.0.255',
      'quit',
      'nat address-group 1 10.0.0.50 10.0.0.60',
      'interface GigabitEthernet0/0/1',
      'nat outbound 2000',
      'nat outbound 2000 address-group 1',
      'nat outbound 2001 address-group 1 no-pat',
      'nat outbound 2000 interface GigabitEthernet0/0/1',
      'quit',
      'return',
      'display nat outbound',
      'display nat address-group',
      'display nat session all',
      'display nat session protocol tcp',

      { section: 'NAT static / server', cmd: 'system-view' },
      ...sweep(6, (i) =>
        `nat static global 10.0.0.${i + 10} inside 192.168.1.${i + 10}`),
      'interface GigabitEthernet0/0/1',
      'nat server protocol tcp global 10.0.0.100 80 inside 192.168.1.100 8080',
      'nat server protocol tcp global current-interface 2222 inside 192.168.1.101 22',
      'nat server protocol udp global 10.0.0.100 53 inside 192.168.1.102 53',
      'nat dns-map example.com 10.0.0.100 80 tcp',
      'quit',
      'nat static enable',
      'return',
      'display nat static',
      'display nat server',
      'reset nat session all',

      ...regressionSweep('huawei'),
    ];
    await dumpRouter('huawei-router-dhcp-nat', topology, steps,
      'focus=VRP DHCP global/relay/v6/snoop + NAT outbound/static/server',
      { resyncVendor: 'huawei' });
  }, 120000);
});
