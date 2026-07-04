import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { MACAddress, IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { attr, UDP_PORT_RADIUS_AUTH, type RadiusAttribute } from '@/network/radius/types';
import { eapPacketToWireHex, eapPacketFromWireHex, computeEapMd5Response, type EapPacket } from '@/network/radius/eap';
import { parseAuthorization } from '@/network/radius/authorization';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

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

/** Drives a full EAP-MD5 conversation through RadiusClientAgent.sendEapRound(), the way an 802.1X authenticator relaying a supplicant's answers would — used here to validate the RADIUS side end-to-end without a real supplicant device. */
async function runEapMd5(
  nas: CiscoRouter, username: string, password: string,
): Promise<{ accepted: boolean; attributes: RadiusAttribute[] }> {
  const client = nas.getRadiusClient();
  const identityReq: EapPacket = { type: 'eap', code: 'response', identifier: 1, eapType: 'identity', payload: username };
  const round1 = await client.sendEapRound(username, eapPacketToWireHex(identityReq), null);
  if (round1.kind !== 'challenge') return { accepted: false, attributes: [] };
  const challengeEap = eapPacketFromWireHex(round1.eapMessageHex);
  expect(challengeEap?.eapType).toBe('md5-challenge');
  const response = computeEapMd5Response(challengeEap!.identifier, password, challengeEap!.md5Challenge!);
  const responseEap: EapPacket = {
    type: 'eap', code: 'response', identifier: challengeEap!.identifier,
    eapType: 'md5-challenge', md5Response: response,
  };
  const round2 = await client.sendEapRound(username, eapPacketToWireHex(responseEap), round1.state);
  if (round2.kind === 'accept') {
    const finalEap = round2.eapMessageHex ? eapPacketFromWireHex(round2.eapMessageHex) : null;
    expect(finalEap?.code).toBe('success');
    return { accepted: true, attributes: round2.attributes };
  }
  if (round2.kind === 'reject') {
    const finalEap = round2.eapMessageHex ? eapPacketFromWireHex(round2.eapMessageHex) : null;
    expect(finalEap?.code).toBe('failure');
  }
  return { accepted: false, attributes: [] };
}

describe('RADIUS EAP-MD5 relay (RFC 3579)', () => {
  it('accepts a correct EAP-MD5 exchange end to end', async () => {
    const bus = new EventBus();
    const { nas, server } = setupLab(bus);
    server.getRadiusServer().setSharedSecret('shared');
    server.getRadiusServer().addUser('alice', 'wonderland');
    nas.getRadiusClient().addServer('10.0.0.2', 'shared', { timeoutMs: 200, retransmit: 0 });

    const result = await runEapMd5(nas, 'alice', 'wonderland');
    expect(result.accepted).toBe(true);
  });

  it('rejects an EAP-MD5 exchange with the wrong password', async () => {
    const bus = new EventBus();
    const { nas, server } = setupLab(bus);
    server.getRadiusServer().setSharedSecret('shared');
    server.getRadiusServer().addUser('alice', 'wonderland');
    nas.getRadiusClient().addServer('10.0.0.2', 'shared', { timeoutMs: 200, retransmit: 0 });

    const result = await runEapMd5(nas, 'alice', 'wrong-password');
    expect(result.accepted).toBe(false);
  });

  it('rejects an EAP-MD5 exchange for an unknown user', async () => {
    const bus = new EventBus();
    const { nas, server } = setupLab(bus);
    server.getRadiusServer().setSharedSecret('shared');
    nas.getRadiusClient().addServer('10.0.0.2', 'shared', { timeoutMs: 200, retransmit: 0 });

    const result = await runEapMd5(nas, 'ghost', 'whatever');
    expect(result.accepted).toBe(false);
  });

  it('carries RFC 3580 authorization attributes (dynamic VLAN, priv-lvl) on Access-Accept', async () => {
    const bus = new EventBus();
    const { nas, server } = setupLab(bus);
    server.getRadiusServer().setSharedSecret('shared');
    server.getRadiusServer().addUser('alice', 'wonderland', [
      attr('tunnel-type', 13),
      attr('tunnel-medium-type', 6),
      attr('tunnel-private-group-id', '100'),
      attr('vendor-specific', 'shell:priv-lvl=15', { id: 9, type: 1 }),
    ]);
    nas.getRadiusClient().addServer('10.0.0.2', 'shared', { timeoutMs: 200, retransmit: 0 });

    const result = await runEapMd5(nas, 'alice', 'wonderland');
    expect(result.accepted).toBe(true);
    const auth = parseAuthorization(result.attributes);
    expect(auth.vlanId).toBe(100);
    expect(auth.privilegeLevel).toBe(15);
  });

  it('drops an Access-Request with EAP-Message but no Message-Authenticator (RFC 3579 §3.2)', async () => {
    const bus = new EventBus();
    const { server } = setupLab(bus);
    server.getRadiusServer().setSharedSecret('shared');
    server.getRadiusServer().addUser('alice', 'wonderland');

    const received: unknown[] = [];
    bus.subscribe('radius.packet.received', (e) => received.push(e.payload));

    // Hand-craft a bare UDP delivery bypassing RadiusClientAgent (which always signs) to prove the server enforces this itself.
    server.getRadiusServer().handleUdp('GigabitEthernet0/0', new IPAddress('10.0.0.9'), {
      type: 'udp', sourcePort: 50000, destinationPort: UDP_PORT_RADIUS_AUTH, length: 0, checksum: 0,
      payload: {
        type: 'radius', code: 'access-request', identifier: 1, authenticator: '00'.repeat(16),
        attributes: [
          attr('user-name', 'alice'),
          attr('eap-message', eapPacketToWireHex({ type: 'eap', code: 'response', identifier: 1, eapType: 'identity', payload: 'alice' })),
        ],
      },
    });

    expect(received.length).toBe(0);
  });
});
