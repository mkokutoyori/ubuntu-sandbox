/**
 * Huawei VRP router — interface configuration gap-analysis (~300).
 * IPv4/IPv6 addressing, sub-interfaces + dot1q termination, loopback,
 * tunnel (GRE/IPsec), MTU/bandwidth/speed/duplex, NAT binding,
 * DHCP select, traffic-filter bind, shutdown cycles, display family.
 */
import { describe, it } from 'vitest';
import {
  buildHuaweiLab, dumpRouter, resetSim, regressionSweep, sweep, each,
  type RouterStepInput,
} from './_router-suite';

describe('debug-dump: huawei-router-interfaces', () => {
  it('writes the transcript', async () => {
    resetSim();
    const { topology } = buildHuaweiLab();
    const steps: RouterStepInput[] = [
      { section: 'physical interface battery', cmd: 'system-view' },
      'interface GigabitEthernet0/0/0',
      ...each([
        'ip address 192.168.1.1 255.255.255.0',
        'ip address 192.168.100.1 24 sub',
        'ipv6 enable',
        'ipv6 address 2001:db8:1::1/64',
        'ipv6 address auto link-local',
        'description ## LAN to L1 ##',
        'mtu 1500',
        'jumboframe enable 9000',
        'bandwidth 100000',
        'speed 1000',
        'duplex full',
        'negotiation auto',
        'undo negotiation auto',
        'flow-control',
        'loopback internal',
        'undo loopback',
        'arp expire-time 600',
        'arp-proxy enable',
        'undo arp-proxy enable',
        'mac-address 00e0-fc12-3456',
        'traffic-policy P1 inbound',
        'qos queue 0 shaping 50',
        'dhcp select interface',
        'dhcp select global',
        'nat outbound 2000',
        'nat server protocol tcp global 10.0.0.1 80 inside 192.168.1.10 80',
        'undo shutdown',
      ], (c) => c),
      'quit',

      { section: 'loopbacks', cmd: 'system-view' },
      ...sweep(8, (i) => [
        `interface LoopBack${i}`,
        `ip address 10.255.255.${i} 255.255.255.255`,
        `description LOOP-${i}`,
        'quit',
      ]),
      'return',
      'display ip interface brief',

      { section: 'dot1q sub-interfaces', cmd: 'system-view' },
      ...sweep(10, (i) => [
        `interface GigabitEthernet0/0/0.${i * 10}`,
        `dot1q termination vid ${i * 10}`,
        `ip address 192.168.${i}.1 255.255.255.0`,
        'arp broadcast enable',
        'quit',
      ]),
      'return',
      'display ip interface brief',
      'display interface GigabitEthernet0/0/0.10',

      { section: 'tunnels', cmd: 'system-view' },
      'interface Tunnel0/0/0',
      'tunnel-protocol gre',
      'ip address 172.16.0.1 255.255.255.252',
      'source GigabitEthernet0/0/0',
      'destination 10.0.0.2',
      'gre key 1234',
      'keepalive period 5 retry-times 3',
      'quit',
      'interface Tunnel0/0/1',
      'tunnel-protocol ipsec',
      'ip address 172.16.0.5 255.255.255.252',
      'source LoopBack0',
      'destination 10.0.0.2',
      'ipsec profile PROF1',
      'quit',
      'return',
      'display interface Tunnel0/0/0',

      { section: 'IPv6 addressing', cmd: 'system-view' },
      'ipv6',
      'interface GigabitEthernet0/0/0',
      'ipv6 enable',
      'ipv6 address 2001:db8:abcd::1/64',
      'ipv6 address fe80::1 link-local',
      'ipv6 nd ra halt',
      'undo ipv6 nd ra halt',
      'ipv6 mtu 1280',
      'quit',
      'return',
      'display ipv6 interface GigabitEthernet0/0/0',
      'display ipv6 interface brief',

      { section: 'shutdown / clear', cmd: 'system-view' },
      ...each(['GigabitEthernet0/0/0', 'GigabitEthernet0/0/1'], (intf) => [
        `interface ${intf}`,
        'shutdown',
        'display this',
        'undo shutdown',
        'quit',
      ]),
      'return',
      'reset counters interface GigabitEthernet0/0/0',
      'reset ip routing-table statistics protocol all',
      'reset arp all',

      { section: 'per-interface display family', cmd: 'display interface' },
      ...each([
        'GigabitEthernet0/0/0', 'GigabitEthernet0/0/1', 'LoopBack0',
        'Tunnel0/0/0',
      ], (intf) => [
        `display interface ${intf}`,
        `display ip interface ${intf}`,
        `display interface ${intf} | include line protocol`,
      ]),
      'display interface brief',
      'display interface description',
      'display ip interface brief',

      ...regressionSweep('huawei'),
    ];
    await dumpRouter('huawei-router-interfaces', topology, steps,
      'focus=VRP IPv4/IPv6 addressing, dot1q sub-if, tunnels, display',
      { resyncVendor: 'huawei' });
  }, 120000);
});
