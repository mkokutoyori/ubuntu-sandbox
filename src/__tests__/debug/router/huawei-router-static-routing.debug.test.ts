/**
 * Huawei VRP router — static & policy routing gap-analysis (~300).
 * ip route-static (incl. preference/description/track NQA), default,
 * IPv6 static, ip-prefix, route-policy (if-match/apply), policy-based
 * routing, NQA test instances, and the routing-table display family.
 */
import { describe, it } from 'vitest';
import {
  buildHuaweiLab, dumpRouter, resetSim, regressionSweep, sweep, each,
  type RouterStepInput,
} from './_router-suite';

describe('debug-dump: huawei-router-static-routing', () => {
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
      'return',

      { section: 'static route sweep', cmd: 'system-view' },
      ...sweep(40, (i) =>
        `ip route-static 172.${16 + (i % 16)}.${i}.0 255.255.255.0 10.0.0.2`),
      'return',
      'display ip routing-table',
      'display ip routing-table protocol static',
      'display ip routing-table 172.16.1.0',
      'display ip routing-table statistics',

      { section: 'default / pref / track', cmd: 'system-view' },
      'ip route-static 0.0.0.0 0.0.0.0 10.0.0.2',
      'ip route-static 0.0.0.0 0.0.0.0 10.0.0.6 preference 200',
      'ip route-static 0.0.0.0 0.0.0.0 GigabitEthernet0/0/1',
      'ip route-static 192.168.50.0 24 10.0.0.2 description BRANCH-A',
      'ip route-static 192.168.51.0 24 10.0.0.2 preference 250 tag 100',
      'ip route-static 192.168.52.0 24 NULL0',
      'ip route-static 192.168.53.0 24 10.0.0.2 track nqa admin test1',
      'ip route-static vpn-instance VRF1 192.168.60.0 24 10.0.0.2',
      'ip route-static 192.168.99.0 24 10.0.0.2 permanent',
      'return',
      'display ip routing-table',
      'display ip routing-table 0.0.0.0',

      { section: 'IPv6 static', cmd: 'system-view' },
      'ipv6',
      'ipv6 route-static 2001:db8:2:: 64 2001:db8:1::2',
      'ipv6 route-static :: 0 2001:db8:1::2',
      'ipv6 route-static 2001:db8:3:: 64 GigabitEthernet0/0/1',
      'ipv6 route-static 2001:db8:5:: 64 NULL0 preference 250',
      'return',
      'display ipv6 routing-table',
      'display ipv6 routing-table protocol static',

      { section: 'ip-prefix lists', cmd: 'system-view' },
      ...sweep(15, (i) =>
        `ip ip-prefix PL-IN index ${i * 10} permit 10.${i}.0.0 16 less-equal 24`),
      'ip ip-prefix PL-IN index 200 deny 0.0.0.0 0',
      'ip ip-prefix PL-OUT permit 192.168.0.0 16 greater-equal 24',
      'ip ipv6-prefix V6PL index 10 permit 2001:db8:: 32 less-equal 64',
      'undo ip ip-prefix PL-IN index 10',
      'return',
      'display ip ip-prefix',
      'display ip ip-prefix PL-IN',
      'display ip ipv6-prefix',

      { section: 'route-policy', cmd: 'system-view' },
      ...sweep(6, (i) => [
        `route-policy RP permit node ${i * 10}`,
        `if-match ip-prefix PL-IN`,
        `if-match acl 2000`,
        `if-match interface GigabitEthernet0/0/0`,
        `apply ip-address next-hop 10.0.0.${i + 1}`,
        `apply cost ${i * 10}`,
        i === 1 ? 'apply preference 100' : 'apply tag 200',
        'quit',
      ]),
      'route-policy RP deny node 100',
      'quit',
      'acl 2000',
      'rule 5 permit source 192.168.1.0 0.0.0.255',
      'quit',
      'return',
      'display route-policy',
      'display route-policy RP',

      { section: 'policy-based routing', cmd: 'system-view' },
      'acl 3000',
      'rule 5 permit ip source 192.168.1.0 0.0.0.255',
      'quit',
      'traffic classifier C1',
      'if-match acl 3000',
      'quit',
      'traffic behavior B1',
      'redirect ip-nexthop 10.0.0.2',
      'quit',
      'traffic policy TP1',
      'classifier C1 behavior B1',
      'quit',
      'interface GigabitEthernet0/0/0',
      'traffic-policy TP1 inbound',
      'quit',
      'return',
      'display traffic policy user-defined',
      'display traffic-policy applied-record',

      { section: 'NQA', cmd: 'system-view' },
      'nqa test-instance admin test1',
      'test-type icmp',
      'destination-address ipv4 10.0.0.2',
      'frequency 10',
      'probe-count 3',
      'start now',
      'quit',
      'return',
      'display nqa results test-instance admin test1',
      ...each([
        'display ip routing-table', 'display ip routing-table protocol static',
        'display ip routing-table protocol direct',
        'display ip routing-table verbose', 'display fib',
        'display ip routing-table limit', 'display router id',
      ], (c) => c),

      ...regressionSweep('huawei'),
    ];
    await dumpRouter('huawei-router-static-routing', topology, steps,
      'focus=VRP static/default/IPv6, ip-prefix, route-policy, PBR, NQA',
      { resyncVendor: 'huawei' });
  }, 120000);
});
