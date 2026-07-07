import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { MACAddress, IPAddress, SubnetMask, resetCounters, type EthernetFrame } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { UDP_PORT_RADIUS_AUTH, type RadiusPacket } from '@/network/radius/types';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

/** Drill an Ethernet frame down to its RADIUS payload, if it carries one. */
function radiusPayloadOf(frame: EthernetFrame): RadiusPacket | null {
  const ip = frame.payload as { payload?: unknown } | undefined;
  const udp = ip?.payload as { type?: string; payload?: unknown } | undefined;
  if (udp?.type !== 'udp') return null;
  const radius = udp.payload as RadiusPacket | undefined;
  return radius?.type === 'radius' ? radius : null;
}

function setupLab(bus: EventBus) {
  const client = new CiscoRouter('NAS');
  const server = new CiscoRouter('AAA');
  const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
  client.setEventBus(bus); server.setEventBus(bus); sw.setEventBus(bus);
  const cableClientSw = new Cable('a');
  cableClientSw.setEventBus(bus);
  const cableServerSw = new Cable('b');
  cableServerSw.setEventBus(bus);
  cableClientSw.connect(client.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
  cableServerSw.connect(server.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);
  client.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  server.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  return { client, server, sw, cableClientSw, cableServerSw };
}

describe('RADIUS integrity — end-to-end (RFC 2865 §3 / RFC 2869 §5.14)', () => {
  it('client ignores a response with a corrupted Response Authenticator (no retransmit → timeout)', async () => {
    const bus = new EventBus();
    const { client, server, cableServerSw } = setupLab(bus);
    server.getRadiusServer().setSharedSecret('shared');
    server.getRadiusServer().addUser('alice', 'wonderland');
    client.getRadiusClient().addServer('10.0.0.2', 'shared', { timeoutMs: 100, retransmit: 0 });

    // Flip a byte of the Response Authenticator in flight (server → switch hop).
    const unsub = bus.subscribe('cable.frame.dispatched', (e) => {
      if (e.payload.cableId !== cableServerSw.getId()) return;
      const radius = radiusPayloadOf(e.payload.frame as EthernetFrame);
      if (!radius || radius.code !== 'access-accept') return;
      radius.authenticator = (radius.authenticator[0] === '0' ? '1' : '0') + radius.authenticator.slice(1);
    });

    const completed: Array<{ accepted: boolean; reason: string | null }> = [];
    bus.subscribe('radius.auth.completed', (e) => completed.push(e.payload));

    const accepted = await client.getRadiusClient().authenticate('alice', 'wonderland');
    unsub();

    expect(accepted).toBe(false);
    // The corrupted Access-Accept was dropped, not surfaced as a real answer —
    // the only completion the client ever sees is its own timeout.
    expect(completed.length).toBe(1);
    expect(completed[0].reason).toBe('timeout');
  });

  it('server silently discards an Access-Request whose Message-Authenticator was tampered with', async () => {
    const bus = new EventBus();
    const { client, server, cableClientSw } = setupLab(bus);
    server.getRadiusServer().setSharedSecret('shared');
    server.getRadiusServer().addUser('alice', 'wonderland');
    client.getRadiusClient().addServer('10.0.0.2', 'shared', { timeoutMs: 100, retransmit: 0 });

    const unsub = bus.subscribe('cable.frame.dispatched', (e) => {
      if (e.payload.cableId !== cableClientSw.getId()) return;
      const radius = radiusPayloadOf(e.payload.frame as EthernetFrame);
      if (!radius || radius.code !== 'access-request') return;
      const ma = radius.attributes.find((a) => a.type === 'message-authenticator');
      if (ma) ma.value = '00'.repeat(16);
    });

    const serverReceived: unknown[] = [];
    bus.subscribe('radius.packet.received', (e) => {
      if (e.payload.hostname === 'AAA') serverReceived.push(e.payload);
    });
    const serverSent: unknown[] = [];
    bus.subscribe('radius.packet.sent', (e) => {
      if (e.payload.hostname === 'AAA') serverSent.push(e.payload);
    });

    const accepted = await client.getRadiusClient().authenticate('alice', 'wonderland');
    unsub();

    expect(accepted).toBe(false);
    // RFC 3579 §3.2: silently discarded — the server never even logs receipt, let alone replies.
    expect(serverReceived.length).toBe(0);
    expect(serverSent.length).toBe(0);
  });

  it('a genuine retransmission (lost first reply) is answered from the server dedup cache, not reprocessed', async () => {
    const bus = new EventBus();
    const { client, server, cableServerSw } = setupLab(bus);
    server.getRadiusServer().setSharedSecret('shared');
    server.getRadiusServer().addUser('alice', 'wonderland');
    client.getRadiusClient().addServer('10.0.0.2', 'shared', { timeoutMs: 60, retransmit: 1 });

    let firstReplySeen = false;
    const unsub = bus.subscribe('cable.frame.dispatched', (e) => {
      if (e.payload.cableId !== cableServerSw.getId()) return;
      const radius = radiusPayloadOf(e.payload.frame as EthernetFrame);
      if (!radius || radius.code !== 'access-accept') return;
      if (!firstReplySeen) {
        // Simulate the first reply getting lost on the wire: blank out the
        // UDP payload so the client's handleUdp never sees a RADIUS packet
        // at all (matching real packet loss, not just misrouting).
        firstReplySeen = true;
        const ip = (e.payload.frame as EthernetFrame).payload as { payload?: { payload?: unknown } };
        if (ip.payload) ip.payload.payload = undefined;
      }
    });

    const serverReceived: unknown[] = [];
    bus.subscribe('radius.packet.received', (e) => {
      if (e.payload.hostname === 'AAA') serverReceived.push(e.payload);
    });

    const accepted = await client.getRadiusClient().authenticate('alice', 'wonderland');
    unsub();

    expect(accepted).toBe(true);
    // The server saw the request twice on the wire (original + retransmit)
    // but only ever *processed* (and logged receipt of) it once — the
    // second delivery was answered straight from the dedup cache.
    expect(serverReceived.length).toBe(1);
  });
});
