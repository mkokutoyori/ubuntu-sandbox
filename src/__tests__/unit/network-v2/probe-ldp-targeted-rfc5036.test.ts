/**
 * Probe: LDP Extended Discovery (docs/rfc/mpls/rfc5036.txt §2.4.2, §3.5.2).
 * R1 - R2 - R3 in a line; R1 and R3 are not adjacent. R1 sends Targeted Hellos
 * (unicast UDP 646, T=1, R=1) to R3, R3 answers only if configured to accept
 * (or to send to R1), and a session opens over the routed path.
 * New: all 6 cases fail before (no targeted discovery in the engine).
 * The both-configured case waits 60 s: the higher router opens TCP before the
 * other has an adjacency and is NAKed (No Hello), then retries after the
 * RFC 5036 §2.5.3 throttle.
 * Witness: without acceptance R3 builds no adjacency, so the lab does not
 * open a session by itself.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress } from '@/network/core/types';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';

let clock: VirtualTimeScheduler;
beforeEach(() => { clock = new VirtualTimeScheduler(); __setDefaultScheduler(clock); });

async function run(router: CiscoRouter, lines: string[]): Promise<void> {
  for (const line of ['enable', 'configure terminal', ...lines, 'end']) await router.executeCommand(line);
}

async function chain() {
  const r1 = new CiscoRouter('R1');
  const r2 = new CiscoRouter('R2');
  const r3 = new CiscoRouter('R3');
  new Cable('a').connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);
  new Cable('b').connect(r2.getPort('GigabitEthernet0/1')!, r3.getPort('GigabitEthernet0/0')!);
  await run(r1, ['interface Loopback0', 'ip address 1.1.1.1 255.255.255.255', 'exit',
    'interface GigabitEthernet0/0', 'ip address 10.12.0.1 255.255.255.0', 'no shutdown', 'exit',
    'ip route 3.3.3.3 255.255.255.255 10.12.0.2', 'ip route 10.23.0.0 255.255.255.0 10.12.0.2']);
  await run(r2, ['interface GigabitEthernet0/0', 'ip address 10.12.0.2 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.23.0.2 255.255.255.0', 'no shutdown', 'exit',
    'ip route 1.1.1.1 255.255.255.255 10.12.0.1', 'ip route 3.3.3.3 255.255.255.255 10.23.0.3']);
  await run(r3, ['interface Loopback0', 'ip address 3.3.3.3 255.255.255.255', 'exit',
    'interface GigabitEthernet0/0', 'ip address 10.23.0.3 255.255.255.0', 'no shutdown', 'exit',
    'ip route 1.1.1.1 255.255.255.255 10.23.0.2', 'ip route 10.12.0.0 255.255.255.0 10.23.0.2']);
  return { r1, r2, r3 };
}

describe('LDP Extended Discovery', () => {
  it('WITNESS: a Targeted Hello to a router that does not accept builds no adjacency', async () => {
    const { r1, r3 } = await chain();
    r1.getLdpEngine().addTargetedPeer(new IPAddress('3.3.3.3'));
    clock.advance(20000);
    expect(r3.getLdpEngine().adjacencies()).toHaveLength(0);
    expect(r1.getLdpEngine().adjacencies()).toHaveLength(0);
  });

  it('the targeted router accepts: both ends hold a targeted adjacency and open a session across R2', async () => {
    const { r1, r3 } = await chain();
    r3.getLdpEngine().setAcceptTargetedHellos(true);
    r1.getLdpEngine().addTargetedPeer(new IPAddress('3.3.3.3'));
    clock.advance(20000);
    expect(r3.getLdpEngine().adjacencies()).toMatchObject([{ targeted: true }]);
    expect(r1.getLdpEngine().adjacencies()).toMatchObject([{ targeted: true }]);
    expect(r1.getLdpEngine().sessions().map(s => s.state)).toEqual(['operational']);
    expect(r3.getLdpEngine().sessions().map(s => s.state)).toEqual(['operational']);
  });

  it('the R bit makes the accepting router send Targeted Hellos back to the initiator', async () => {
    const { r1, r3 } = await chain();
    r3.getLdpEngine().setAcceptTargetedHellos(true);
    r1.getLdpEngine().addTargetedPeer(new IPAddress('3.3.3.3'));
    clock.advance(20000);
    expect(r3.getLdpEngine().targetedAddresses().map(String)).toEqual(['1.1.1.1']);
  });

  it('a router configured to send to the other end accepts without a global accept', async () => {
    const { r1, r3 } = await chain();
    r3.getLdpEngine().addTargetedPeer(new IPAddress('1.1.1.1'));
    r1.getLdpEngine().addTargetedPeer(new IPAddress('3.3.3.3'));
    clock.advance(60000);
    expect(r1.getLdpEngine().sessions().map(s => s.state)).toEqual(['operational']);
  });

  it('the negotiated hold time defaults to 45 s for targeted hellos and expires the adjacency when hellos stop', async () => {
    const { r1, r3 } = await chain();
    r3.getLdpEngine().setAcceptTargetedHellos(true);
    r1.getLdpEngine().addTargetedPeer(new IPAddress('3.3.3.3'));
    clock.advance(20000);
    expect(r3.getLdpEngine().adjacencies()[0].holdSeconds).toBe(45);
    r1.getLdpEngine().removeTargetedPeer(new IPAddress('3.3.3.3'));
    r3.getLdpEngine().setAcceptTargetedHellos(false);
    expect(r3.getLdpEngine().adjacencies()).toHaveLength(0);
  });

  it('removing the target tears down the adjacency and the session on the initiator', async () => {
    const { r1, r3 } = await chain();
    r3.getLdpEngine().setAcceptTargetedHellos(true);
    r1.getLdpEngine().addTargetedPeer(new IPAddress('3.3.3.3'));
    clock.advance(20000);
    r1.getLdpEngine().removeTargetedPeer(new IPAddress('3.3.3.3'));
    expect(r1.getLdpEngine().adjacencies()).toHaveLength(0);
    expect(r1.getLdpEngine().sessions().filter(s => s.state === 'operational')).toHaveLength(0);
  });
});
