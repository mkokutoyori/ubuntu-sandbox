import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { MACAddress, IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function setupLab(bus: EventBus) {
  const client = new CiscoRouter('NAS');
  const server = new CiscoRouter('AAA');
  const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
  client.setEventBus(bus); server.setEventBus(bus); sw.setEventBus(bus);
  new Cable('a').connect(client.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('b').connect(server.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);
  client.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  server.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  return { client, server, sw };
}

describe('RADIUS — server group failover', () => {
  it('falls over to the next server when the first one never responds', async () => {
    const bus = new EventBus();
    const { client, server } = setupLab(bus);
    server.getRadiusServer().setSharedSecret('shared');
    server.getRadiusServer().addUser('alice', 'wonderland');
    // 10.0.0.99 has no device behind it — every request to it times out.
    client.getRadiusClient().addServer('10.0.0.99', 'shared', { timeoutMs: 50, retransmit: 0 });
    client.getRadiusClient().addServer('10.0.0.2', 'shared', { timeoutMs: 200, retransmit: 0 });

    const accepted = await client.getRadiusClient().authenticate('alice', 'wonderland');
    expect(accepted).toBe(true);

    const status = client.getRadiusClient().listServerStatus();
    const dead = status.find((s) => s.ip === '10.0.0.99');
    const live = status.find((s) => s.ip === '10.0.0.2');
    expect(dead?.timeouts).toBe(1);
    expect(live?.accepts).toBe(1);
  });

  it('does NOT fail over on an explicit Access-Reject — the answer is authoritative', async () => {
    const bus = new EventBus();
    const { client, server } = setupLab(bus);
    server.getRadiusServer().setSharedSecret('shared');
    server.getRadiusServer().addUser('alice', 'wonderland');
    client.getRadiusClient().addServer('10.0.0.2', 'shared', { timeoutMs: 200, retransmit: 0 });
    client.getRadiusClient().addServer('10.0.0.50', 'shared', { timeoutMs: 200, retransmit: 0 });

    const accepted = await client.getRadiusClient().authenticate('alice', 'wrong-password');
    expect(accepted).toBe(false);

    const status = client.getRadiusClient().listServerStatus();
    expect(status.find((s) => s.ip === '10.0.0.2')?.rejects).toBe(1);
    expect(status.find((s) => s.ip === '10.0.0.50')?.requests).toBe(0);
  });

  it('marks a timed-out server dead and skips it on the next call once deadtime is set', async () => {
    const bus = new EventBus();
    const { client, server } = setupLab(bus);
    server.getRadiusServer().setSharedSecret('shared');
    server.getRadiusServer().addUser('alice', 'wonderland');
    client.getRadiusClient().setDeadtimeMs(60_000);
    client.getRadiusClient().addServer('10.0.0.99', 'shared', { timeoutMs: 50, retransmit: 0 });
    client.getRadiusClient().addServer('10.0.0.2', 'shared', { timeoutMs: 200, retransmit: 0 });

    const deadEvents: Array<{ serverIp: string }> = [];
    bus.subscribe('radius.server.dead', (e) => deadEvents.push(e.payload));

    await client.getRadiusClient().authenticate('alice', 'wonderland');
    expect(deadEvents.map((e) => e.serverIp)).toEqual(['10.0.0.99']);
    expect(client.getRadiusClient().listServerStatus().find((s) => s.ip === '10.0.0.99')?.alive).toBe(false);

    // Second call: the dead server should be skipped entirely (no new request against it).
    await client.getRadiusClient().authenticate('alice', 'wonderland');
    const status = client.getRadiusClient().listServerStatus();
    expect(status.find((s) => s.ip === '10.0.0.99')?.requests).toBe(1); // unchanged since the first call
    expect(status.find((s) => s.ip === '10.0.0.2')?.requests).toBe(2);
  });

  it('does not mark servers dead when deadtime is left at its default (0 = disabled)', async () => {
    const bus = new EventBus();
    const { client, server } = setupLab(bus);
    server.getRadiusServer().setSharedSecret('shared');
    server.getRadiusServer().addUser('alice', 'wonderland');
    client.getRadiusClient().addServer('10.0.0.99', 'shared', { timeoutMs: 50, retransmit: 0 });
    client.getRadiusClient().addServer('10.0.0.2', 'shared', { timeoutMs: 200, retransmit: 0 });

    await client.getRadiusClient().authenticate('alice', 'wonderland');
    expect(client.getRadiusClient().listServerStatus().find((s) => s.ip === '10.0.0.99')?.alive).toBe(true);

    // Still tried first on the next call, since it was never marked dead.
    await client.getRadiusClient().authenticate('alice', 'wonderland');
    expect(client.getRadiusClient().listServerStatus().find((s) => s.ip === '10.0.0.99')?.requests).toBe(2);
  });
});
