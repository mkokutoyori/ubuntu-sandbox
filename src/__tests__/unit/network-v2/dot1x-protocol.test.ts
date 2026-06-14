import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

describe('dot1x — held quiet-period timer (IEEE 802.1X §8.2)', () => {
  afterEach(() => vi.useRealTimers());

  it('a held port returns to unauthorized after holdMs, re-authenticable', () => {
    vi.useFakeTimers();
    const bus = new EventBus();
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    const sup = new CiscoSwitch('switch-cisco', 'SUP', 4);
    sw.setEventBus(bus); sup.setEventBus(bus);
    new Cable('c').connect(sw.getPort('FastEthernet0/0')!, sup.getPort('FastEthernet0/0')!);
    const ag = sw.getDot1xAgent();
    ag.setSystemAuthControl(true);
    ag.setPortMode('FastEthernet0/0', 'auto');
    // No local user for 'mallory' ⇒ every attempt is rejected.
    const mac = sup.getPort('FastEthernet0/0')!.getMAC().toString();

    const reasons: string[] = [];
    bus.subscribe('dot1x.port.state.changed', (e) => {
      reasons.push((e.payload as { reason: string; newState: string }).reason
        + ':' + (e.payload as { newState: string }).newState);
    });

    // Fail maxReauthReq (2) times in one session to reach held.
    sup.getPort('FastEthernet0/0')!.sendFrame(buildEapolStart(mac));
    const rt = ag.getPortRuntime('FastEthernet0/0')!;
    sup.getPort('FastEthernet0/0')!
      .sendFrame(buildEapResponseIdentity(mac, rt.pendingEapId!, 'mallory'));
    sup.getPort('FastEthernet0/0')!
      .sendFrame(buildEapResponseIdentity(mac, rt.pendingEapId!, 'mallory'));
    expect(ag.getPortRuntime('FastEthernet0/0')?.state).toBe('held');

    // Before the quiet period elapses it is still held.
    vi.advanceTimersByTime(59_000);
    expect(ag.getPortRuntime('FastEthernet0/0')?.state).toBe('held');

    // After holdMs (60s) the port auto-recovers to unauthorized.
    vi.advanceTimersByTime(2_000);
    expect(ag.getPortRuntime('FastEthernet0/0')?.state).toBe('unauthorized');
    expect(reasons).toContain('hold-expired:unauthorized');
    expect(ag.getPortRuntime('FastEthernet0/0')?.reauthCount).toBe(0);
  });

  it('a successful auth before the quiet period elapses cancels the held timer', () => {
    vi.useFakeTimers();
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    const sup = new CiscoSwitch('switch-cisco', 'SUP', 4);
    new Cable('c').connect(sw.getPort('FastEthernet0/0')!, sup.getPort('FastEthernet0/0')!);
    const ag = sw.getDot1xAgent();
    ag.setSystemAuthControl(true);
    ag.setPortMode('FastEthernet0/0', 'auto');
    ag.addLocalUser('alice', 'wonderland');
    const mac = sup.getPort('FastEthernet0/0')!.getMAC().toString();

    sup.getPort('FastEthernet0/0')!.sendFrame(buildEapolStart(mac));
    let rt = ag.getPortRuntime('FastEthernet0/0')!;
    sup.getPort('FastEthernet0/0')!
      .sendFrame(buildEapResponseIdentity(mac, rt.pendingEapId!, 'mallory'));
    sup.getPort('FastEthernet0/0')!
      .sendFrame(buildEapResponseIdentity(mac, rt.pendingEapId!, 'mallory'));
    expect(ag.getPortRuntime('FastEthernet0/0')?.state).toBe('held');

    // Authenticate successfully (force the held timer to be cancelled).
    rt.holdUntilMs = 0;        // allow a fresh EAPOL-Start during the quiet period
    sup.getPort('FastEthernet0/0')!.sendFrame(buildEapolStart(mac));
    rt = ag.getPortRuntime('FastEthernet0/0')!;
    sup.getPort('FastEthernet0/0')!
      .sendFrame(buildEapResponseIdentity(mac, rt.pendingEapId!, 'alice'));
    expect(ag.isPortAuthorized('FastEthernet0/0')).toBe(true);

    vi.advanceTimersByTime(120_000);
    expect(ag.getPortRuntime('FastEthernet0/0')?.state).toBe('authorized');
  });
});

describe('dot1x — de-authorization flushes the port MAC table', () => {
  it('an EAPOL-Logoff purges the dynamic MACs learned while authorized', () => {
    const bus = new EventBus();
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    const sup = new CiscoSwitch('switch-cisco', 'SUP', 4);
    sw.setEventBus(bus); sup.setEventBus(bus);
    new Cable('c').connect(sw.getPort('FastEthernet0/0')!, sup.getPort('FastEthernet0/0')!);
    const ag = sw.getDot1xAgent();
    ag.setSystemAuthControl(true);
    ag.setPortMode('FastEthernet0/0', 'auto');
    ag.addLocalUser('alice', 'wonderland');
    const mac = sup.getPort('FastEthernet0/0')!.getMAC().toString();

    sup.getPort('FastEthernet0/0')!.sendFrame(buildEapolStart(mac));
    const rt = ag.getPortRuntime('FastEthernet0/0')!;
    sup.getPort('FastEthernet0/0')!
      .sendFrame(buildEapResponseIdentity(mac, rt.pendingEapId!, 'alice'));
    expect(ag.isPortAuthorized('FastEthernet0/0')).toBe(true);

    // Learn a dynamic MAC on the now-authorized port.
    sup.getPort('FastEthernet0/0')!.sendFrame({
      srcMAC: new MACAddress('00:de:ad:be:ef:01'),
      dstMAC: MACAddress.broadcast(),
      etherType: 0x0800, payload: undefined as never,
    });
    expect(sw.getMACTable().some((e) => e.mac === '00:de:ad:be:ef:01')).toBe(true);

    // Logoff de-authorizes the port → its learned MACs are flushed.
    const flushed: number[] = [];
    bus.subscribe('switch.mac.flushed', (e) => flushed.push((e.payload as { count: number }).count));
    sup.getPort('FastEthernet0/0')!.sendFrame(buildEapolLogoff(mac));

    expect(ag.isPortAuthorized('FastEthernet0/0')).toBe(false);
    expect(sw.getMACTable().some((e) => e.mac === '00:de:ad:be:ef:01')).toBe(false);
    expect(flushed.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
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
