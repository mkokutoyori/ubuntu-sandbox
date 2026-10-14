/**
 * Cisco IOS Security Command Reference (official_docs/cisco/ios-security, Commands M to R):
 * `radius-server load-balance`, `radius-server retry method reorder`,
 * `radius-server transaction max-tries`, and the global server group `radius`.
 *
 *   group radius        the global group holds every `radius-server host`
 *   load-balance        method least-outstanding [batch-size N (default 25)] [ignore-preferred-server]:
 *                       a transaction goes to the server with the fewest outstanding transactions,
 *                       N transactions per batch go to the same server; a transaction of an AAA
 *                       session reuses the session's preferred server unless ignored
 *   retry method reorder  after a failure traffic moves to the next server and STAYS there
 *   transaction max-tries total transmissions per transaction (default 8), meaningful with reorder
 *
 * Lab: shared with the other radius-server probes (a NAS and two RADIUS servers on one switch, real
 * frames); datagrams are counted by taps on the SERVERS' ports, never read from the NAS. Concurrent
 * transactions are real concurrent authentications on a virtual clock.
 *
 * Measured with src stashed to HEAD: `group radius` reached no server at all (the built-in group
 * was accepted by the parser and ignored by the authenticator) and the commands are rejected, so 10
 * of the 12 cases fall, the load-balancing witness included (it goes through `group radius`). Two
 * pass either way: the reorder witness (without reorder every transaction retries the silent first
 * server) and "max-tries means nothing without reorder".
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { installVirtualClock } from '@/__tests__/support/ntpTime';
import { radiusLab, radiusLogin } from './_helpers/radiusAaaLab';
import type { CiscoRouter } from '@/network/devices/CiscoRouter';
import type { VirtualTimeScheduler } from '@/events/Scheduler';

let clock: VirtualTimeScheduler;

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  clock = installVirtualClock();
});

async function concurrentLogins(nas: CiscoRouter, count: number): Promise<boolean[]> {
  const outcomes = await clock.advanceUntilSettled(Promise.all(
    Array.from({ length: count }, () => nas.getAaaAuthenticator().authenticate('alice', 'pw', 'default')),
  ));
  return outcomes.map((o) => o.accepted);
}

describe('the global group radius', () => {
  it('holds every radius-server host, so group radius reaches a server', async () => {
    const { nas, toLive } = await radiusLab([], { group: 'radius' });
    expect(await radiusLogin(clock, nas)).toBe(true);
    expect(toLive.count).toBe(1);
  });
});

describe('radius-server load-balance on the global group', () => {
  const bothUp = { group: 'radius', silentUp: true };

  it('witness: without load balancing every transaction goes to the first server', async () => {
    const { nas, toSilent, toLive } = await radiusLab([], bothUp);
    expect((await concurrentLogins(nas, 4)).every(Boolean)).toBe(true);
    expect([toSilent.count, toLive.count]).toEqual([4, 0]);
  });

  it('batches of N transactions go to the same server, then the least loaded one is taken', async () => {
    const { nas, toSilent, toLive } = await radiusLab(
      ['radius-server load-balance method least-outstanding batch-size 2 ignore-preferred-server'], bothUp);
    expect((await concurrentLogins(nas, 4)).every(Boolean)).toBe(true);
    expect([toSilent.count, toLive.count]).toEqual([2, 2]);
  });

  it('a batch size of 1 alternates between servers while transactions are outstanding', async () => {
    const { nas, toSilent, toLive } = await radiusLab(
      ['radius-server load-balance method least-outstanding batch-size 1 ignore-preferred-server'], bothUp);
    expect((await concurrentLogins(nas, 4)).every(Boolean)).toBe(true);
    expect([toSilent.count, toLive.count]).toEqual([2, 2]);
  });

  it('by default the transactions of one AAA session keep the session server', async () => {
    const { nas, toSilent, toLive } = await radiusLab(
      ['radius-server load-balance method least-outstanding batch-size 1'], bothUp);
    expect((await concurrentLogins(nas, 4)).every(Boolean)).toBe(true);
    expect([toSilent.count, toLive.count]).toEqual([4, 0]);
  });

  it('is rendered, defaults to a batch of 25, and the no form removes it', async () => {
    const { nas } = await radiusLab(['radius-server load-balance method least-outstanding'], bothUp);
    expect(await nas.executeCommand('show running-config'))
      .toContain('radius-server load-balance method least-outstanding batch-size 25');
    await nas.executeCommand('configure terminal');
    await nas.executeCommand('no radius-server load-balance');
    await nas.executeCommand('end');
    expect(await nas.executeCommand('show running-config')).not.toContain('radius-server load-balance');
  });
});

describe('radius-server retry method reorder and transaction max-tries', () => {
  it('witness: without reorder every transaction retries the silent first server', async () => {
    const { nas, toSilent } = await radiusLab(['radius-server retransmit 0']);
    await radiusLogin(clock, nas);
    await radiusLogin(clock, nas);
    expect(toSilent.count).toBe(2);
  });

  it('with reorder traffic moves to the next server and stays there', async () => {
    const { nas, toSilent, toLive } = await radiusLab(['radius-server retransmit 0', 'radius-server retry method reorder']);
    expect(await radiusLogin(clock, nas)).toBe(true);
    expect(await radiusLogin(clock, nas)).toBe(true);
    expect(toSilent.count).toBe(1);
    expect(toLive.count).toBe(2);
  });

  it('max-tries bounds the transmissions of a transaction, cycling through the servers', async () => {
    const { nas, toSilent, toLive } = await radiusLab(
      ['radius-server retransmit 0', 'radius-server retry method reorder', 'radius-server transaction max-tries 6'],
      { liveUp: false });
    expect(await radiusLogin(clock, nas)).toBe(false);
    expect([toSilent.count, toLive.count]).toEqual([3, 3]);
  });

  it('max-tries defaults to eight transmissions', async () => {
    const { nas, toSilent, toLive } = await radiusLab(
      ['radius-server retransmit 0', 'radius-server retry method reorder'], { liveUp: false });
    expect(await radiusLogin(clock, nas)).toBe(false);
    expect([toSilent.count, toLive.count]).toEqual([4, 4]);
  });

  it('max-tries means nothing without reorder: each server is asked once', async () => {
    const { nas, toSilent, toLive } = await radiusLab(
      ['radius-server retransmit 0', 'radius-server transaction max-tries 6'], { liveUp: false });
    expect(await radiusLogin(clock, nas)).toBe(false);
    expect([toSilent.count, toLive.count]).toEqual([1, 1]);
  });

  it('both commands are rendered and the no forms remove them', async () => {
    const { nas } = await radiusLab(['radius-server retry method reorder', 'radius-server transaction max-tries 6']);
    const config = await nas.executeCommand('show running-config');
    expect(config).toContain('radius-server retry method reorder');
    expect(config).toContain('radius-server transaction max-tries 6');
    await nas.executeCommand('configure terminal');
    await nas.executeCommand('no radius-server retry method reorder');
    await nas.executeCommand('no radius-server transaction max-tries');
    await nas.executeCommand('end');
    const after = await nas.executeCommand('show running-config');
    expect(after).not.toContain('retry method reorder');
    expect(after).not.toContain('transaction max-tries');
  });
});
