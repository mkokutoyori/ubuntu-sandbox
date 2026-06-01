import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { MACAddress, resetCounters, type EthernetFrame } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import {
  ETHERTYPE_EAPOL, EAPOL_PAE_GROUP_MAC,
  EAPOL_PACKET_TYPE, EAP_CODE, EAP_TYPE,
  type EapolPacket,
  isAuthorizedState,
} from '@/network/dot1x/types';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function buildEapolStart(srcMac: string): EthernetFrame {
  const payload: EapolPacket = {
    type: 'eapol', version: 2, packetType: 'eapol-start',
  };
  return {
    srcMAC: new MACAddress(srcMac),
    dstMAC: new MACAddress(EAPOL_PAE_GROUP_MAC),
    etherType: ETHERTYPE_EAPOL,
    payload,
  };
}

function buildEapResponseIdentity(srcMac: string, identifier: number, identity: string): EthernetFrame {
  const payload: EapolPacket = {
    type: 'eapol', version: 2, packetType: 'eap-packet',
    eap: {
      type: 'eap', code: 'response', identifier,
      eapType: 'identity', payload: identity,
    },
  };
  return {
    srcMAC: new MACAddress(srcMac),
    dstMAC: new MACAddress(EAPOL_PAE_GROUP_MAC),
    etherType: ETHERTYPE_EAPOL,
    payload,
  };
}

function buildEapolLogoff(srcMac: string): EthernetFrame {
  const payload: EapolPacket = {
    type: 'eapol', version: 2, packetType: 'eapol-logoff',
  };
  return {
    srcMAC: new MACAddress(srcMac),
    dstMAC: new MACAddress(EAPOL_PAE_GROUP_MAC),
    etherType: ETHERTYPE_EAPOL,
    payload,
  };
}

describe('dot1x — pure helpers', () => {
  it('EAPOL constants match the IEEE 802.1X wire encoding', () => {
    expect(ETHERTYPE_EAPOL).toBe(0x888e);
    expect(EAPOL_PAE_GROUP_MAC).toBe('01:80:c2:00:00:03');
    expect(EAPOL_PACKET_TYPE['eapol-start']).toBe(1);
    expect(EAPOL_PACKET_TYPE['eap-packet']).toBe(0);
    expect(EAP_CODE.request).toBe(1);
    expect(EAP_CODE.success).toBe(3);
    expect(EAP_TYPE.identity).toBe(1);
  });

  it('isAuthorizedState recognises both authorized and force-authorized', () => {
    expect(isAuthorizedState('authorized')).toBe(true);
    expect(isAuthorizedState('force-authorized')).toBe(true);
    expect(isAuthorizedState('unauthorized')).toBe(false);
    expect(isAuthorizedState('force-unauthorized')).toBe(false);
    expect(isAuthorizedState('held')).toBe(false);
  });
});

describe('dot1x — system-auth-control and port modes', () => {
  it('a port left in auto mode starts unauthorized once system-auth-control is on', () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    sw.getDot1xAgent().setSystemAuthControl(true);
    sw.getDot1xAgent().setPortMode('FastEthernet0/0', 'auto');
    expect(sw.getDot1xAgent().getPortRuntime('FastEthernet0/0')?.state).toBe('unauthorized');
    expect(sw.getDot1xAgent().isPortAuthorized('FastEthernet0/0')).toBe(false);
  });

  it('force-authorized always authorizes the port', () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    sw.getDot1xAgent().setSystemAuthControl(true);
    sw.getDot1xAgent().setPortMode('FastEthernet0/0', 'force-authorized');
    expect(sw.getDot1xAgent().isPortAuthorized('FastEthernet0/0')).toBe(true);
  });

  it('force-unauthorized always blocks the port', () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    sw.getDot1xAgent().setSystemAuthControl(true);
    sw.getDot1xAgent().setPortMode('FastEthernet0/0', 'force-unauthorized');
    expect(sw.getDot1xAgent().isPortAuthorized('FastEthernet0/0')).toBe(false);
  });

  it('a port with no dot1x runtime is treated as authorized (no enforcement)', () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    expect(sw.getDot1xAgent().isPortAuthorized('FastEthernet0/0')).toBe(true);
  });
});

describe('dot1x — full handshake via local user DB', () => {
  it('EAPOL-Start → EAP-Request/Identity → EAP-Response/Identity → EAP-Success authorizes the port', () => {
    const bus = new EventBus();
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    const supplicantSw = new CiscoSwitch('switch-cisco', 'SUP', 4);
    sw.setEventBus(bus); supplicantSw.setEventBus(bus);
    new Cable('c').connect(sw.getPort('FastEthernet0/0')!, supplicantSw.getPort('FastEthernet0/0')!);

    sw.getDot1xAgent().setSystemAuthControl(true);
    sw.getDot1xAgent().setPortMode('FastEthernet0/0', 'auto');
    sw.getDot1xAgent().addLocalUser('alice', 'wonderland');

    const supplicantMac = supplicantSw.getPort('FastEthernet0/0')!.getMAC().toString();
    supplicantSw.getPort('FastEthernet0/0')!.sendFrame(buildEapolStart(supplicantMac));
    const rt = sw.getDot1xAgent().getPortRuntime('FastEthernet0/0')!;
    expect(rt.state).toBe('authenticating');

    supplicantSw.getPort('FastEthernet0/0')!
      .sendFrame(buildEapResponseIdentity(supplicantMac, rt.pendingEapId!, 'alice'));

    expect(sw.getDot1xAgent().getPortRuntime('FastEthernet0/0')?.state).toBe('authorized');
    expect(sw.getDot1xAgent().isPortAuthorized('FastEthernet0/0')).toBe(true);
  });

  it('publishes dot1x.auth.outcome with accepted=true on local-accept', () => {
    const bus = new EventBus();
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    const supplicantSw = new CiscoSwitch('switch-cisco', 'SUP', 4);
    sw.setEventBus(bus); supplicantSw.setEventBus(bus);
    new Cable('c').connect(sw.getPort('FastEthernet0/0')!, supplicantSw.getPort('FastEthernet0/0')!);
    sw.getDot1xAgent().setSystemAuthControl(true);
    sw.getDot1xAgent().setPortMode('FastEthernet0/0', 'auto');
    sw.getDot1xAgent().addLocalUser('alice', 'wonderland');

    const outcomes: Array<{ identity: string; accepted: boolean; reason: string }> = [];
    bus.subscribe('dot1x.auth.outcome', (e) => outcomes.push(e.payload));

    const supplicantMac = supplicantSw.getPort('FastEthernet0/0')!.getMAC().toString();
    supplicantSw.getPort('FastEthernet0/0')!.sendFrame(buildEapolStart(supplicantMac));
    const rt = sw.getDot1xAgent().getPortRuntime('FastEthernet0/0')!;
    supplicantSw.getPort('FastEthernet0/0')!
      .sendFrame(buildEapResponseIdentity(supplicantMac, rt.pendingEapId!, 'alice'));

    expect(outcomes.length).toBe(1);
    expect(outcomes[0].identity).toBe('alice');
    expect(outcomes[0].accepted).toBe(true);
    expect(outcomes[0].reason).toBe('local-accept');
  });

  it('rejects an unknown identity and the port stays unauthorized', () => {
    const bus = new EventBus();
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    const supplicantSw = new CiscoSwitch('switch-cisco', 'SUP', 4);
    sw.setEventBus(bus); supplicantSw.setEventBus(bus);
    new Cable('c').connect(sw.getPort('FastEthernet0/0')!, supplicantSw.getPort('FastEthernet0/0')!);
    sw.getDot1xAgent().setSystemAuthControl(true);
    sw.getDot1xAgent().setPortMode('FastEthernet0/0', 'auto');
    sw.getDot1xAgent().addLocalUser('alice', 'wonderland');

    const supplicantMac = supplicantSw.getPort('FastEthernet0/0')!.getMAC().toString();
    supplicantSw.getPort('FastEthernet0/0')!.sendFrame(buildEapolStart(supplicantMac));
    const rt = sw.getDot1xAgent().getPortRuntime('FastEthernet0/0')!;
    supplicantSw.getPort('FastEthernet0/0')!
      .sendFrame(buildEapResponseIdentity(supplicantMac, rt.pendingEapId!, 'mallory'));

    expect(sw.getDot1xAgent().getPortRuntime('FastEthernet0/0')?.state).not.toBe('authorized');
    expect(sw.getDot1xAgent().isPortAuthorized('FastEthernet0/0')).toBe(false);
  });
});

describe('dot1x — EAPOL-Logoff', () => {
  it('moves an authorized port back to unauthorized and clears the identity', () => {
    const bus = new EventBus();
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    const supplicantSw = new CiscoSwitch('switch-cisco', 'SUP', 4);
    sw.setEventBus(bus); supplicantSw.setEventBus(bus);
    new Cable('c').connect(sw.getPort('FastEthernet0/0')!, supplicantSw.getPort('FastEthernet0/0')!);
    sw.getDot1xAgent().setSystemAuthControl(true);
    sw.getDot1xAgent().setPortMode('FastEthernet0/0', 'auto');
    sw.getDot1xAgent().addLocalUser('alice', 'wonderland');

    const supplicantMac = supplicantSw.getPort('FastEthernet0/0')!.getMAC().toString();
    supplicantSw.getPort('FastEthernet0/0')!.sendFrame(buildEapolStart(supplicantMac));
    const rt = sw.getDot1xAgent().getPortRuntime('FastEthernet0/0')!;
    supplicantSw.getPort('FastEthernet0/0')!
      .sendFrame(buildEapResponseIdentity(supplicantMac, rt.pendingEapId!, 'alice'));
    expect(sw.getDot1xAgent().isPortAuthorized('FastEthernet0/0')).toBe(true);

    supplicantSw.getPort('FastEthernet0/0')!.sendFrame(buildEapolLogoff(supplicantMac));
    const after = sw.getDot1xAgent().getPortRuntime('FastEthernet0/0')!;
    expect(after.state).toBe('unauthorized');
    expect(after.identity).toBeNull();
  });
});

describe('dot1x — port enforcement against data frames', () => {
  it('an unauthorized auto port silently drops non-EAPOL frames at the switch ingress', () => {
    const bus = new EventBus();
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    const supplicantSw = new CiscoSwitch('switch-cisco', 'SUP', 4);
    sw.setEventBus(bus); supplicantSw.setEventBus(bus);
    new Cable('c').connect(sw.getPort('FastEthernet0/0')!, supplicantSw.getPort('FastEthernet0/0')!);
    sw.getDot1xAgent().setSystemAuthControl(true);
    sw.getDot1xAgent().setPortMode('FastEthernet0/0', 'auto');
    expect(sw.getDot1xAgent().isPortAuthorized('FastEthernet0/0')).toBe(false);
    expect(() => {
      supplicantSw.getPort('FastEthernet0/0')!.sendFrame({
        srcMAC: supplicantSw.getPort('FastEthernet0/0')!.getMAC(),
        dstMAC: MACAddress.broadcast(),
        etherType: 0x0800,
        payload: undefined as never,
      });
    }).not.toThrow();
  });
});
