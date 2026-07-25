/**
 * EIGRP had no port-down hook at all (unlike OSPF's), so a dead
 * neighbor/route lingered in the RIB until an operator happened to run a
 * CLI command afterward — `eigrp-wire.test.ts`'s own cut-cable test
 * relies on exactly that ("the next hello round, triggered by the show,
 * hears nothing back"). This does not add real EIGRP timers/DUAL
 * Active-state machinery (see CLAUDE.md) — it only makes the existing
 * CLI-triggered recompute also run on link events, closing the "nothing
 * reconverges without a CLI command" gap (rapport 02 audit, item #39).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function configure(r: CiscoRouter, cmds: string[]) {
  await r.executeCommand('enable');
  await r.executeCommand('configure terminal');
  for (const c of cmds) await r.executeCommand(c);
  await r.executeCommand('end');
}

const ifaceCmds = (name: string, ip: string, mask = '255.255.255.0') => [
  `interface ${name}`, `ip address ${ip} ${mask}`, 'no shutdown', 'exit',
];

describe('EIGRP autonomous link failure reaches the RIB with no CLI command in between', () => {
  it('a cut cable removes the learned route from the raw RIB immediately, before any show/CLI is run', async () => {
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const cable = new Cable('wan');
    cable.connect(r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/1')!);

    for (const [r, lan] of [[r1, '192.168.1.1'], [r2, '192.168.2.1']] as const) {
      await configure(r, [
        ...ifaceCmds('GigabitEthernet0/0', lan),
        ...ifaceCmds('GigabitEthernet0/1', r === r1 ? '10.0.0.1' : '10.0.0.2'),
        'router eigrp 100',
        'network 192.168.0.0 0.0.255.255',
        'network 10.0.0.0 0.0.0.255',
      ]);
    }

    // Establish the initial adjacency/route the same way eigrp-wire.test.ts
    // does: a `show` triggers the first convergence round.
    await r1.executeCommand('show ip eigrp neighbors');

    const hasEigrpRouteTo192168_2 = () =>
      r1.getRoutingTable().some(
        (route) => route.type === 'eigrp' && route.network.toString() === '192.168.2.0',
      );
    expect(hasEigrpRouteTo192168_2()).toBe(true);

    // No CLI command runs after this — the raw RIB storage (not `show ip
    // route`, which triggers its own convergence pass as a side effect)
    // must already reflect the failure.
    cable.disconnect();

    expect(hasEigrpRouteTo192168_2()).toBe(false);
  });
});
