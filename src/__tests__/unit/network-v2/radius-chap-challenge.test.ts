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
  const cableClientSw = new Cable('a');
  cableClientSw.setEventBus(bus);
  cableClientSw.connect(client.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
  const cableServerSw = new Cable('b');
  cableServerSw.setEventBus(bus);
  cableServerSw.connect(server.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);
  client.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  server.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  return { client, server, sw };
}

describe('RADIUS — CHAP (RFC 2865 §5.3, RFC 1994)', () => {
  it('accepts a CHAP exchange with the right password', async () => {
    const bus = new EventBus();
    const { client, server } = setupLab(bus);
    server.getRadiusServer().setSharedSecret('shared');
    server.getRadiusServer().addUser('alice', 'wonderland');
    client.getRadiusClient().addServer('10.0.0.2', 'shared', { timeoutMs: 200, retransmit: 0 });

    const accepted = await client.getRadiusClient().authenticateChap('alice', 'wonderland');
    expect(accepted).toBe(true);
  });

  it('rejects a CHAP exchange with the wrong password', async () => {
    const bus = new EventBus();
    const { client, server } = setupLab(bus);
    server.getRadiusServer().setSharedSecret('shared');
    server.getRadiusServer().addUser('alice', 'wonderland');
    client.getRadiusClient().addServer('10.0.0.2', 'shared', { timeoutMs: 200, retransmit: 0 });

    const rejects: Array<{ reason: string }> = [];
    bus.subscribe('radius.auth.rejected', (e) => rejects.push(e.payload));

    const accepted = await client.getRadiusClient().authenticateChap('alice', 'wrong-password');
    expect(accepted).toBe(false);
    expect(rejects.some((r) => r.reason === 'bad-password')).toBe(true);
  });

  it('rejects a CHAP exchange for an unknown user', async () => {
    const bus = new EventBus();
    const { client, server } = setupLab(bus);
    server.getRadiusServer().setSharedSecret('shared');
    client.getRadiusClient().addServer('10.0.0.2', 'shared', { timeoutMs: 200, retransmit: 0 });

    const rejects: Array<{ reason: string }> = [];
    bus.subscribe('radius.auth.rejected', (e) => rejects.push(e.payload));

    const accepted = await client.getRadiusClient().authenticateChap('ghost', 'whatever');
    expect(accepted).toBe(false);
    expect(rejects.some((r) => r.reason === 'unknown-user')).toBe(true);
  });

  it('never reveals the plaintext password on the wire (unlike PAP, no reversible encryption at all)', async () => {
    const bus = new EventBus();
    const { client, server } = setupLab(bus);
    server.getRadiusServer().setSharedSecret('shared');
    server.getRadiusServer().addUser('alice', 'wonderland');
    client.getRadiusClient().addServer('10.0.0.2', 'shared', { timeoutMs: 200, retransmit: 0 });

    let sawChapPassword = false;
    const unsub = bus.subscribe('cable.frame.dispatched', (e) => {
      const frame = e.payload.frame as { payload?: { payload?: { payload?: unknown } } };
      const radius = frame.payload?.payload?.payload as
        { type?: string; attributes?: Array<{ type: string; value: unknown }> } | undefined;
      if (radius?.type !== 'radius') return;
      const chap = radius.attributes?.find((a) => a.type === 'chap-password');
      if (chap) {
        sawChapPassword = true;
        expect(String(chap.value)).not.toContain('wonderland');
      }
    });

    await client.getRadiusClient().authenticateChap('alice', 'wonderland');
    unsub();
    expect(sawChapPassword).toBe(true);
  });
});

describe('RADIUS — Access-Challenge / State (RFC 2865 §4.4)', () => {
  it('completes a two-round challenge exchange transparently', async () => {
    const bus = new EventBus();
    const { client, server } = setupLab(bus);
    server.getRadiusServer().setSharedSecret('shared');
    server.getRadiusServer().addUser('bob', 'otp-999', [], { challenge: { prompt: 'Enter your one-time code:' } });
    client.getRadiusClient().addServer('10.0.0.2', 'shared', { timeoutMs: 200, retransmit: 0 });

    const sent: Array<{ code: string; hostname: string }> = [];
    bus.subscribe('radius.packet.sent', (e) => sent.push(e.payload as { code: string; hostname: string }));

    const accepted = await client.getRadiusClient().authenticate('bob', 'otp-999');

    expect(accepted).toBe(true);
    const serverSent = sent.filter((s) => s.hostname === 'AAA');
    expect(serverSent.map((s) => s.code)).toEqual(['access-challenge', 'access-accept']);
  });

  it('carries the challenge prompt in Reply-Message', async () => {
    const bus = new EventBus();
    const { client, server } = setupLab(bus);
    server.getRadiusServer().setSharedSecret('shared');
    server.getRadiusServer().addUser('bob', 'otp-999', [], { challenge: { prompt: 'Enter your one-time code:' } });
    client.getRadiusClient().addServer('10.0.0.2', 'shared', { timeoutMs: 200, retransmit: 0 });

    const received: string[] = [];
    const unsub = bus.subscribe('cable.frame.dispatched', (e) => {
      const frame = e.payload.frame as { payload?: { payload?: { payload?: unknown } } };
      const radius = frame.payload?.payload?.payload as
        { type?: string; code?: string; attributes?: Array<{ type: string; value: unknown }> } | undefined;
      if (radius?.type !== 'radius' || radius.code !== 'access-challenge') return;
      const rm = radius.attributes?.find((a) => a.type === 'reply-message');
      if (rm) received.push(String(rm.value));
    });

    await client.getRadiusClient().authenticate('bob', 'otp-999');
    unsub();
    expect(received).toContain('Enter your one-time code:');
  });

  it('rejects if the final round carries the wrong password', async () => {
    const bus = new EventBus();
    const { client, server } = setupLab(bus);
    server.getRadiusServer().setSharedSecret('shared');
    server.getRadiusServer().addUser('bob', 'otp-999', [], { challenge: { prompt: 'Enter your one-time code:' } });
    client.getRadiusClient().addServer('10.0.0.2', 'shared', { timeoutMs: 200, retransmit: 0 });

    const accepted = await client.getRadiusClient().authenticate('bob', 'wrong-code');
    expect(accepted).toBe(false);
  });
});
