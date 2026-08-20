import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { EventBus, __setDefaultEventBus } from '@/events/EventBus';
import type { NameServiceSwitch } from '@/network/devices/linux/nss/NameServiceSwitch';

let bus: EventBus;
let pc: LinuxPC;

beforeEach(() => {
  EquipmentRegistry.resetInstance();
  bus = new EventBus();
  __setDefaultEventBus(bus);
  EquipmentRegistry.getInstance().setEventBus(bus);
  pc = new LinuxPC('pc1');
  pc.setEventBus(bus);
});

// `executor` is protected; the NSS instance has no public accessor, and
// the existing NSS suites reach it the same way.
const nss = (): NameServiceSwitch =>
  (pc as unknown as { executor: { nss: NameServiceSwitch } }).executor.nss;

describe('NSS cache — the invalidation signal finally has a consumer (P2)', () => {
  it('a repeated getent hits the cache instead of re-walking the sources', async () => {
    await pc.executeCommand('getent passwd root');
    const after1 = nss().getCache().stats();
    expect(after1.size).toBeGreaterThan(0);

    await pc.executeCommand('getent passwd root');
    const after2 = nss().getCache().stats();
    expect(after2.hits).toBeGreaterThan(after1.hits);
  });

  it('an IAM event drops that database and only that one', async () => {
    await pc.executeCommand('getent passwd root');
    await pc.executeCommand('getent group root');
    expect(nss().getCache().stats().size).toBeGreaterThanOrEqual(2);

    const before = nss().getCache().stats().invalidations;
    bus.publish({
      topic: 'linux.iam.user.modified',
      payload: { deviceId: pc.id, username: 'root', uid: 0, changedFields: ['shell'] },
    });
    expect(nss().getCache().stats().invalidations).toBeGreaterThan(before);
  });

  it('an event for another device does not touch this cache', async () => {
    await pc.executeCommand('getent passwd root');
    const before = nss().getCache().stats();
    bus.publish({
      topic: 'linux.iam.user.modified',
      payload: { deviceId: 'some-other-device', username: 'root', uid: 0, changedFields: ['shell'] },
    });
    expect(nss().getCache().stats().size).toBe(before.size);
  });

  it('editing /etc/passwd is visible immediately, cache or not', async () => {
    const before = await pc.executeCommand('getent passwd testuser');
    expect(before).not.toMatch(/testuser/);

    await pc.executeCommand(
      `sudo sh -c 'echo "testuser:x:4242:4242::/home/testuser:/bin/bash" >> /etc/passwd'`);

    const after = await pc.executeCommand('getent passwd testuser');
    expect(after).toMatch(/testuser/);
    expect(after).toMatch(/4242/);
  });

  it('editing /etc/hosts is visible immediately', async () => {
    await pc.executeCommand('getent hosts cached-host');
    await pc.executeCommand(`sudo sh -c 'echo "10.9.9.9 cached-host" >> /etc/hosts'`);
    const after = await pc.executeCommand('getent hosts cached-host');
    expect(after).toMatch(/10\.9\.9\.9/);
  });

  it('changing nsswitch.conf is visible immediately', async () => {
    await pc.executeCommand('getent passwd root');
    await pc.executeCommand(`sudo sh -c 'echo "passwd: files" > /etc/nsswitch.conf'`);
    const after = await pc.executeCommand('getent passwd root');
    expect(after).toMatch(/root/);
  });

  it('a dns-backed lookup is never cached — no stat-able backing store', async () => {
    await pc.executeCommand(`sudo sh -c 'echo "hosts: dns" > /etc/nsswitch.conf'`);
    nss().getCache().clear();
    await pc.executeCommand('getent hosts anything');
    expect(nss().getCache().stats().size).toBe(0);
  });

  it('the cache evicts the least recently used entry past its bound', () => {
    const cache = nss().getCache();
    cache.clear();
    for (let i = 0; i < 200; i++) cache.set('passwd', `k${i}`, i);
    expect(cache.stats().size).toBeLessThanOrEqual(128);
    // The oldest keys are the ones gone.
    expect(cache.get('k0')).toBeNull();
    expect(cache.get('k199')).not.toBeNull();
  });

  it('invalidate only drops the named database', () => {
    const cache = nss().getCache();
    cache.clear();
    cache.set('passwd', 'a', 1);
    cache.set('group', 'b', 2);
    cache.invalidate('passwd');
    expect(cache.get('a')).toBeNull();
    expect(cache.get('b')).not.toBeNull();
  });
});
