/**
 * Cisco IOS router — static & policy routing gap-analysis (~300 steps).
 * Static / default / floating / recursive / interface routes, IPv6
 * static, route-maps, prefix-lists, policy-based routing, route
 * tracking/SLA, distance, and the routing-table show family.
 */
import { describe, it } from 'vitest';
import {
  buildCiscoLab, dumpRouter, resetSim, regressionSweep, sweep, each, type RouterStepInput,
} from './_router-suite';

describe('debug-dump: cisco-router-static-routing', () => {
  it('writes the transcript', async () => {
    resetSim();
    const { topology } = buildCiscoLab();
    const steps: RouterStepInput[] = [
      { section: 'base addressing', cmd: 'enable' },
      'configure terminal',
      'interface GigabitEthernet0/0',
      'ip address 192.168.1.1 255.255.255.0',
      'no shutdown',
      'exit',
      'interface GigabitEthernet0/1',
      'ip address 10.0.0.1 255.255.255.252',
      'no shutdown',
      'exit',
      'end',

      { section: 'static route sweep', cmd: 'configure terminal' },
      ...sweep(40, (i) =>
        `ip route 172.${16 + (i % 16)}.${i}.0 255.255.255.0 10.0.0.2`),
      'end',
      'show ip route',
      'show ip route static',
      'show ip route 172.16.1.0',
      'show ip route 172.16.1.0 255.255.255.0',
      'show ip route summary',

      { section: 'default / floating / recursive', cmd: 'configure terminal' },
      'ip route 0.0.0.0 0.0.0.0 10.0.0.2',
      'ip route 0.0.0.0 0.0.0.0 10.0.0.6 200',
      'ip route 0.0.0.0 0.0.0.0 GigabitEthernet0/1',
      'ip default-network 172.16.0.0',
      'ip route 192.168.50.0 255.255.255.0 10.0.0.2 name BRANCH-A',
      'ip route 192.168.51.0 255.255.255.0 10.0.0.2 250 name BACKUP',
      'ip route 192.168.52.0 255.255.255.0 Null0',
      'ip route 192.168.53.0 255.255.255.0 GigabitEthernet0/1 10.0.0.2',
      'ip route 8.8.8.0 255.255.255.0 10.0.0.2 track 1',
      'ip route vrf CUST 192.168.60.0 255.255.255.0 10.0.0.2',
      'ip routing',
      'no ip routing',
      'ip routing',
      'ip cef',
      'ip route 192.168.99.0 255.255.255.0 10.0.0.2 permanent',
      'end',
      'show ip route',
      'show ip cef',
      'show ip cef 0.0.0.0',
      'show ip route 0.0.0.0',

      { section: 'IPv6 static', cmd: 'configure terminal' },
      'ipv6 unicast-routing',
      'ipv6 route 2001:db8:2::/64 2001:db8:1::2',
      'ipv6 route ::/0 2001:db8:1::2',
      'ipv6 route 2001:db8:3::/64 GigabitEthernet0/1',
      'ipv6 route 2001:db8:4::/64 GigabitEthernet0/1 fe80::2',
      'ipv6 route 2001:db8:5::/64 Null0 250',
      'no ipv6 unicast-routing',
      'ipv6 unicast-routing',
      'end',
      'show ipv6 route',
      'show ipv6 route static',
      'show ipv6 route summary',

      { section: 'prefix-lists', cmd: 'configure terminal' },
      ...sweep(15, (i) =>
        `ip prefix-list PL-IN seq ${i * 5} permit 10.${i}.0.0/16 le 24`),
      'ip prefix-list PL-IN seq 100 deny 0.0.0.0/0',
      'ip prefix-list PL-OUT permit 192.168.0.0/16 ge 24',
      'ipv6 prefix-list V6-PL seq 5 permit 2001:db8::/32 le 64',
      'no ip prefix-list PL-IN seq 5',
      'end',
      'show ip prefix-list',
      'show ip prefix-list PL-IN',
      'show ipv6 prefix-list',

      { section: 'route-maps', cmd: 'configure terminal' },
      ...sweep(6, (i) => [
        `route-map RM-PBR permit ${i * 10}`,
        `match ip address ${100 + i}`,
        `match interface GigabitEthernet0/0`,
        `set ip next-hop 10.0.0.${i + 1}`,
        `set interface GigabitEthernet0/1`,
        `set ip default next-hop 10.0.0.254`,
        i === 1 ? 'set ip precedence priority' : 'set ip dscp af21',
        'exit',
      ]),
      'route-map RM-PBR deny 100',
      'exit',
      'access-list 101 permit ip 192.168.1.0 0.0.0.255 any',
      'access-list 102 permit ip 192.168.2.0 0.0.0.255 any',
      'end',
      'show route-map',
      'show route-map RM-PBR',

      { section: 'policy-based routing', cmd: 'configure terminal' },
      'interface GigabitEthernet0/0',
      'ip policy route-map RM-PBR',
      'exit',
      'ip local policy route-map RM-PBR',
      'end',
      'show ip policy',
      'show route-map RM-PBR',
      'debug ip policy',
      'undebug all',

      { section: 'tracking / IP SLA', cmd: 'configure terminal' },
      'ip sla 1',
      'icmp-echo 10.0.0.2 source-interface GigabitEthernet0/1',
      'frequency 10',
      'threshold 500',
      'timeout 1000',
      'exit',
      'ip sla schedule 1 life forever start-time now',
      'track 1 ip sla 1 reachability',
      'track 2 interface GigabitEthernet0/1 line-protocol',
      'track 3 list boolean and',
      'exit',
      'end',
      'show ip sla configuration',
      'show ip sla statistics',
      'show track',
      'show track 1',

      { section: 'admin distance / metrics', cmd: 'configure terminal' },
      'router ospf 1',
      'distance 110',
      'distance ospf intra-area 90 inter-area 100 external 120',
      'exit',
      'end',
      ...each([
        'show ip route', 'show ip route static', 'show ip route ospf',
        'show ip route connected', 'show ip route 10.0.0.0',
        'show ip route profile', 'show ip route vrf CUST',
        'show ip protocols', 'show ip cef summary', 'show ip static route',
      ], (c) => c),
      ...regressionSweep('cisco'),
    ];
    await dumpRouter('cisco-router-static-routing', topology, steps,
      'focus=static/default/floating, IPv6, prefix-list, PBR, SLA/track',
      { resyncVendor: 'cisco' });
  }, 120000);
});
