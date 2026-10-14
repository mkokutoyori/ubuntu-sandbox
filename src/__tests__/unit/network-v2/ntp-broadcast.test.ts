/**
 * NTP broadcast and multicast (RFC 5905 mode 5) between Cisco routers over
 * real frames. The server side announces on a schedule (`ntp broadcast`,
 * `ntp multicast`), the client side learns the server from the announcement
 * (`ntp broadcast client`, `ntp multicast client`) with the delay of `ntp
 * broadcastdelay`, honours `ntp authenticate` and its trusted keys, and
 * ages the association out when the announcements stop. `sntp broadcast
 * client` was stored and rendered, never evaluated.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { VirtualTimeScheduler } from '@/events/Scheduler';
import { installVirtualClock, converge } from '../../support/ntpTime';

let clock: VirtualTimeScheduler;

beforeEach(() => {
  clock = installVirtualClock();
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function run(device: CiscoRouter, lines: string[]): Promise<void> {
  for (const line of lines) await device.executeCommand(line);
}

const iface = (address: string, extra: string[] = []): string[] => [
  'enable', 'configure terminal', 'interface GigabitEthernet0/0', `ip address ${address} 255.255.255.0`, 'no shutdown', ...extra, 'exit',
];

async function lab(serverInterface: string[], clientInterface: string[], clientGlobal: string[] = [], serverGlobal: string[] = []) {
  const server = new CiscoRouter('R1');
  const client = new CiscoRouter('R2');
  const sw = new GenericSwitch('switch-generic', 'SW');
  new Cable('a').connect(server.getPort('GigabitEthernet0/0')!, sw.getPorts()[0]);
  new Cable('b').connect(client.getPort('GigabitEthernet0/0')!, sw.getPorts()[1]);
  await run(server, [...iface('10.0.0.1', serverInterface), 'ntp master 2', ...serverGlobal, 'end']);
  await run(client, [...iface('10.0.0.2', clientInterface), ...clientGlobal, 'end']);
  converge(clock, 400_000);
  return { server, client };
}

describe('ntp broadcast', () => {
  it('witness: with no broadcast client the announcements teach nothing', async () => {
    const { client } = await lab(['ntp broadcast'], []);
    expect(await client.executeCommand('show ntp status')).toContain('Clock is unsynchronized');
  });

  it('[fails before] a broadcast client synchronises from the announcements of a broadcast server', async () => {
    const { client } = await lab(['ntp broadcast'], ['ntp broadcast client']);
    expect(await client.executeCommand('show ntp status')).toContain('Clock is synchronized, stratum 3, reference is 10.0.0.1');
  });

  it('[fails before] the interface configuration reads back and is replayable', async () => {
    const { server, client } = await lab(['ntp broadcast version 3'], ['ntp broadcast client']);
    expect(await server.executeCommand('show running-config')).toContain(' ntp broadcast version 3');
    expect(await client.executeCommand('show running-config')).toContain(' ntp broadcast client');
  });

  it('[fails before] `ntp broadcastdelay` decides the offset the client computes', async () => {
    const { client } = await lab(['ntp broadcast'], ['ntp broadcast client'], ['ntp broadcastdelay 50000']);
    const detail = await client.executeCommand('show ntp associations detail');
    expect(detail).toMatch(/delay 50\.00 msec/);
  });

  it('[fails before] `sntp broadcast client` now listens on every interface', async () => {
    const { client } = await lab(['ntp broadcast'], [], ['sntp broadcast client']);
    expect(await client.executeCommand('show ntp status')).toContain('Clock is synchronized');
  });

  it('[fails before] with `ntp authenticate` a client rejects unauthenticated announcements', async () => {
    const { client } = await lab(['ntp broadcast'], ['ntp broadcast client'], ['ntp authentication-key 1 md5 SECRET', 'ntp trusted-key 1', 'ntp authenticate']);
    expect(await client.executeCommand('show ntp status')).toContain('Clock is unsynchronized');
  });

  it('[fails before] with the right key the authenticated announcements are accepted', async () => {
    const { client } = await lab(['ntp broadcast key 1'], ['ntp broadcast client'],
      ['ntp authentication-key 1 md5 SECRET', 'ntp trusted-key 1', 'ntp authenticate'], ['ntp authentication-key 1 md5 SECRET']);
    expect(await client.executeCommand('show ntp status')).toContain('Clock is synchronized');
  });

  it('[fails before] when the announcements stop the learned association ages out', async () => {
    const { server, client } = await lab(['ntp broadcast'], ['ntp broadcast client']);
    await run(server, ['configure terminal', 'interface GigabitEthernet0/0', 'no ntp broadcast', 'end']);
    converge(clock, 3_000_000);
    expect(await client.executeCommand('show ntp associations')).not.toContain('10.0.0.1');
  });
});

describe('ntp multicast', () => {
  it('[fails before] a multicast client on the default group synchronises from a multicast server', async () => {
    const { client } = await lab(['ntp multicast'], ['ntp multicast client']);
    expect(await client.executeCommand('show ntp status')).toContain('Clock is synchronized, stratum 3');
  });

  it('[fails before] a client of another group ignores the announcements', async () => {
    const { client } = await lab(['ntp multicast'], ['ntp multicast client 224.0.1.50']);
    expect(await client.executeCommand('show ntp status')).toContain('Clock is unsynchronized');
  });

  it('[fails before] a custom group on both sides works', async () => {
    const { client } = await lab(['ntp multicast 224.0.1.50'], ['ntp multicast client 224.0.1.50']);
    expect(await client.executeCommand('show ntp status')).toContain('Clock is synchronized');
  });
});
