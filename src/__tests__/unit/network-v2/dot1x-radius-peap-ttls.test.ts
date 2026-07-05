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
import type { EapPacket } from '@/network/radius/eap';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import { EapTlsPeerSession, type EapTlsPeerOptions } from '@/network/radius/eaptls/EapTlsPeerSession';
import type { EapTlsConfig } from '@/network/radius/eaptls/EapTlsConfig';
import { TtlsPapInnerAuthServer, TtlsPapInnerAuthPeer } from '@/network/radius/eaptls/TtlsInnerAuth';
import { PeapMd5InnerAuthServer, PeapMd5InnerAuthPeer } from '@/network/radius/eaptls/PeapInnerAuth';
import { CiscoRouter as CiscoRouterClass } from '@/network/devices/CiscoRouter';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

const NOW = Date.now();

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

function buildEapResponse(srcMac: string, eap: EapPacket): EthernetFrame {
  const payload: EapolPacket = { type: 'eapol', version: 2, packetType: 'eap-packet', eap };
  return { srcMAC: new MACAddress(srcMac), dstMAC: new MACAddress(EAPOL_PAE_GROUP_MAC), etherType: ETHERTYPE_EAPOL, payload };
}

function lookupUserFn(server: CiscoRouterClass): (username: string) => { username: string; password: string } | undefined {
  return (username: string) => server.getRadiusServer().listUsers().find((u) => u.username === username);
}

/** Mirrors dot1x-radius-eaptls.test.ts's setupLab, but arms the RADIUS server via a factory (so it can reference the already-built `server` — e.g. to look up users registered afterward). */
function setupLab(bus: EventBus, buildConfig: (server: CiscoRouterClass) => EapTlsConfig) {
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
  nas.getRadiusClient().addServer('10.0.0.2', 'shared', { timeoutMs: 500, retransmit: 0 });
  server.getRadiusServer().setSharedSecret('shared');
  server.getRadiusServer().setEapTlsConfig(buildConfig(server));

  return { sw, supplicantSw, nas, server };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function runTunnelSupplicant(
  sw: CiscoSwitch, supplicantSw: CiscoSwitch, bus: EventBus, peer: EapTlsPeerSession, identity: string,
): Promise<'success' | 'failure' | 'timeout'> {
  const supplicantMac = supplicantSw.getPort('FastEthernet0/1')!.getMAC().toString();
  let latestEap: EapPacket | null = null;
  const unsub = bus.subscribe('cable.frame.dispatched', (e) => {
    const frame = e.payload.frame as EthernetFrame;
    if (frame.etherType !== ETHERTYPE_EAPOL) return;
    const eapol = frame.payload as EapolPacket;
    if (!eapol.eap) return;
    if (eapol.eap.code === 'request' && (eapol.eap.eapType === 'tls' || eapol.eap.eapType === 'peap' || eapol.eap.eapType === 'ttls')) {
      latestEap = eapol.eap;
    }
    if (eapol.eap.code === 'success' || eapol.eap.code === 'failure') latestEap = eapol.eap;
  });

  supplicantSw.getPort('FastEthernet0/1')!.sendFrame(buildEapolStart(supplicantMac));
  const rt = sw.getDot1xAgent().getPortRuntime('FastEthernet0/1')!;
  supplicantSw.getPort('FastEthernet0/1')!.sendFrame(buildEapResponseIdentity(supplicantMac, rt.pendingEapId!, identity));
  await flushMicrotasks();

  try {
    for (let round = 0; round < 200; round++) {
      if (!latestEap) return 'timeout';
      const eap: EapPacket = latestEap;
      if (eap.code === 'success') return 'success';
      if (eap.code === 'failure') return 'failure';
      latestEap = null;
      const response = peer.handle(eap);
      supplicantSw.getPort('FastEthernet0/1')!.sendFrame(buildEapResponse(supplicantMac, response));
      await flushMicrotasks();
    }
    return 'timeout';
  } finally {
    unsub();
  }
}

describe('802.1X → RADIUS EAP-TTLS relay, end to end (RFC 5281)', () => {
  it('authorizes the port on correct inner PAP credentials, no client certificate needed', async () => {
    const bus = new EventBus();
    const ca = CertificateAuthority.generate('CN=radius-ca', { now: NOW });
    const serverIssued = ca.issueCertificate({ subject: 'CN=aaa-server', notBefore: NOW - 1000, notAfter: NOW + 1e9 });
    const verifier = new CertificateVerifier({ trustAnchors: [ca.rootCertificate], clock: () => NOW });

    const { sw, supplicantSw, server } = setupLab(bus, (srv) => {
      srv.getRadiusServer().addUser('alice', 'wonderland');
      return {
        serverCert: serverIssued.cert, verifier, requireClientCert: false,
        eapType: 'ttls', innerAuth: new TtlsPapInnerAuthServer(lookupUserFn(srv)),
      };
    });

    const peerOpts: EapTlsPeerOptions = { eapType: 'ttls', innerAuth: new TtlsPapInnerAuthPeer('alice', 'wonderland') };
    const peer = new EapTlsPeerSession(null, verifier, peerOpts);

    const outcome = await runTunnelSupplicant(sw, supplicantSw, bus, peer, 'alice');

    expect(outcome).toBe('success');
    expect(sw.getDot1xAgent().isPortAuthorized('FastEthernet0/1')).toBe(true);
    void server;
  });

  it('leaves the port unauthorized on a wrong inner PAP password', async () => {
    const bus = new EventBus();
    const ca = CertificateAuthority.generate('CN=radius-ca', { now: NOW });
    const serverIssued = ca.issueCertificate({ subject: 'CN=aaa-server', notBefore: NOW - 1000, notAfter: NOW + 1e9 });
    const verifier = new CertificateVerifier({ trustAnchors: [ca.rootCertificate], clock: () => NOW });

    const { sw, supplicantSw } = setupLab(bus, (srv) => {
      srv.getRadiusServer().addUser('alice', 'wonderland');
      return {
        serverCert: serverIssued.cert, verifier, requireClientCert: false,
        eapType: 'ttls', innerAuth: new TtlsPapInnerAuthServer(lookupUserFn(srv)),
      };
    });

    const peer = new EapTlsPeerSession(null, verifier, { eapType: 'ttls', innerAuth: new TtlsPapInnerAuthPeer('alice', 'wrong') });

    const outcome = await runTunnelSupplicant(sw, supplicantSw, bus, peer, 'alice');

    expect(outcome).toBe('failure');
    expect(sw.getDot1xAgent().isPortAuthorized('FastEthernet0/1')).toBe(false);
  });
});

describe('802.1X → RADIUS PEAP relay, end to end (inner EAP-MD5)', () => {
  it('authorizes the port on a correct inner EAP-MD5 password, no client certificate needed', async () => {
    const bus = new EventBus();
    const ca = CertificateAuthority.generate('CN=radius-ca', { now: NOW });
    const serverIssued = ca.issueCertificate({ subject: 'CN=aaa-server', notBefore: NOW - 1000, notAfter: NOW + 1e9 });
    const verifier = new CertificateVerifier({ trustAnchors: [ca.rootCertificate], clock: () => NOW });

    const { sw, supplicantSw } = setupLab(bus, (srv) => {
      srv.getRadiusServer().addUser('alice', 'wonderland');
      return {
        serverCert: serverIssued.cert, verifier, requireClientCert: false,
        eapType: 'peap', innerAuth: new PeapMd5InnerAuthServer(lookupUserFn(srv)),
      };
    });

    const peer = new EapTlsPeerSession(null, verifier, { eapType: 'peap', innerAuth: new PeapMd5InnerAuthPeer('alice', 'wonderland') });

    const outcome = await runTunnelSupplicant(sw, supplicantSw, bus, peer, 'alice');

    expect(outcome).toBe('success');
    expect(sw.getDot1xAgent().isPortAuthorized('FastEthernet0/1')).toBe(true);
  });

  it('leaves the port unauthorized on a wrong inner password', async () => {
    const bus = new EventBus();
    const ca = CertificateAuthority.generate('CN=radius-ca', { now: NOW });
    const serverIssued = ca.issueCertificate({ subject: 'CN=aaa-server', notBefore: NOW - 1000, notAfter: NOW + 1e9 });
    const verifier = new CertificateVerifier({ trustAnchors: [ca.rootCertificate], clock: () => NOW });

    const { sw, supplicantSw } = setupLab(bus, (srv) => {
      srv.getRadiusServer().addUser('alice', 'wonderland');
      return {
        serverCert: serverIssued.cert, verifier, requireClientCert: false,
        eapType: 'peap', innerAuth: new PeapMd5InnerAuthServer(lookupUserFn(srv)),
      };
    });

    const peer = new EapTlsPeerSession(null, verifier, { eapType: 'peap', innerAuth: new PeapMd5InnerAuthPeer('alice', 'not-the-password') });

    const outcome = await runTunnelSupplicant(sw, supplicantSw, bus, peer, 'alice');

    expect(outcome).toBe('failure');
    expect(sw.getDot1xAgent().isPortAuthorized('FastEthernet0/1')).toBe(false);
  });
});
