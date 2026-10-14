/**
 * Cisco IOS Security Command Reference (official_docs/cisco/ios-security, Commands A to C and S to Z):
 * `crypto ipsec security-association replay window-size [N]` (64, 128, 256, 512 or 1024),
 * `crypto ipsec security-association replay disable`, `crypto ipsec security-association idle-time
 * seconds` (60 to 86400) and `show crypto ipsec security-association idle-time`.
 *
 *   replay disable   anti-replay checking is off for the SAs created afterwards
 *   idle-time        the SAs of a peer that exchanged no traffic for that long are deleted; when the
 *                    last IPsec SA to the peer goes, the IKE SA goes with it
 *
 * Lab: ipsecLab, with a virtual clock. Replays are real: an ESP datagram received by R1 is captured
 * on the wire and delivered again to the same port. The idle timer is observed on the wire as well:
 * once the SAs are gone the next ping has to run IKE again, which the tap counts on UDP/500.
 *
 * Measured with src stashed to HEAD: `replay disable`, `idle-time` and the show are refused, a window
 * of 8 or 0 is accepted, and the idle-time stub of config-tfset swallowed its argument, so 6 of the 9
 * cases fall. Three pass either way: the witness (an enabled window counts a replayed datagram),
 * "an SA that keeps carrying traffic is not deleted" and "without the timer an idle SA stays until
 * its lifetime" (without an idle timer nothing deletes an SA).
 *
 * The idle timer also exposed that the router never started its IPsec engine, so the maintenance
 * timer (IKE SA lifetime recheck, DPD check, idle sweep) never ran; the engine is now started when
 * it is created.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { installVirtualClock } from '@/__tests__/support/ntpTime';
import type { VirtualTimeScheduler } from '@/events/Scheduler';
import { ipsecLab, captureInbound, countIke } from './_helpers/ipsecLab';

let clock: VirtualTimeScheduler;

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  clock = installVirtualClock();
});

function replayFailures(output: string): number {
  const match = /#pkts replay failed \(rcv\):\s*(\d+)/.exec(output);
  return match ? Number(match[1]) : -1;
}

async function replayThree(lab: Awaited<ReturnType<typeof ipsecLab>>): Promise<number> {
  const inbound = captureInbound(lab);
  await clock.advanceUntilSettled(lab.pc2.executeCommand('ping -c 2 192.168.1.10'));
  const before = replayFailures(await lab.r1.executeCommand('show crypto ipsec sa'));
  const port = lab.r1.getPort('GigabitEthernet0/1')!;
  for (let i = 0; i < 3; i++) port.receiveFrame(inbound[0]);
  return replayFailures(await lab.r1.executeCommand('show crypto ipsec sa')) - before;
}

describe('crypto ipsec security-association replay', () => {
  it('witness: with the window enabled a replayed datagram is counted', async () => {
    const lab = await ipsecLab();
    expect(await replayThree(lab)).toBe(3);
  });

  it('replay disable: replayed datagrams are no longer rejected', async () => {
    const lab = await ipsecLab(['crypto ipsec security-association replay disable']);
    expect(await replayThree(lab)).toBe(0);
  });

  it('only 64, 128, 256, 512 and 1024 are windows; the others are refused', async () => {
    const lab = await ipsecLab();
    await lab.r1.executeCommand('configure terminal');
    for (const refused of ['8', '0', '100', '2048']) {
      expect(await lab.r1.executeCommand(`crypto ipsec security-association replay window-size ${refused}`)).toContain('Invalid input');
    }
    expect(await lab.r1.executeCommand('crypto ipsec security-association replay window-size 128')).toBe('');
    expect(await lab.r1.executeCommand('show running-config')).toMatch(/^crypto ipsec security-association replay window-size 128$/m);
  });

  it('window-size without a value restores 64 and the no forms leave the configuration clean', async () => {
    const lab = await ipsecLab([
      'crypto ipsec security-association replay window-size 256',
      'crypto ipsec security-association replay window-size',
      'crypto ipsec security-association replay disable',
      'crypto ipsec security-association idle-time 300',
    ]);
    let config = await lab.r1.executeCommand('show running-config');
    expect(config).not.toContain('replay window-size');
    expect(config).toMatch(/^crypto ipsec security-association replay disable$/m);
    expect(config).toMatch(/^crypto ipsec security-association idle-time 300$/m);
    await lab.r1.executeCommand('configure terminal');
    await lab.r1.executeCommand('no crypto ipsec security-association replay disable');
    await lab.r1.executeCommand('no crypto ipsec security-association idle-time');
    config = await lab.r1.executeCommand('show running-config');
    expect(config).not.toContain('security-association replay');
    expect(config).not.toContain('idle-time');
  });
});

describe('crypto ipsec security-association idle-time', () => {
  it('the range is 60 to 86400 seconds', async () => {
    const lab = await ipsecLab();
    await lab.r1.executeCommand('configure terminal');
    expect(await lab.r1.executeCommand('crypto ipsec security-association idle-time 59')).toContain('Invalid input');
    expect(await lab.r1.executeCommand('crypto ipsec security-association idle-time 86401')).toContain('Invalid input');
    expect(await lab.r1.executeCommand('crypto ipsec security-association idle-time 60')).toBe('');
  });

  it('an idle peer loses its IPsec SAs and its IKE SA, and the next packet negotiates again on the wire', async () => {
    const lab = await ipsecLab(['crypto ipsec security-association idle-time 120']);
    const ike = countIke(lab);
    expect(await clock.advanceUntilSettled(lab.pc1.executeCommand('ping -c 1 192.168.2.10'))).toContain('1 received');
    expect(await lab.r1.executeCommand('show crypto isakmp sa')).toContain('10.0.12.2');
    const negotiated = ike.count;
    expect(negotiated).toBeGreaterThan(0);
    await clock.advance(119_000);
    expect(await lab.r1.executeCommand('show crypto isakmp sa')).toContain('10.0.12.2');
    await clock.advance(5_000);
    expect(await lab.r1.executeCommand('show crypto isakmp sa')).not.toContain('10.0.12.2');
    expect(await lab.r1.executeCommand('show crypto ipsec sa')).not.toContain('#pkts encaps: 1');
    expect(await clock.advanceUntilSettled(lab.pc1.executeCommand('ping -c 1 192.168.2.10'))).toContain('1 received');
    expect(ike.count).toBeGreaterThan(negotiated);
  });

  it('an SA that keeps carrying traffic is not deleted', async () => {
    const lab = await ipsecLab(['crypto ipsec security-association idle-time 120']);
    const ike = countIke(lab);
    expect(await clock.advanceUntilSettled(lab.pc1.executeCommand('ping -c 1 192.168.2.10'))).toContain('1 received');
    const negotiated = ike.count;
    for (let i = 0; i < 4; i++) {
      await clock.advance(100_000);
      expect(await clock.advanceUntilSettled(lab.pc1.executeCommand('ping -c 1 192.168.2.10'))).toContain('1 received');
    }
    expect(ike.count).toBe(negotiated);
    expect(await lab.r1.executeCommand('show crypto isakmp sa')).toContain('10.0.12.2');
  });

  it('without the timer an idle SA stays until its lifetime', async () => {
    const lab = await ipsecLab();
    expect(await clock.advanceUntilSettled(lab.pc1.executeCommand('ping -c 1 192.168.2.10'))).toContain('1 received');
    await clock.advance(1_800_000);
    expect(await lab.r1.executeCommand('show crypto isakmp sa')).toContain('10.0.12.2');
  });

  it('show crypto ipsec security-association idle-time prints the configured value', async () => {
    const lab = await ipsecLab(['crypto ipsec security-association idle-time 567']);
    expect(await lab.r1.executeCommand('show crypto ipsec security-association idle-time'))
      .toBe('Security association idletime: 567 seconds');
  });
});
