/**
 * Cisco IOS Security Command Reference (official_docs/cisco/ios-security, Commands D to L):
 * `ip ssh rekey {time minutes | volume kilobytes}` and `ip ssh maxstartups [number]`.
 *
 *   rekey       a session whose key has been used for `time` minutes (10-1440) or for `volume`
 *               kilobytes (100-4194303) starts a new key exchange; `no ip ssh rekey` removes both
 *   maxstartups the number of SSH connections that may be in the start-up (unauthenticated) phase at
 *               once, 2-128 (default 128); one more is closed by the server
 *
 * Lab: a Linux PC and a CiscoRouter on a switch. KEXINIT messages are counted where the SERVER
 * transport emits them, after the PC really opened an SSH session over the cable; the start-up
 * limit is measured on raw TCP connections to port 22 whose close is seen by the PC.
 *
 * Measured with src stashed to HEAD: the commands are rejected, and the router counted start-ups per
 * connection (never accumulated), so the 6 cases that need them
 * fall; the two witnesses (without rekey a session sees only the initial exchange; without the
 * limit a third start-up is accepted) pass either way.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { SshTransport } from '@/network/protocols/ssh/transport/SshTransport';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';
import { openWireSshConnection } from '@/terminal/ssh/wireSshLogin';
import { silentConnectIo } from '@/terminal/ssh/wireSshLogin';
import { isOk } from '@/network/protocols/ssh/Result';
import { IOS_LEGACY_SSH_PREFERENCES } from './iosLegacySsh';
import { configureCiscoSshServer, ROUTER_SSH_USER, ROUTER_SSH_PASSWORD } from './_helpers/routerSshFixtures';

const SSH_MSG_KEXINIT = 20;
let clock: VirtualTimeScheduler;

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  clock = new VirtualTimeScheduler();
  __setDefaultScheduler(clock);
});

afterEach(() => {
  vi.restoreAllMocks();
  __setDefaultScheduler(null);
});

function serverKexInits(): { count: number } {
  const seen = { count: 0 };
  const original = (SshTransport.prototype as unknown as { sendPacket(p: Uint8Array): void }).sendPacket;
  vi.spyOn(SshTransport.prototype as unknown as { sendPacket(p: Uint8Array): void }, 'sendPacket')
    .mockImplementation(function (this: SshTransport, payload: Uint8Array) {
      const role = (this as unknown as { config: { role: 'client' | 'server' } }).config.role;
      if (role === 'server' && payload[0] === SSH_MSG_KEXINIT) seen.count++;
      original.call(this, payload);
    });
  return seen;
}

async function lab(lines: string[]): Promise<{ pc: LinuxPC; router: CiscoRouter }> {
  const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
  const router = new CiscoRouter('cisco1', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  new Cable('c1').connect(pc.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(router.getPorts()[0], sw.getPorts()[1]);
  pc.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  await configureCiscoSshServer(router, '10.0.0.6', '255.255.255.0');
  for (const c of ['enable', 'configure terminal', ...lines, 'end']) await router.executeCommand(c);
  await pc.executeCommand('ping -c 1 10.0.0.6');
  return { pc, router };
}

async function openSession(pc: LinuxPC) {
  const outcome = await openWireSshConnection({
    device: pc, localUser: 'user', user: ROUTER_SSH_USER, host: '10.0.0.6', port: 22,
    io: silentConnectIo(), password: ROUTER_SSH_PASSWORD, strict: 'accept-new', quiet: true,
    algorithms: IOS_LEGACY_SSH_PREFERENCES,
  });
  if (outcome.kind !== 'connected') throw new Error(`ssh did not connect: ${outcome.kind}`);
  return outcome.session;
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

describe('ip ssh rekey', () => {
  it('witness: without rekey a long-lived session sees only the initial key exchange', async () => {
    const kex = serverKexInits();
    const { pc } = await lab([]);
    await openSession(pc);
    clock.advance(2 * 3600 * 1000);
    await flush();
    expect(kex.count).toBe(1);
  });

  it('time: the server starts a new key exchange after the configured minutes', async () => {
    const kex = serverKexInits();
    const { pc } = await lab(['ip ssh rekey time 10']);
    await openSession(pc);
    expect(kex.count).toBe(1);
    clock.advance(9 * 60 * 1000);
    await flush();
    expect(kex.count).toBe(1);
    clock.advance(2 * 60 * 1000);
    await flush();
    expect(kex.count).toBeGreaterThanOrEqual(2);
  });

  it('volume: the server starts a new key exchange after the configured kilobytes', { timeout: 60000 }, async () => {
    const kex = serverKexInits();
    const { pc } = await lab(['ip ssh rekey volume 100', 'ip access-list extended BIG',
      ...Array.from({ length: 60 }, (_, i) => `remark ${String(i).padStart(2, '0')} ${'x'.repeat(230)}`), 'exit']);
    const session = await openSession(pc);
    for (let i = 0; i < 18; i++) {
      const channel = session.openExecChannel('show running-config');
      if (isOk(channel)) { await channel.value.execute(); channel.value.close(); }
    }
    await flush();
    expect(kex.count).toBeGreaterThanOrEqual(2);
  });

  it('the values are rendered, ranged, and removed by the no form', async () => {
    const { router } = await lab(['ip ssh rekey time 30', 'ip ssh rekey volume 500']);
    const config = await router.executeCommand('show running-config');
    expect(config).toContain('ip ssh rekey time 30');
    expect(config).toContain('ip ssh rekey volume 500');
    await router.executeCommand('configure terminal');
    expect(await router.executeCommand('ip ssh rekey time 5')).toContain('%');
    expect(await router.executeCommand('ip ssh rekey volume 99')).toContain('%');
    await router.executeCommand('no ip ssh rekey');
    await router.executeCommand('end');
    expect(await router.executeCommand('show running-config')).not.toContain('ip ssh rekey');
  });

  it('a configuration change after the first connection applies to the next one', async () => {
    const kex = serverKexInits();
    const { pc, router } = await lab([]);
    const first = await openSession(pc);
    void first;
    for (const c of ['configure terminal', 'ip ssh rekey time 10', 'end']) await router.executeCommand(c);
    await openSession(pc);
    const before = kex.count;
    clock.advance(11 * 60 * 1000);
    await flush();
    expect(kex.count).toBeGreaterThan(before);
  });
});

describe('ip ssh maxstartups', () => {
  async function startups(pc: LinuxPC, count: number): Promise<boolean[]> {
    const refused: boolean[] = [];
    for (let i = 0; i < count; i++) {
      const socket = await (pc as unknown as {
        tcpConnect: (h: string, p: number) => Promise<{ onData(h: (d: string) => void): void; closed: boolean } | null>;
      }).tcpConnect('10.0.0.6', 22);
      socket?.onData(() => {});
      await flush();
      refused.push(socket === null || socket.closed);
    }
    return refused;
  }

  it('witness: without a limit a third start-up connection is accepted', async () => {
    const { pc } = await lab([]);
    expect(await startups(pc, 3)).toEqual([false, false, false]);
  });

  it('the connection beyond the limit is closed by the server', async () => {
    const { pc } = await lab(['ip ssh maxstartups 2']);
    expect(await startups(pc, 3)).toEqual([false, false, true]);
  });

  it('the value is ranged, rendered when not the default, and restored by the no form', async () => {
    const { router } = await lab(['ip ssh maxstartups 50']);
    expect(await router.executeCommand('show running-config')).toContain('ip ssh maxstartups 50');
    await router.executeCommand('configure terminal');
    expect(await router.executeCommand('ip ssh maxstartups 1')).toContain('%');
    expect(await router.executeCommand('ip ssh maxstartups 129')).toContain('%');
    await router.executeCommand('no ip ssh maxstartups');
    await router.executeCommand('end');
    expect(await router.executeCommand('show running-config')).not.toContain('ip ssh maxstartups');
  });
});
