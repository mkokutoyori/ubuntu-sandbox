import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { MACAddress, IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { decryptMppeKey } from '@/network/radius/mschapv2';
import { getVsa } from '@/network/radius/types';
import { MICROSOFT_VENDOR_ID } from '@/network/radius/dictionary';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

/** MS-CHAPv2 over RADIUS (RFC 2759, RFC 2548) — a single Access-Request/Access-Accept-or-Reject round, no challenge round-trip of its own. */
function setupLab(bus: EventBus) {
  const nas = new CiscoRouter('NAS');
  const server = new CiscoRouter('AAA');
  const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
  nas.setEventBus(bus); server.setEventBus(bus); sw.setEventBus(bus);
  const cableA = new Cable('a');
  const cableB = new Cable('b');
  cableA.setEventBus(bus);
  cableB.setEventBus(bus);
  cableA.connect(nas.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
  cableB.connect(server.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);
  nas.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  server.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  server.getRadiusServer().setSharedSecret('shared');
  nas.getRadiusClient().addServer('10.0.0.2', 'shared', { timeoutMs: 200, retransmit: 0 });
  return { nas, server };
}

describe('MS-CHAPv2 over RADIUS (RFC 2759 / RFC 2548)', () => {
  it('accepts a registered user and returns a valid mutual-auth AuthenticatorResponse', async () => {
    const bus = new EventBus();
    const { nas, server } = setupLab(bus);
    server.getRadiusServer().addUser('alice', 'wonderland');

    const outcome = await nas.getRadiusClient().authenticateMsChapV2('alice', 'wonderland');
    expect(outcome.kind).toBe('accept');
    if (outcome.kind === 'accept') expect(outcome.authenticatorResponseValid).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const bus = new EventBus();
    const { nas, server } = setupLab(bus);
    server.getRadiusServer().addUser('alice', 'wonderland');

    const outcome = await nas.getRadiusClient().authenticateMsChapV2('alice', 'wrong-password');
    expect(outcome.kind).toBe('reject');
  });

  it('rejects an unknown user', async () => {
    const bus = new EventBus();
    const { nas } = setupLab(bus);

    const outcome = await nas.getRadiusClient().authenticateMsChapV2('bob', 'whatever');
    expect(outcome.kind).toBe('reject');
  });

  it('carries MS-MPPE-Send-Key/Recv-Key VSAs on accept, decryptable with the shared secret', async () => {
    const bus = new EventBus();
    const { nas, server } = setupLab(bus);
    server.getRadiusServer().addUser('alice', 'wonderland');

    type RadiusLike = { type?: string; code?: string; authenticator?: string; attributes?: Array<{ type: string; value: unknown; vendor?: { id: number; type: number } }> };
    let requestAuthenticator: string | null = null;
    let acceptPacket: RadiusLike | null = null;
    bus.subscribe('cable.frame.dispatched', (e) => {
      const ipPkt = e.payload.frame.payload as { payload?: { payload?: RadiusLike } } | undefined;
      const radius = ipPkt?.payload?.payload;
      if (radius?.type !== 'radius') return;
      if (radius.code === 'access-request') requestAuthenticator = radius.authenticator ?? null;
      if (radius.code === 'access-accept') acceptPacket = radius;
    });

    const outcome = await nas.getRadiusClient().authenticateMsChapV2('alice', 'wonderland');
    expect(outcome.kind).toBe('accept');
    expect(acceptPacket).not.toBeNull();
    expect(requestAuthenticator).not.toBeNull();

    const sendKeyVsa = getVsa(acceptPacket! as never, MICROSOFT_VENDOR_ID, 16);
    const recvKeyVsa = getVsa(acceptPacket! as never, MICROSOFT_VENDOR_ID, 17);
    expect(sendKeyVsa).toBeDefined();
    expect(recvKeyVsa).toBeDefined();
    const sendKey = decryptMppeKey(String(sendKeyVsa!.value), 'shared', requestAuthenticator!);
    const recvKey = decryptMppeKey(String(recvKeyVsa!.value), 'shared', requestAuthenticator!);
    expect(sendKey.length).toBe(16);
    expect(recvKey.length).toBe(16);
    expect(Array.from(sendKey)).not.toEqual(Array.from(recvKey));
  });

  it('publishes radius.packet.received/sent for the round', async () => {
    const bus = new EventBus();
    const { nas, server } = setupLab(bus);
    server.getRadiusServer().addUser('alice', 'wonderland');

    const received: string[] = [];
    bus.subscribe('radius.packet.received', (e) => received.push(e.payload.code));
    await nas.getRadiusClient().authenticateMsChapV2('alice', 'wonderland');
    expect(received).toContain('access-accept');
  });

  it('times out when no server is reachable', async () => {
    const nas = new CiscoRouter('NAS');
    nas.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    nas.getRadiusClient().addServer('10.0.0.99', 'shared', { timeoutMs: 50, retransmit: 0 });

    const outcome = await nas.getRadiusClient().authenticateMsChapV2('alice', 'wonderland');
    expect(outcome.kind).toBe('timeout');
  });

  it('Huawei NAS authenticates via MS-CHAPv2 against a Cisco RADIUS server', async () => {
    const bus = new EventBus();
    const nas = new HuaweiRouter('HW-NAS');
    const server = new CiscoRouter('AAA');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    nas.setEventBus(bus); server.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(nas.getPort('GE0/0/0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('b').connect(server.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);
    nas.getPort('GE0/0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    server.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
    server.getRadiusServer().setSharedSecret('shared');
    server.getRadiusServer().addUser('alice', 'wonderland');
    nas.getRadiusClient().addServer('10.0.0.2', 'shared', { timeoutMs: 200, retransmit: 0 });

    const outcome = await nas.getRadiusClient().authenticateMsChapV2('alice', 'wonderland');
    expect(outcome.kind).toBe('accept');
  });
});
