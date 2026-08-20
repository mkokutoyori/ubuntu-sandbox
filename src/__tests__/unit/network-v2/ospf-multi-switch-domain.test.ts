/**
 * OSPF domain collection across a chain of switches (rapport 00
 * synthesis item #23 — factoring the duplicated topology-BFS pattern
 * surfaced this bug for free: `collectOSPFDomain`/`collectOSPFv3Domain`/
 * `collectV3CandidateRouters` only traversed one hop of switch fan-out,
 * so from either router's own perspective, a router two switches away
 * (R1—SW1—SW2—R2) was never found in `allPeers`.
 *
 * The two protocols are affected very differently, verified via
 * git-stash comparison against the pre-fix code:
 *   - OSPFv2's physical adjacency is real-packet-driven (`pumpHellos`
 *     sends a genuine Hello, `processHello`/`processDD` react to
 *     genuine received frames) — so even though R1's own `allPeers`
 *     never included R2, R1 still sends its OWN Hello out its own
 *     interface, which really floods through SW1 and SW2 to R2 (switch
 *     forwarding has nothing to do with this BFS), R2 really replies,
 *     and the exchange self-heals. The OSPFv2 case below therefore
 *     PASSES even without this fix — it locks in that this resilience
 *     still holds, it doesn't prove the fix (see topology-walk.test.ts
 *     and ospf-multi-switch-domain's OSPFv3 case for that).
 *   - OSPFv3 adjacency (`v3FormAdjacency`) is formed entirely
 *     out-of-band — no real Hello/DD packets are exchanged for v3 at
 *     all — so it has no such fallback: it genuinely never formed an
 *     adjacency across a switch chain before this fix, confirmed FAILING
 *     pre-fix and PASSING post-fix.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

describe('OSPFv2 — domain collection across a chain of switches', () => {
  it('two routers separated by SW1—SW2 form an adjacency and see each other as neighbors (real Hello propagation is resilient to the domain-collection bug — see file header)', async () => {
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const sw1 = new CiscoSwitch('switch-cisco', 'SW1', 24);
    const sw2 = new CiscoSwitch('switch-cisco', 'SW2', 24);

    for (const [r, ip, rid] of [[r1, '192.168.1.1', '1.1.1.1'], [r2, '192.168.1.2', '2.2.2.2']] as const) {
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('interface GigabitEthernet0/0');
      await r.executeCommand(`ip address ${ip} 255.255.255.0`);
      await r.executeCommand('no shutdown');
      await r.executeCommand('exit');
      await r.executeCommand('router ospf 1');
      await r.executeCommand(`router-id ${rid}`);
      await r.executeCommand('network 192.168.1.0 0.0.0.255 area 0');
      await r.executeCommand('end');
    }

    // R1 -- SW1 -- SW2 -- R2: two chained switches between the routers.
    new Cable('c-r1-sw1').connect(r1.getPort('GigabitEthernet0/0')!, sw1.getPort('FastEthernet0/1')!);
    new Cable('c-sw1-sw2').connect(sw1.getPort('FastEthernet0/2')!, sw2.getPort('FastEthernet0/1')!);
    new Cable('c-sw2-r2').connect(sw2.getPort('FastEthernet0/2')!, r2.getPort('GigabitEthernet0/0')!);

    const neighR1 = await r1.executeCommand('show ip ospf neighbor');
    expect(neighR1).toContain('2.2.2.2');

    const neighR2 = await r2.executeCommand('show ip ospf neighbor');
    expect(neighR2).toContain('1.1.1.1');
  });
});

describe('OSPFv3 — domain collection across a chain of switches', () => {
  it('two routers separated by SW1—SW2 form an OSPFv3 adjacency', async () => {
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const sw1 = new CiscoSwitch('switch-cisco', 'SW1', 24);
    const sw2 = new CiscoSwitch('switch-cisco', 'SW2', 24);

    for (const [r, rid, suffix] of [[r1, '1.1.1.1', '1'], [r2, '2.2.2.2', '2']] as const) {
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('ipv6 unicast-routing');
      await r.executeCommand('interface GigabitEthernet0/0');
      await r.executeCommand(`ipv6 address 2001:db8:1::${suffix}/64`);
      await r.executeCommand('no shutdown');
      await r.executeCommand('exit');
      await r.executeCommand('ipv6 router ospf 1');
      await r.executeCommand(`router-id ${rid}`);
      await r.executeCommand('exit');
      await r.executeCommand('interface GigabitEthernet0/0');
      await r.executeCommand('ipv6 ospf 1 area 0');
      await r.executeCommand('end');
    }

    new Cable('c-r1-sw1').connect(r1.getPort('GigabitEthernet0/0')!, sw1.getPort('FastEthernet0/1')!);
    new Cable('c-sw1-sw2').connect(sw1.getPort('FastEthernet0/2')!, sw2.getPort('FastEthernet0/1')!);
    new Cable('c-sw2-r2').connect(sw2.getPort('FastEthernet0/2')!, r2.getPort('GigabitEthernet0/0')!);

    const neighR1 = await r1.executeCommand('show ipv6 ospf neighbor');
    expect(neighR1).toContain('2.2.2.2');
  });
});
