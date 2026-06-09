import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { MACAddress, IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import {
  UDP_PORT_RADIUS_AUTH, RADIUS_CODE, RADIUS_ATTR, getAttr, attr,
  decryptUserPassword,
  type RadiusPacket,
} from '@/network/radius/types';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

describe('RADIUS — pure helpers', () => {
  it('RADIUS_CODE encodes the standard packet codes per RFC 2865', () => {
    expect(RADIUS_CODE['access-request']).toBe(1);
    expect(RADIUS_CODE['access-accept']).toBe(2);
    expect(RADIUS_CODE['access-reject']).toBe(3);
    expect(RADIUS_CODE['access-challenge']).toBe(11);
  });

  it('RADIUS_ATTR encodes the standard attribute types', () => {
    expect(RADIUS_ATTR['user-name']).toBe(1);
    expect(RADIUS_ATTR['user-password']).toBe(2);
    expect(RADIUS_ATTR['nas-ip-address']).toBe(4);
    expect(RADIUS_ATTR['reply-message']).toBe(18);
    expect(RADIUS_ATTR['vendor-specific']).toBe(26);
  });

  it('attr / getAttr round-trip', () => {
    const a = attr('user-name', 'alice');
    const pkt: RadiusPacket = {
      type: 'radius', code: 'access-request', identifier: 1,
      authenticator: '00'.repeat(16), attributes: [a],
    };
    expect(getAttr(pkt, 'user-name')?.value).toBe('alice');
    expect(getAttr(pkt, 'user-password')).toBeUndefined();
  });
});

describe('RADIUS — server-side handling', () => {
  it('accepts a registered user with the right password', async () => {
    const bus = new EventBus();
    const client = new CiscoRouter('NAS');
    const server = new CiscoRouter('AAA');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    client.setEventBus(bus); server.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(client.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(server.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    client.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    server.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));

    server.getRadiusServer().setSharedSecret('shared');
    server.getRadiusServer().addUser('alice', 'wonderland');
    client.getRadiusClient().addServer('10.0.0.2', 'shared', { timeoutMs: 200, retransmit: 0 });

    const accepted = await client.getRadiusClient().authenticate('alice', 'wonderland');
    expect(accepted).toBe(true);
  });

  it('rejects an unknown user', async () => {
    const bus = new EventBus();
    const client = new CiscoRouter('NAS');
    const server = new CiscoRouter('AAA');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    client.setEventBus(bus); server.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(client.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(server.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    client.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    server.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));

    server.getRadiusServer().addUser('alice', 'wonderland');
    client.getRadiusClient().addServer('10.0.0.2', 'shared', { timeoutMs: 200, retransmit: 0 });

    const rejects: Array<{ username: string; reason: string }> = [];
    bus.subscribe('radius.auth.rejected', (e) => rejects.push(e.payload));

    const accepted = await client.getRadiusClient().authenticate('bob', 'whatever');
    expect(accepted).toBe(false);
    expect(rejects.some(r => r.username === 'bob' && r.reason === 'unknown-user')).toBe(true);
  });

  it('rejects a known user with the wrong password', async () => {
    const bus = new EventBus();
    const client = new CiscoRouter('NAS');
    const server = new CiscoRouter('AAA');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    client.setEventBus(bus); server.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(client.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(server.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    client.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    server.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));

    server.getRadiusServer().addUser('alice', 'wonderland');
    client.getRadiusClient().addServer('10.0.0.2', 'shared', { timeoutMs: 200, retransmit: 0 });

    const accepted = await client.getRadiusClient().authenticate('alice', 'nopenope');
    expect(accepted).toBe(false);
  });

  it('rejects clients not in the authorized client list when one is set', async () => {
    const bus = new EventBus();
    const client = new CiscoRouter('NAS');
    const server = new CiscoRouter('AAA');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    client.setEventBus(bus); server.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(client.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(server.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    client.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    server.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));

    server.getRadiusServer().addUser('alice', 'wonderland');
    server.getRadiusServer().authorizeClient('10.0.0.50');
    client.getRadiusClient().addServer('10.0.0.2', 'shared', { timeoutMs: 200, retransmit: 0 });

    const rejects: Array<{ reason: string }> = [];
    bus.subscribe('radius.auth.rejected', (e) => rejects.push(e.payload));
    const accepted = await client.getRadiusClient().authenticate('alice', 'wonderland');
    expect(accepted).toBe(false);
    expect(rejects.some(r => r.reason === 'client-not-authorized')).toBe(true);
  });
});

describe('RADIUS — wire format', () => {
  it('Access-Request rides UDP/1812 with a radius payload carrying User-Name and User-Password', async () => {
    const bus = new EventBus();
    const client = new CiscoRouter('NAS');
    const server = new CiscoRouter('AAA');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    client.setEventBus(bus); server.setEventBus(bus); sw.setEventBus(bus);
    const cable = new Cable('a');
    cable.setEventBus(bus);
    let seen: { code: string; dport: number; username: string; password: string; authenticator: string } | null = null;
    bus.subscribe('cable.frame.delivered', (e) => {
      const ipPkt = (e.payload.frame.payload as unknown) as {
        protocol?: number;
        payload?: {
          type?: string; destinationPort?: number;
          payload?: { type?: string; code?: string; authenticator?: string; attributes?: Array<{ type: string; value: string | number }> }
        };
      } | undefined;
      const udp = ipPkt?.payload;
      if (udp?.type === 'udp' && udp.destinationPort === UDP_PORT_RADIUS_AUTH) {
        const r = udp.payload;
        if (r?.type === 'radius') {
          const u = r.attributes!.find(a => a.type === 'user-name')?.value as string;
          const p = r.attributes!.find(a => a.type === 'user-password')?.value as string;
          seen = { code: r.code!, dport: udp.destinationPort, username: u, password: p, authenticator: r.authenticator! };
        }
      }
    });
    cable.connect(client.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(server.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    client.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    server.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));

    server.getRadiusServer().addUser('alice', 'wonderland');
    client.getRadiusClient().addServer('10.0.0.2', 'shared', { timeoutMs: 200, retransmit: 0 });
    await client.getRadiusClient().authenticate('alice', 'wonderland');

    expect(seen).not.toBeNull();
    expect(seen!.code).toBe('access-request');
    expect(seen!.dport).toBe(UDP_PORT_RADIUS_AUTH);
    expect(seen!.username).toBe('alice');
    expect(seen!.password).not.toBe('wonderland');
    expect(seen!.password).toMatch(/^[0-9a-f]+$/);
    expect(decryptUserPassword(seen!.password, 'shared', seen!.authenticator)).toBe('wonderland');
  });
});

describe('RADIUS — reactive bus', () => {
  it('publishes radius.auth.completed with accepted=true after a successful exchange', async () => {
    const bus = new EventBus();
    const client = new CiscoRouter('NAS');
    const server = new CiscoRouter('AAA');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    client.setEventBus(bus); server.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(client.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(server.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    client.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    server.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
    server.getRadiusServer().addUser('alice', 'wonderland');
    client.getRadiusClient().addServer('10.0.0.2', 'shared', { timeoutMs: 200, retransmit: 0 });
    const completed: Array<{ accepted: boolean; username: string }> = [];
    bus.subscribe('radius.auth.completed', (e) => completed.push(e.payload));
    await client.getRadiusClient().authenticate('alice', 'wonderland');
    expect(completed.some(c => c.accepted && c.username === 'alice')).toBe(true);
  });
});

describe('RADIUS — Cisco↔Huawei interop', () => {
  it('Huawei NAS authenticates against a Cisco RADIUS server', async () => {
    const bus = new EventBus();
    const client = new HuaweiRouter('HW-NAS');
    const server = new CiscoRouter('AAA');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    client.setEventBus(bus); server.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(client.getPort('GE0/0/0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(server.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    client.getPort('GE0/0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    server.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));

    server.getRadiusServer().addUser('alice', 'wonderland');
    client.getRadiusClient().addServer('10.0.0.2', 'shared', { timeoutMs: 200, retransmit: 0 });

    const accepted = await client.getRadiusClient().authenticate('alice', 'wonderland');
    expect(accepted).toBe(true);
  });
});

describe('RADIUS — timeout', () => {
  it('returns false when no server replies', async () => {
    const client = new CiscoRouter('NAS');
    client.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    client.getRadiusClient().addServer('10.0.0.99', 'shared', { timeoutMs: 50, retransmit: 0 });
    const accepted = await client.getRadiusClient().authenticate('alice', 'wonderland');
    expect(accepted).toBe(false);
  });
});
