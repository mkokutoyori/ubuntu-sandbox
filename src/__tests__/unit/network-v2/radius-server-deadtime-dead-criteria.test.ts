/**
 * Cisco IOS Security Command Reference (official_docs/cisco/ios-security, Commands M to R):
 * `radius-server deadtime` and `radius-server dead-criteria`.
 *
 *   deadtime minutes   a server marked dead is skipped by later transactions for that long, unless
 *                      no server is left alive; 0 (default) never skips
 *   dead-criteria      the server is marked dead only when BOTH the time since the last valid reply
 *                      (time seconds) AND the consecutive timeouts counted over every transmission
 *                      (tries) are reached
 *
 * Lab: a NAS router and two RADIUS servers on one switch, real frames on real cables. The first
 * server is up on the wire but its RADIUS service is off, so it never answers; the second answers.
 * Defaults of the criteria when not configured: the lower bound of each documented range (10 s,
 * 10 tries), because the book says they vary with load and gives only the ranges.
 *
 * Measured with src stashed to HEAD: 5 of the 8 cases fall (the commands are rejected). Three pass
 * either way: the witness (without deadtime the silent server is tried at every transaction), the
 * case "tried again after the deadtime" (a server is always tried when nothing skips it), and the
 * no-form case (a rejected command leaves nothing to render).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, resetCounters, MACAddress, type IPv4Packet, type UDPPacket } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { installVirtualClock } from '@/__tests__/support/ntpTime';
import { simulationNowMs } from '@/network/core/SystemClock';
import { getSecurityConfig } from '@/network/devices/shells/cisco/CiscoSecurityCommands';
import type { VirtualTimeScheduler } from '@/events/Scheduler';

let clock: VirtualTimeScheduler;

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  clock = installVirtualClock();
});

const RADIUS_AUTH = 1812;

function arrivals(device: CiscoRouter): { count: number } {
  const seen = { count: 0 };
  for (const p of device.getPorts()) {
    p.attachTap(({ direction, frame }) => {
      if (direction !== 'in') return;
      const packet = frame.payload as IPv4Packet | undefined;
      const udp = packet?.type === 'ipv4' ? packet.payload as UDPPacket : undefined;
      if (udp?.type === 'udp' && udp.destinationPort === RADIUS_AUTH) seen.count++;
    });
  }
  return seen;
}

interface Lab { nas: CiscoRouter; silent: CiscoRouter; live: CiscoRouter; toSilent: { count: number }; toLive: { count: number } }

async function lab(globalLines: string[]): Promise<Lab> {
  const sw = new CiscoSwitch('switch-cisco', 'SW', 8);
  const nas = new CiscoRouter('NAS');
  const silent = new CiscoRouter('SILENT');
  const live = new CiscoRouter('LIVE');
  for (const [i, d] of [nas, silent, live].entries()) {
    new Cable(`c${i}`).connect(d.getPort('GigabitEthernet0/0')!, sw.getPort(`FastEthernet0/${i + 1}`)!);
    d.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress(`10.0.0.${i + 1}`), new SubnetMask('255.255.255.0'));
    for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0', 'no shutdown', 'end']) await d.executeCommand(c);
  }
  for (const server of [silent, live]) {
    const agent = server.getRadiusServer();
    agent.start();
    agent.setSharedSecret('secret');
    agent.authorizeClient('10.0.0.1');
    agent.addUser('alice', 'pw');
  }
  silent.getRadiusServer().setEnabled(false);
  live.getRadiusServer().setEnabled(true);
  nas.getRadiusClient().start();
  for (const c of [
    'enable', 'configure terminal', 'aaa new-model',
    'radius-server host 10.0.0.2 auth-port 1812 key secret', 'radius-server host 10.0.0.3 auth-port 1812 key secret',
    'radius-server timeout 1', 'radius-server retransmit 0',
    'aaa group server radius G', 'server name 10.0.0.2', 'server name 10.0.0.3', 'exit',
    'aaa authentication login default group G',
    ...globalLines, 'end',
  ]) await nas.executeCommand(c);
  return { nas, silent, live, toSilent: arrivals(silent), toLive: arrivals(live) };
}

async function login(nas: CiscoRouter): Promise<boolean> {
  const outcome = await clock.advanceUntilSettled(nas.getAaaAuthenticator().authenticate('alice', 'pw', 'default'));
  return outcome.accepted;
}

describe('radius-server deadtime and dead-criteria', () => {
  it('witness: without deadtime the silent server is tried again at every transaction', async () => {
    const { nas, toSilent } = await lab([]);
    expect(await login(nas)).toBe(true);
    expect(await login(nas)).toBe(true);
    expect(toSilent.count).toBe(2);
  });

  it('the commands are accepted and rendered', async () => {
    const { nas } = await lab(['radius-server deadtime 5', 'radius-server dead-criteria time 20 tries 3']);
    const config = await nas.executeCommand('show running-config');
    expect(config).toContain('radius-server deadtime 5');
    expect(config).toContain('radius-server dead-criteria time 20 tries 3');
  });

  it('once both criteria are met the server is skipped for the deadtime', async () => {
    const { nas, toSilent, toLive } = await lab(['radius-server deadtime 5', 'radius-server dead-criteria time 1 tries 1']);
    expect(await login(nas)).toBe(true);
    expect(toSilent.count).toBe(1);
    expect(await login(nas)).toBe(true);
    expect(toSilent.count).toBe(1);
    expect(toLive.count).toBe(2);
  });

  it('the server is tried again after the deadtime has elapsed', async () => {
    const { nas, toSilent } = await lab(['radius-server deadtime 1', 'radius-server dead-criteria time 1 tries 1']);
    await login(nas);
    expect(toSilent.count).toBe(1);
    clock.advance(61_000);
    await login(nas);
    expect(toSilent.count).toBe(2);
  });

  it('the tries criterion holds a server alive until enough timeouts have accumulated', async () => {
    const { nas, toSilent } = await lab(['radius-server deadtime 5', 'radius-server dead-criteria time 1 tries 3']);
    await login(nas);
    await login(nas);
    expect(toSilent.count).toBe(2);
    await login(nas);
    expect(toSilent.count).toBe(3);
    await login(nas);
    expect(toSilent.count).toBe(3);
  });

  it('the time criterion holds a server alive until enough time has passed since its last valid reply', async () => {
    const { nas, toSilent } = await lab(['radius-server deadtime 5', 'radius-server dead-criteria time 120 tries 1']);
    await login(nas);
    expect(toSilent.count).toBe(1);
    await login(nas);
    expect(toSilent.count).toBe(1);
  });

  it('when every server is dead they are all tried anyway', async () => {
    const { nas, live, toSilent, toLive } = await lab(['radius-server deadtime 5', 'radius-server dead-criteria time 1 tries 1']);
    live.getRadiusServer().setEnabled(false);
    expect(await login(nas)).toBe(false);
    expect(await login(nas)).toBe(false);
    expect(toSilent.count).toBe(2);
    expect(toLive.count).toBe(2);
    expect(getSecurityConfig(nas).radiusLiveness.isDead('10.0.0.2', simulationNowMs())).toBe(true);
  });

  it('the no forms restore the defaults', async () => {
    const { nas } = await lab([
      'radius-server deadtime 5', 'radius-server dead-criteria time 20 tries 3',
      'no radius-server deadtime', 'no radius-server dead-criteria',
    ]);
    const config = await nas.executeCommand('show running-config');
    expect(config).not.toContain('radius-server deadtime');
    expect(config).not.toContain('radius-server dead-criteria');
  });
});
