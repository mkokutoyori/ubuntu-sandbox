/**
 * NetFlow really exports.
 *
 * `ip flow-export destination` was accepted, stored, wired all the way
 * to the agent's collector list, and `show ip flow export` answered
 * "Flow export v5 is enabled / Destination 10.0.2.50:9996" — while no
 * datagram ever left. Flows WERE cached (four of them for two pings),
 * so only the last step was missing.
 *
 * The cause is one line, and it is a rule this repo already wrote down
 * for STP: `ageOut()` compared against `Date.now()` while its timer
 * runs on the injected scheduler. Under a virtual clock wall time never
 * moves, so no flow ever reached its inactive timeout and nothing was
 * shipped. Every stamp now comes from `nowMs()`, the scheduler's.
 *
 * One earlier reading of mine was wrong and worth recording: checking
 * immediately after the pings proves nothing, because export is driven
 * by expiry rather than by the packet. (A second guess — that traffic
 * addressed to the router itself would not be sampled — turned out to
 * be false when measured, so it is not asserted here.)
 */

import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, IPv4Packet, UDPPacket } from '@/network/core/types';
import type { Equipment } from '@/network/equipment/Equipment';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';

const cfg = async (r: CiscoRouter, lines: string[]): Promise<string[]> => {
  const out: string[] = [];
  for (const l of lines) out.push(await r.executeCommand(l));
  return out;
};

/** Transit traffic across the router, with a collector on a third leg. */
async function lab(options: { exportTo?: boolean } = {}): Promise<{
  r: CiscoRouter; a: LinuxPC; clock: VirtualTimeScheduler; outputs: string[];
}> {
  const clock = new VirtualTimeScheduler();
  __setDefaultScheduler(clock);
  const r = new CiscoRouter('R1');
  const a = new LinuxPC('A');
  const b = new LinuxPC('B');
  const collector = new LinuxPC('COL');
  a.powerOn(); b.powerOn(); collector.powerOn();
  new Cable('x').connect(r.getPort('GigabitEthernet0/0')!, a.getPort('eth0')!);
  new Cable('y').connect(r.getPort('GigabitEthernet0/1')!, b.getPort('eth0')!);
  new Cable('z').connect(r.getPort('GigabitEthernet0/2')!, collector.getPort('eth0')!);
  a.configureInterface('eth0', new IPAddress('10.0.0.10'), new SubnetMask('255.255.255.0'));
  b.configureInterface('eth0', new IPAddress('10.0.1.10'), new SubnetMask('255.255.255.0'));
  collector.configureInterface('eth0', new IPAddress('10.0.2.50'), new SubnetMask('255.255.255.0'));
  await a.executeCommand('ip route add default via 10.0.0.1');
  await b.executeCommand('ip route add default via 10.0.1.1');

  const outputs = await cfg(r, [
    'enable', 'configure terminal', 'ip routing',
    'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown',
    'ip flow ingress', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.0.1.1 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/2', 'ip address 10.0.2.1 255.255.255.0', 'no shutdown', 'exit',
    ...(options.exportTo === false ? [] : [
      'ip flow-export destination 10.0.2.50 9996', 'ip flow-export version 5',
    ]),
    'end',
  ]);
  return { r, a, clock, outputs };
}

/** The UDP datagrams actually sent to the collector's port. */
function observeExports(source: Equipment): Array<{ dst: string }> {
  const seen: Array<{ dst: string }> = [];
  source.attachCapture(({ direction, frame }) => {
    if (direction !== 'out') return;
    const ip = frame.payload as IPv4Packet | undefined;
    if (ip?.type !== 'ipv4') return;
    const udp = ip.payload as UDPPacket | undefined;
    if (udp?.type === 'udp' && udp.destinationPort === 9996) {
      seen.push({ dst: ip.destinationIP.toString() });
    }
  });
  return seen;
}

describe('a cached flow eventually leaves', () => {
  it('nothing before the inactive timeout, a datagram after', async () => {
    const { a, clock, r } = await lab();
    const exports = observeExports(r);
    await clock.advanceUntilSettled(a.executeCommand('ping -c 2 10.0.1.10'));
    // Export is driven by expiry, not by the packet: checking here is
    // what made an earlier reading of mine conclude "nothing exports".
    expect(exports.length).toBe(0);

    clock.advance(60_000);
    await new Promise((r) => setTimeout(r, 0));
    expect(exports.length).toBeGreaterThan(0);
  });

  it('and it goes to the configured collector', async () => {
    const { a, clock, r } = await lab();
    const exports = observeExports(r);
    await clock.advanceUntilSettled(a.executeCommand('ping -c 2 10.0.1.10'));
    clock.advance(60_000);
    await new Promise((r) => setTimeout(r, 0));
    expect(exports.length).toBeGreaterThan(0);
    expect(exports.every((e) => e.dst === '10.0.2.50')).toBe(true);
  });
});

describe('what does not export', () => {
  it('no destination configured, no datagram', async () => {
    const { a, clock, r } = await lab({ exportTo: false });
    const exports = observeExports(r);
    await clock.advanceUntilSettled(a.executeCommand('ping -c 2 10.0.1.10'));
    clock.advance(60_000);
    await new Promise((r) => setTimeout(r, 0));
    expect(exports).toEqual([]);
  });

  it('a flow names the endpoints that crossed, not the router', async () => {
    const flows: Array<{ src: string; dst: string }> = [];
    const { a, clock, r } = await lab();
    r.getBus().subscribe('netflow.flow.recorded', (e) => {
      const p = e.payload as { sourceIp: string; destinationIp: string };
      flows.push({ src: p.sourceIp, dst: p.destinationIp });
    });
    await clock.advanceUntilSettled(a.executeCommand('ping -c 2 10.0.1.10'));
    expect(flows.length).toBeGreaterThan(0);
    expect(flows.some((f) => f.src === '10.0.0.10' && f.dst === '10.0.1.10')).toBe(true);
  });
});

describe('the view agrees with the wire', () => {
  it('show ip flow export names the destination it really uses', async () => {
    const { r } = await lab();
    const view = await r.executeCommand('show ip flow export');
    expect(view).toContain('Destination 10.0.2.50:9996');
  });
});
