import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxServer } from '@/network/devices/LinuxServer';
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

/** Same topology/assertions as radius-protocol.test.ts's server-side suite, except the RADIUS server is a Linux Server (freeradius-equivalent) instead of a router — proving PRD-RADIUS P8's generic hosting contract actually works, not just structurally typechecks. */
function setupLab(bus: EventBus) {
  const nas = new CiscoRouter('NAS');
  const server = new LinuxServer('linux-server', 'AAA');
  const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
  nas.setEventBus(bus); server.setEventBus(bus); sw.setEventBus(bus);
  new Cable('a').connect(nas.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('b').connect(server.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  nas.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  server.getPort('eth0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  return { nas, server, sw };
}

describe('RADIUS — hosted on a Linux Server (PRD-RADIUS P8 generic hosting)', () => {
  it('accepts a registered user authenticating against a Linux-Server-hosted RADIUS server', async () => {
    const bus = new EventBus();
    const { nas, server } = setupLab(bus);
    server.getRadiusServer().setSharedSecret('shared');
    server.getRadiusServer().addUser('alice', 'wonderland');
    nas.getRadiusClient().addServer('10.0.0.2', 'shared', { timeoutMs: 200, retransmit: 0 });

    const accepted = await nas.getRadiusClient().authenticate('alice', 'wonderland');
    expect(accepted).toBe(true);
  });

  it('rejects a wrong password with the same server hosted on Linux', async () => {
    const bus = new EventBus();
    const { nas, server } = setupLab(bus);
    server.getRadiusServer().setSharedSecret('shared');
    server.getRadiusServer().addUser('alice', 'wonderland');
    nas.getRadiusClient().addServer('10.0.0.2', 'shared', { timeoutMs: 200, retransmit: 0 });

    const accepted = await nas.getRadiusClient().authenticate('alice', 'wrong-password');
    expect(accepted).toBe(false);
  });

  it('processes Accounting-Request on the same Linux-Server-hosted instance', async () => {
    const bus = new EventBus();
    const { nas, server } = setupLab(bus);
    server.getRadiusServer().setSharedSecret('shared');
    nas.getRadiusAccountingClient().addServer('10.0.0.2', 'shared', { timeoutMs: 200, retransmit: 0 });

    const sessionId = nas.getRadiusAccountingClient().startSession('alice');
    expect(sessionId).not.toBeNull();
    nas.getRadiusAccountingClient().stopSession(sessionId!, 'user-request');

    const journaled = server.getRadiusServer().listAccountingSessions().find((s) => s.sessionId === sessionId);
    expect(journaled?.status).toBe('stop');
  });
});
