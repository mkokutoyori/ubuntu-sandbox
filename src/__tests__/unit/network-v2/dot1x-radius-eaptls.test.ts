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
import { EapTlsPeerSession } from '@/network/radius/eaptls/EapTlsPeerSession';
import type { X509Certificate } from '@/network/pki/X509Certificate';
import type { PkiPrivateKey } from '@/network/pki/PkiKeyPair';

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

function buildEapResponseTls(srcMac: string, eap: EapPacket): EthernetFrame {
  const payload: EapolPacket = { type: 'eapol', version: 2, packetType: 'eap-packet', eap };
  return { srcMAC: new MACAddress(srcMac), dstMAC: new MACAddress(EAPOL_PAE_GROUP_MAC), etherType: ETHERTYPE_EAPOL, payload };
}

/** Mirrors dot1x-radius-eap.test.ts's setupLab, but arms the RADIUS server for EAP-TLS instead of EAP-MD5. */
function setupLab(
  bus: EventBus, serverCert: X509Certificate, serverPrivateKey: PkiPrivateKey, verifier: CertificateVerifier,
  opts: { requireClientCert?: boolean; mtu?: number } = {},
) {
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
  server.getRadiusServer().setEapTlsConfig({
    serverCert, serverPrivateKey, verifier,
    requireClientCert: opts.requireClientCert ?? true,
    mtu: opts.mtu,
  });

  return { sw, supplicantSw, nas, server };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/** Drives EAPOL-Start → EAP-Response/Identity → the full (possibly multi-round, fragmented) EAP-TLS conversation, using `peer` for every round. */
async function runEapTlsSupplicant(
  sw: CiscoSwitch, supplicantSw: CiscoSwitch, bus: EventBus, peer: EapTlsPeerSession, identity: string,
): Promise<'success' | 'failure' | 'timeout'> {
  const supplicantMac = supplicantSw.getPort('FastEthernet0/1')!.getMAC().toString();
  let latestEap: EapPacket | null = null;
  const unsub = bus.subscribe('cable.frame.dispatched', (e) => {
    const frame = e.payload.frame as EthernetFrame;
    if (frame.etherType !== ETHERTYPE_EAPOL) return;
    const eapol = frame.payload as EapolPacket;
    if (!eapol.eap) return;
    if (eapol.eap.code === 'request' && eapol.eap.eapType === 'tls') latestEap = eapol.eap;
    if (eapol.eap.code === 'success' || eapol.eap.code === 'failure') latestEap = eapol.eap;
  });

  supplicantSw.getPort('FastEthernet0/1')!.sendFrame(buildEapolStart(supplicantMac));
  const rt = sw.getDot1xAgent().getPortRuntime('FastEthernet0/1')!;
  supplicantSw.getPort('FastEthernet0/1')!.sendFrame(buildEapResponseIdentity(supplicantMac, rt.pendingEapId!, identity));
  await flushMicrotasks();

  try {
    // RFC 8446 flights carry a full certificate chain + signature, so a
    // tiny 40-byte MTU now needs noticeably more fragments/rounds than the
    // old ad hoc 2-RTT model did — 150 comfortably covers that case.
    for (let round = 0; round < 150; round++) {
      if (!latestEap) return 'timeout';
      const eap: EapPacket = latestEap;
      if (eap.code === 'success') return 'success';
      if (eap.code === 'failure') return 'failure';
      latestEap = null;
      const response = peer.handle(eap);
      supplicantSw.getPort('FastEthernet0/1')!.sendFrame(buildEapResponseTls(supplicantMac, response));
      await flushMicrotasks();
    }
    return 'timeout';
  } finally {
    unsub();
  }
}

describe('802.1X → RADIUS EAP-TLS relay, end to end (RFC 5216)', () => {
  it('authorizes the port when both certificates chain to the trusted CA', async () => {
    const bus = new EventBus();
    const ca = CertificateAuthority.generate('CN=radius-ca', { now: NOW });
    const serverIssued = ca.issueCertificate({ subject: 'CN=aaa-server', notBefore: NOW - 1000, notAfter: NOW + 1e9 });
    const clientIssued = ca.issueCertificate({ subject: 'CN=alice', notBefore: NOW - 1000, notAfter: NOW + 1e9 });
    const verifier = new CertificateVerifier({ trustAnchors: [ca.rootCertificate], clock: () => NOW });

    const { sw, supplicantSw } = setupLab(bus, serverIssued.cert, serverIssued.privateKey, verifier);
    const peer = new EapTlsPeerSession(clientIssued.cert, verifier, { clientPrivateKey: clientIssued.privateKey });

    const outcome = await runEapTlsSupplicant(sw, supplicantSw, bus, peer, 'alice');

    expect(outcome).toBe('success');
    expect(sw.getDot1xAgent().getPortRuntime('FastEthernet0/1')?.state).toBe('authorized');
    expect(sw.getDot1xAgent().isPortAuthorized('FastEthernet0/1')).toBe(true);
  });

  it('leaves the port unauthorized when the client certificate is from an untrusted CA', async () => {
    const bus = new EventBus();
    const ca = CertificateAuthority.generate('CN=radius-ca', { now: NOW });
    const otherCa = CertificateAuthority.generate('CN=rogue-ca', { now: NOW });
    const serverIssued = ca.issueCertificate({ subject: 'CN=aaa-server', notBefore: NOW - 1000, notAfter: NOW + 1e9 });
    const roguedClient = otherCa.issueCertificate({ subject: 'CN=mallory', notBefore: NOW - 1000, notAfter: NOW + 1e9 });
    const serverVerifier = new CertificateVerifier({ trustAnchors: [ca.rootCertificate], clock: () => NOW });
    const peerVerifier = new CertificateVerifier({ trustAnchors: [ca.rootCertificate], clock: () => NOW });

    const { sw, supplicantSw } = setupLab(bus, serverIssued.cert, serverIssued.privateKey, serverVerifier);
    const peer = new EapTlsPeerSession(roguedClient.cert, peerVerifier, { clientPrivateKey: roguedClient.privateKey });

    const outcome = await runEapTlsSupplicant(sw, supplicantSw, bus, peer, 'mallory');

    expect(outcome).toBe('failure');
    expect(sw.getDot1xAgent().getPortRuntime('FastEthernet0/1')?.state).not.toBe('authorized');
    expect(sw.getDot1xAgent().isPortAuthorized('FastEthernet0/1')).toBe(false);
  });

  it('completes over 802.1X + RADIUS even when a tiny MTU forces every flight to fragment', async () => {
    const bus = new EventBus();
    const ca = CertificateAuthority.generate('CN=radius-ca', { now: NOW });
    const serverIssued = ca.issueCertificate({ subject: 'CN=aaa-server', notBefore: NOW - 1000, notAfter: NOW + 1e9 });
    const clientIssued = ca.issueCertificate({ subject: 'CN=alice', notBefore: NOW - 1000, notAfter: NOW + 1e9 });
    const verifier = new CertificateVerifier({ trustAnchors: [ca.rootCertificate], clock: () => NOW });

    const { sw, supplicantSw } = setupLab(bus, serverIssued.cert, serverIssued.privateKey, verifier, { mtu: 40 });
    const peer = new EapTlsPeerSession(clientIssued.cert, verifier, { mtu: 40, clientPrivateKey: clientIssued.privateKey });

    const outcome = await runEapTlsSupplicant(sw, supplicantSw, bus, peer, 'alice');

    expect(outcome).toBe('success');
    expect(sw.getDot1xAgent().isPortAuthorized('FastEthernet0/1')).toBe(true);
  });
});
