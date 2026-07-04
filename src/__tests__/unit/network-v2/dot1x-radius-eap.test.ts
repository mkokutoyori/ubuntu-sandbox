import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { MACAddress, IPAddress, SubnetMask, resetCounters, type EthernetFrame } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import {
  ETHERTYPE_EAPOL, EAPOL_PAE_GROUP_MAC, type EapolPacket,
} from '@/network/dot1x/types';
import { computeEapMd5Response, type EapPacket } from '@/network/radius/eap';
import { attr } from '@/network/radius/types';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function buildEapolStart(srcMac: string): EthernetFrame {
  const payload: EapolPacket = { type: 'eapol', version: 2, packetType: 'eapol-start' };
  return { srcMAC: new MACAddress(srcMac), dstMAC: new MACAddress(EAPOL_PAE_GROUP_MAC), etherType: ETHERTYPE_EAPOL, payload };
}

function buildEapResponseIdentity(srcMac: string, identifier: number, identity: string): EthernetFrame {
  const payload: EapolPacket = {
    type: 'eapol', version: 2, packetType: 'eap-packet',
    eap: { type: 'eap', code: 'response', identifier, eapType: 'identity', payload: identity },
  };
  return { srcMAC: new MACAddress(srcMac), dstMAC: new MACAddress(EAPOL_PAE_GROUP_MAC), etherType: ETHERTYPE_EAPOL, payload };
}

function buildEapResponseMd5(srcMac: string, identifier: number, responseHex: string): EthernetFrame {
  const payload: EapolPacket = {
    type: 'eapol', version: 2, packetType: 'eap-packet',
    eap: { type: 'eap', code: 'response', identifier, eapType: 'md5-challenge', md5Response: responseHex },
  };
  return { srcMAC: new MACAddress(srcMac), dstMAC: new MACAddress(EAPOL_PAE_GROUP_MAC), etherType: ETHERTYPE_EAPOL, payload };
}

/** Sets up switch(dot1x) <-supplicant, plus a separate router<->RADIUS server segment; wires the switch's Dot1xAgent to the router's real RadiusClientAgent. */
function setupLab(bus: EventBus) {
  const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
  const supplicantSw = new CiscoSwitch('switch-cisco', 'SUP', 4);
  const nas = new CiscoRouter('NAS');
  const server = new CiscoRouter('AAA');
  sw.setEventBus(bus); supplicantSw.setEventBus(bus); nas.setEventBus(bus); server.setEventBus(bus);

  const supplicantCable = new Cable('c');
  supplicantCable.setEventBus(bus);
  supplicantCable.connect(sw.getPort('FastEthernet0/1')!, supplicantSw.getPort('FastEthernet0/1')!);

  new Cable('d').connect(nas.getPort('GigabitEthernet0/0')!, server.getPort('GigabitEthernet0/0')!);
  nas.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  server.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));

  sw.getDot1xAgent().setSystemAuthControl(true);
  sw.getDot1xAgent().setPortMode('FastEthernet0/1', 'auto');
  sw.getDot1xAgent().setRadiusBackend(nas.getRadiusClient());
  nas.getRadiusClient().addServer('10.0.0.2', 'shared', { timeoutMs: 200, retransmit: 0 });
  server.getRadiusServer().setSharedSecret('shared');

  return { sw, supplicantSw, nas, server, supplicantCable };
}

/** RadiusClientAgent.sendEapRound() resolves its promise synchronously once the network delivers a reply, but a `.then()` callback is still only ever run as a microtask — never synchronously, even on an already-resolved promise. Flushing a couple of microtask turns lets Dot1xAgent's `.then(...)` chain (and whatever it triggers) actually run before we inspect the result. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/** Drives EAPOL-Start → EAP-Response/Identity → (captures the relayed MD5 challenge) → EAP-Response/MD5-Challenge. */
async function runSupplicant(
  sw: CiscoSwitch, supplicantSw: CiscoSwitch, bus: EventBus, identity: string, password: string,
): Promise<void> {
  const supplicantMac = supplicantSw.getPort('FastEthernet0/1')!.getMAC().toString();
  let challengeEap: EapPacket | null = null;
  const unsub = bus.subscribe('cable.frame.dispatched', (e) => {
    const frame = e.payload.frame as EthernetFrame;
    if (frame.etherType !== ETHERTYPE_EAPOL) return;
    const eapol = frame.payload as EapolPacket;
    if (eapol.eap?.eapType === 'md5-challenge' && eapol.eap.code === 'request') challengeEap = eapol.eap;
  });

  supplicantSw.getPort('FastEthernet0/1')!.sendFrame(buildEapolStart(supplicantMac));
  const rt = sw.getDot1xAgent().getPortRuntime('FastEthernet0/1')!;
  supplicantSw.getPort('FastEthernet0/1')!.sendFrame(buildEapResponseIdentity(supplicantMac, rt.pendingEapId!, identity));
  await flushMicrotasks();

  unsub();
  expect(challengeEap).not.toBeNull();
  const eap = challengeEap as unknown as EapPacket;
  const response = computeEapMd5Response(eap.identifier, password, eap.md5Challenge!);
  supplicantSw.getPort('FastEthernet0/1')!.sendFrame(buildEapResponseMd5(supplicantMac, eap.identifier, response));
  await flushMicrotasks();
}

describe('802.1X → RADIUS EAP-MD5 relay, end to end', () => {
  it('authorizes the port on a correct EAP-MD5 exchange', async () => {
    const bus = new EventBus();
    const { sw, supplicantSw, server } = setupLab(bus);
    server.getRadiusServer().addUser('alice', 'wonderland');

    await runSupplicant(sw, supplicantSw, bus, 'alice', 'wonderland');

    expect(sw.getDot1xAgent().getPortRuntime('FastEthernet0/1')?.state).toBe('authorized');
    expect(sw.getDot1xAgent().isPortAuthorized('FastEthernet0/1')).toBe(true);
  });

  it('leaves the port unauthorized on a wrong password', async () => {
    const bus = new EventBus();
    const { sw, supplicantSw, server } = setupLab(bus);
    server.getRadiusServer().addUser('alice', 'wonderland');

    await runSupplicant(sw, supplicantSw, bus, 'alice', 'not-the-password');

    expect(sw.getDot1xAgent().getPortRuntime('FastEthernet0/1')?.state).not.toBe('authorized');
    expect(sw.getDot1xAgent().isPortAuthorized('FastEthernet0/1')).toBe(false);
  });

  it('publishes the dynamic VLAN from Tunnel-Private-Group-ID in dot1x.auth.outcome', async () => {
    const bus = new EventBus();
    const { sw, supplicantSw, server } = setupLab(bus);
    server.getRadiusServer().addUser('alice', 'wonderland', [
      attr('tunnel-type', 13),
      attr('tunnel-medium-type', 6),
      attr('tunnel-private-group-id', '200'),
    ]);

    const outcomes: Array<{ accepted: boolean; vlanId?: number }> = [];
    bus.subscribe('dot1x.auth.outcome', (e) => outcomes.push(e.payload));

    await runSupplicant(sw, supplicantSw, bus, 'alice', 'wonderland');

    const last = outcomes[outcomes.length - 1];
    expect(last.accepted).toBe(true);
    expect(last.vlanId).toBe(200);
  });
});
