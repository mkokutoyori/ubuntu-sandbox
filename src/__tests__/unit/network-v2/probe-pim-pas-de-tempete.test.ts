/**
 * PIM: neither the BSR exchange nor a (*,G) Join may loop on the wire.
 *
 * Measured with a capture of a lab (two routers on a hub, R1 the BSR, R2 the candidate RP at 10.0.0.2, a (*,G) joined on R1):
 * the Bootstrap and the Candidate-RP-Advertisement answered each other thirteen times in one tick (a BSR re-originated its
 * Bootstrap on every advertisement it heard, and a candidate re-advertised on every Bootstrap), and then the Join / Prune
 * messages of R1 and R2 answered each other (R2, the rendezvous point itself, chose R1 as the upstream neighbour towards
 * itself). Only the re-entrancy guard of the sender cut both loops short.
 *
 * Probe discriminated with `git stash push -- src/network`: both cases fall before the change, 65 Bootstrap messages in five simulated
 * seconds where at most 3 are expected, and 65 Join messages where at most 1 is. Inside each case the first assertions are WITNESSES that
 * the lab itself is sound and hold either way: R1 learns the RP 10.0.0.2, and R2 learns the output interface of the Join.
 */
import { describe, expect, it } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { installVirtualClock } from '../../support/ntpTime';
import { IPAddress, SubnetMask, type EthernetFrame, type IPv4Packet } from '@/network/core/types';
import type { PimPacket } from '@/network/pim/types';
import { IP_PROTO_PIM } from '@/network/pim/types';

interface Counts { bootstrap: number; candidate: number; joinR1: number; joinR2: number }

function countPim(port: { attachTap(tap: (event: { direction: string; frame: EthernetFrame }) => void): unknown }, onMessage: (message: PimPacket) => void): void {
  port.attachTap(({ direction, frame }) => {
    if (direction !== 'out') return;
    const packet = frame.payload as IPv4Packet | undefined;
    if (packet?.type !== 'ipv4' || packet.protocol !== IP_PROTO_PIM) return;
    const message = packet.payload as PimPacket;
    if (message?.type === 'pim') onMessage(message);
  });
}

async function lab(): Promise<{ counts: Counts; r1: CiscoRouter; r2: CiscoRouter; advance: (ms: number) => Promise<void> }> {
  const clock = installVirtualClock();
  const switchDevice = new CiscoSwitch('switch-cisco', 'SW', 4);
  const r1 = new CiscoRouter('R1');
  const r2 = new CiscoRouter('R2');
  new Cable('a').connect(r1.getPort('GigabitEthernet0/0')!, switchDevice.getPort('FastEthernet0/1')!);
  new Cable('b').connect(r2.getPort('GigabitEthernet0/0')!, switchDevice.getPort('FastEthernet0/2')!);
  r1.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  r2.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  r1.getPort('GigabitEthernet0/1')!.configureIP(new IPAddress('192.168.1.1'), new SubnetMask('255.255.255.0'));
  const counts: Counts = { bootstrap: 0, candidate: 0, joinR1: 0, joinR2: 0 };
  countPim(r1.getPort('GigabitEthernet0/0')!, (message) => {
    if (message.messageType === 'bootstrap') counts.bootstrap++;
    if (message.messageType === 'join-prune') counts.joinR1++;
  });
  countPim(r2.getPort('GigabitEthernet0/0')!, (message) => {
    if (message.messageType === 'candidate-rp-advertisement') counts.candidate++;
    if (message.messageType === 'join-prune') counts.joinR2++;
  });
  for (const router of [r1, r2]) {
    for (const line of ['enable', 'configure terminal', 'interface GigabitEthernet0/0', 'ip pim sparse-mode', 'end']) await router.executeCommand(line);
  }
  await r1.executeCommand('configure terminal');
  await r1.executeCommand('interface GigabitEthernet0/1');
  await r1.executeCommand('ip pim sparse-mode');
  await r1.executeCommand('exit');
  await r1.executeCommand('ip pim bsr-candidate GigabitEthernet0/0 30 100');
  await r1.executeCommand('end');
  for (const line of ['configure terminal', 'ip pim rp-candidate GigabitEthernet0/0 priority 10', 'end']) await r2.executeCommand(line);
  return { counts, r1, r2, advance: async (ms) => { await clock.advance(ms); } };
}

describe('PIM does not loop on the wire', () => {
  it('a Bootstrap and a Candidate-RP-Advertisement are not answered by each other', async () => {
    const { counts, r1, advance } = await lab();
    await advance(5_000);
    expect(r1.getPimAgent().resolveRpForGroup('239.1.1.1')).toBe('10.0.0.2');
    expect(counts.bootstrap).toBeLessThanOrEqual(3);
    expect(counts.candidate).toBeLessThanOrEqual(2);
  });

  it('a (*,G) Join goes upstream once and the rendezvous point sends none', async () => {
    const { counts, r1, r2, advance } = await lab();
    await advance(5_000);
    const before = { r1: counts.joinR1, r2: counts.joinR2 };
    r1.getPimAgent().joinGroup('239.1.1.1', 'GigabitEthernet0/1');
    await advance(1_000);
    expect(r2.getPimAgent().getMroute('239.1.1.1')?.outgoingInterfaces.has('GigabitEthernet0/0')).toBe(true);
    expect(counts.joinR1 - before.r1).toBeLessThanOrEqual(1);
    expect(counts.joinR2 - before.r2).toBe(0);
  });
});
