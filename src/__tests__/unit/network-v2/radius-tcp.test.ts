import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { MACAddress, IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { UDP_PORT_RADIUS_AUTH } from '@/network/radius/types';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

/** RFC 6613 — RADIUS/TCP: same PAP semantics as UDP, just carried over a TCP connection instead of retransmitted datagrams. */
function setupLab(bus: EventBus) {
  const nas = new CiscoRouter('NAS');
  const server = new CiscoRouter('AAA');
  const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
  nas.setEventBus(bus); server.setEventBus(bus); sw.setEventBus(bus);
  new Cable('a').connect(nas.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('b').connect(server.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);
  nas.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  server.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  return { nas, server, sw };
}

describe('RADIUS/TCP (RFC 6613)', () => {
  it('accepts a registered user over a TCP connection', async () => {
    const bus = new EventBus();
    const { nas, server } = setupLab(bus);
    server.getRadiusTcpServer().setSharedSecret('shared');
    server.getRadiusTcpServer().addUser('alice', 'wonderland');
    nas.getRadiusTcpClient().addServer('10.0.0.2', 'shared', { timeoutMs: 200 });

    const result = await nas.getRadiusTcpClient().authenticate('alice', 'wonderland');
    expect(result).toBe('accept');
  });

  it('rejects a wrong password over TCP', async () => {
    const bus = new EventBus();
    const { nas, server } = setupLab(bus);
    server.getRadiusTcpServer().setSharedSecret('shared');
    server.getRadiusTcpServer().addUser('alice', 'wonderland');
    nas.getRadiusTcpClient().addServer('10.0.0.2', 'shared', { timeoutMs: 200 });

    const result = await nas.getRadiusTcpClient().authenticate('alice', 'wrong-password');
    expect(result).toBe('reject');
  });

  it('rejects an unknown user over TCP', async () => {
    const bus = new EventBus();
    const { nas, server } = setupLab(bus);
    server.getRadiusTcpServer().setSharedSecret('shared');
    nas.getRadiusTcpClient().addServer('10.0.0.2', 'shared', { timeoutMs: 200 });

    const result = await nas.getRadiusTcpClient().authenticate('bob', 'whatever');
    expect(result).toBe('reject');
  });

  it('times out when no server is reachable', async () => {
    const nas = new CiscoRouter('NAS');
    nas.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    nas.getRadiusTcpClient().addServer('10.0.0.99', 'shared', { timeoutMs: 50 });

    const result = await nas.getRadiusTcpClient().authenticate('alice', 'wonderland');
    expect(result).toBe('timeout');
  });

  it('publishes radius.tcp.completed on both ends', async () => {
    const bus = new EventBus();
    const { nas, server } = setupLab(bus);
    server.getRadiusTcpServer().setSharedSecret('shared');
    server.getRadiusTcpServer().addUser('alice', 'wonderland');
    nas.getRadiusTcpClient().addServer('10.0.0.2', 'shared', { timeoutMs: 200 });

    const events: Array<{ hostname: string; result: string }> = [];
    bus.subscribe('radius.tcp.completed', (e) => events.push(e.payload));
    await nas.getRadiusTcpClient().authenticate('alice', 'wonderland');
    expect(events).toContainEqual(expect.objectContaining({ hostname: 'NAS', result: 'accept' }));
    expect(events).toContainEqual(expect.objectContaining({ hostname: 'AAA', result: 'accept' }));
  });

  it('rides a real TCP segment to port 1812 with a radius payload', () => {
    const bus = new EventBus();
    const nas = new CiscoRouter('NAS');
    const server = new CiscoRouter('AAA');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    nas.setEventBus(bus); server.setEventBus(bus); sw.setEventBus(bus);
    const cable = new Cable('a');
    cable.setEventBus(bus);
    let seen: { dport: number; code: string } | null = null;
    bus.subscribe('cable.frame.delivered', (e) => {
      const ipPkt = (e.payload.frame.payload as unknown) as {
        protocol?: number;
        payload?: { type?: string; destinationPort?: number; payload?: { type?: string; code?: string } };
      } | undefined;
      const tcp = ipPkt?.payload;
      if (tcp?.type === 'tcp' && tcp.destinationPort === UDP_PORT_RADIUS_AUTH) {
        const radius = tcp.payload;
        if (radius?.type === 'radius') seen = { dport: tcp.destinationPort, code: radius.code! };
      }
    });
    cable.connect(nas.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('b').connect(server.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);
    nas.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    server.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));

    server.getRadiusTcpServer().setSharedSecret('shared');
    server.getRadiusTcpServer().addUser('alice', 'wonderland');
    nas.getRadiusTcpClient().addServer('10.0.0.2', 'shared', { timeoutMs: 200 });
    nas.getRadiusTcpClient().authenticate('alice', 'wonderland');

    expect(seen).not.toBeNull();
    expect(seen!.dport).toBe(UDP_PORT_RADIUS_AUTH);
    expect(seen!.code).toBe('access-request');
  });

  it('Huawei NAS authenticates against a Cisco RADIUS/TCP server', async () => {
    const bus = new EventBus();
    const nas = new HuaweiRouter('HW-NAS');
    const server = new CiscoRouter('AAA');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    nas.setEventBus(bus); server.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(nas.getPort('GE0/0/0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('b').connect(server.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);
    nas.getPort('GE0/0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    server.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));

    server.getRadiusTcpServer().setSharedSecret('shared');
    server.getRadiusTcpServer().addUser('alice', 'wonderland');
    nas.getRadiusTcpClient().addServer('10.0.0.2', 'shared', { timeoutMs: 200 });
    const result = await nas.getRadiusTcpClient().authenticate('alice', 'wonderland');
    expect(result).toBe('accept');
  });
});

describe('RADIUS/TCP — hosted on a Linux Server (generic hosting, PRD-RADIUS P8)', () => {
  it('accepts a registered user authenticating over TCP against a Linux-Server-hosted RADIUS server', async () => {
    const bus = new EventBus();
    const nas = new CiscoRouter('NAS');
    const server = new LinuxServer('linux-server', 'AAA');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    nas.setEventBus(bus); server.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(nas.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('b').connect(server.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
    nas.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    server.getPort('eth0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));

    server.getRadiusTcpServer().setSharedSecret('shared');
    server.getRadiusTcpServer().addUser('alice', 'wonderland');
    nas.getRadiusTcpClient().addServer('10.0.0.2', 'shared', { timeoutMs: 200 });

    const result = await nas.getRadiusTcpClient().authenticate('alice', 'wonderland');
    expect(result).toBe('accept');
  });
});
