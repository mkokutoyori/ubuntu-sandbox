/**
 * Scénario 13 — Révocation de certificat X.509 et impact sur un tunnel
 * IPsec actif : comparaison CRL (téléchargement périodique) vs OCSP
 * (vérification en temps réel).
 *
 * Topologie :
 *
 *   [PC1] -- [R1 IPsec peer, cert-auth] === IPsec === [R2 IPsec peer, cert-auth] -- [PC2]
 *
 * Modèle :
 *   - Une CA `SharedCA` signe les certificats des deux pairs.
 *   - R1 fait confiance à la CA et vérifie le cert de R2 soit via une
 *     CRL statique (téléchargée périodiquement), soit via un OCSP
 *     responder qui interroge la CA en temps réel.
 *   - À un instant T, la CA révoque le cert de R2 (`ca.revoke(...)`).
 *
 * Ce qui est vérifié :
 *   - la révocation NE tue PAS la SA en cours (aucun mécanisme ne
 *     "pousse" la révocation vers un tunnel actif) — la détection se
 *     fait uniquement à la prochaine renégociation IKE ;
 *   - CRL : la vulnerability window est explicitement démontrée — si la
 *     CRL locale n'est pas rafraîchie, la renégociation SUIVANT la
 *     révocation continue de réussir ; ce n'est qu'après un
 *     rechargement de la CRL que le cert est rejeté ;
 *   - OCSP : la renégociation SUIVANT la révocation échoue déjà
 *     immédiatement, sans intervention entre la révocation et la
 *     renégociation ;
 *   - dans les deux cas, un log `ipsec:cert-revoked` daté est émis au
 *     moment exact où la passerelle prend connaissance de la
 *     révocation (traçabilité conforme aux exigences d'audit) ;
 *   - le motif "Certificate revoked" apparaît dans
 *     `show crypto isakmp sa detail` avec la même granularité.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import { OcspResponder } from '@/network/pki/OcspResponder';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import { getDefaultEventBus } from '@/events/EventBus';

const NOW = Date.parse('2026-07-01T00:00:00Z');
const ONE_YEAR = 365 * 24 * 3600 * 1000;
const ONE_HOUR = 3600 * 1000;

interface CertRevokedLog {
  entries: Array<{ deviceId: string; timestamp: number; message: string; event: string }>;
}

function captureCertRevokedLog(): CertRevokedLog {
  const log: CertRevokedLog = { entries: [] };
  getDefaultEventBus().subscribe('log', (e) => {
    const p = e.payload as { source?: string; event?: string; message?: string };
    if (p.event === 'ipsec:cert-revoked' || p.event === 'ipsec:cert-verify-failed') {
      log.entries.push({
        deviceId: p.source || '',
        timestamp: Date.now(),
        message: p.message || '',
        event: p.event,
      });
    }
  });
  return log;
}

async function buildLab() {
  const r1 = new CiscoRouter('R1');
  const r2 = new CiscoRouter('R2');
  const pc1 = new LinuxPC('linux-pc', 'PC1');
  const pc2 = new LinuxPC('linux-pc', 'PC2');
  new Cable('wan').connect(r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/1')!);
  new Cable('lan1').connect(pc1.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
  new Cable('lan2').connect(pc2.getPort('eth0')!, r2.getPort('GigabitEthernet0/0')!);
  return { r1, r2, pc1, pc2 };
}

async function configureBase(
  router: CiscoRouter,
  wanIp: string, peerWan: string, lanIp: string,
  localSubnet: string, remoteSubnet: string,
): Promise<void> {
  for (const cmd of [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/1', `ip address ${wanIp} 255.255.255.252`, 'no shutdown', 'exit',
    'interface GigabitEthernet0/0', `ip address ${lanIp} 255.255.255.0`, 'no shutdown', 'exit',
    'crypto ikev2 proposal PROP', 'encryption aes-cbc-256', 'integrity sha256', 'group 14', 'exit',
    'crypto ikev2 policy POL', 'proposal PROP', 'exit',
    'crypto ipsec transform-set TSET esp-aes 256 esp-sha256-hmac', 'mode tunnel', 'exit',
    'ip access-list extended VPN_ACL',
    `permit ip ${localSubnet} 0.0.0.255 ${remoteSubnet} 0.0.0.255`, 'exit',
    `ip route ${remoteSubnet} 255.255.255.0 ${peerWan}`,
    'end',
  ]) await router.executeCommand(cmd);
}

async function configureX509Profile(router: CiscoRouter, peerWan: string, profile: string): Promise<void> {
  for (const cmd of [
    'enable', 'configure terminal',
    `crypto ikev2 profile ${profile}`,
    `match identity remote address ${peerWan} 255.255.255.255`,
    'authentication remote rsa-sig', 'authentication local rsa-sig', 'exit',
    'crypto map CMAP 10 ipsec-isakmp',
    `set peer ${peerWan}`, `set ikev2-profile ${profile}`,
    'set transform-set TSET', 'match address VPN_ACL', 'exit',
    'interface GigabitEthernet0/1', 'crypto map CMAP', 'exit', 'end',
  ]) await router.executeCommand(cmd);
}

async function seedPcs(pc1: LinuxPC, pc2: LinuxPC): Promise<void> {
  await pc1.executeCommand('sudo ip addr add 192.168.1.10/24 dev eth0');
  await pc1.executeCommand('sudo ip route add default via 192.168.1.1');
  await pc2.executeCommand('sudo ip addr add 192.168.2.10/24 dev eth0');
  await pc2.executeCommand('sudo ip route add default via 192.168.2.1');
}

async function bounceCryptoOnPeers(r1: CiscoRouter, r2: CiscoRouter): Promise<void> {
  await r1.executeCommand('enable');
  await r1.executeCommand('clear crypto sa');
  await r1.executeCommand('clear crypto isakmp');
  await r2.executeCommand('enable');
  await r2.executeCommand('clear crypto sa');
  await r2.executeCommand('clear crypto isakmp');
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

describe('Scenario 13 — cert revocation on active IPsec tunnel: CRL vs OCSP', () => {
  describe('13.A — nominal establishment under CRL and under OCSP', () => {
    it('X.509 tunnel with revocation-check=crl comes up cleanly when CRL is empty', async () => {
      const l = await buildLab();
      await configureBase(l.r1, '10.0.12.1', '10.0.12.2', '192.168.1.1', '192.168.1.0', '192.168.2.0');
      await configureBase(l.r2, '10.0.12.2', '10.0.12.1', '192.168.2.1', '192.168.2.0', '192.168.1.0');
      const ca = CertificateAuthority.generate('CN=SharedCA', { now: NOW });
      const c1 = ca.issueCertificate({ subject: 'CN=10.0.12.1', notBefore: NOW - 1000, notAfter: NOW + ONE_YEAR });
      const c2 = ca.issueCertificate({ subject: 'CN=10.0.12.2', notBefore: NOW - 1000, notAfter: NOW + ONE_YEAR });
      const emptyCrl = ca.publishCRL(NOW);
      l.r1.installIkeCertAuth({ localCert: c1.cert, localKey: c1.privateKey, trustAnchors: [ca.rootCertificate], crls: [emptyCrl], revocationCheck: 'crl', clock: () => NOW });
      l.r2.installIkeCertAuth({ localCert: c2.cert, localKey: c2.privateKey, trustAnchors: [ca.rootCertificate], crls: [emptyCrl], revocationCheck: 'crl', clock: () => NOW });
      await configureX509Profile(l.r1, '10.0.12.2', 'PROF1');
      await configureX509Profile(l.r2, '10.0.12.1', 'PROF2');
      await seedPcs(l.pc1, l.pc2);
      const ping = await l.pc1.executeCommand('ping -c 2 192.168.2.10');
      expect(ping).toContain('2 received');
    });

    it('X.509 tunnel with revocation-check=ocsp comes up cleanly when OCSP says good', async () => {
      const l = await buildLab();
      await configureBase(l.r1, '10.0.12.1', '10.0.12.2', '192.168.1.1', '192.168.1.0', '192.168.2.0');
      await configureBase(l.r2, '10.0.12.2', '10.0.12.1', '192.168.2.1', '192.168.2.0', '192.168.1.0');
      const ca = CertificateAuthority.generate('CN=SharedCA', { now: NOW });
      const c1 = ca.issueCertificate({ subject: 'CN=10.0.12.1', notBefore: NOW - 1000, notAfter: NOW + ONE_YEAR });
      const c2 = ca.issueCertificate({ subject: 'CN=10.0.12.2', notBefore: NOW - 1000, notAfter: NOW + ONE_YEAR });
      const responder = new OcspResponder(ca);
      l.r1.installIkeCertAuth({ localCert: c1.cert, localKey: c1.privateKey, trustAnchors: [ca.rootCertificate], revocationCheck: 'ocsp', ocspResponder: responder, clock: () => NOW });
      l.r2.installIkeCertAuth({ localCert: c2.cert, localKey: c2.privateKey, trustAnchors: [ca.rootCertificate], revocationCheck: 'ocsp', ocspResponder: responder, clock: () => NOW });
      await configureX509Profile(l.r1, '10.0.12.2', 'PROF1');
      await configureX509Profile(l.r2, '10.0.12.1', 'PROF2');
      await seedPcs(l.pc1, l.pc2);
      const ping = await l.pc1.executeCommand('ping -c 2 192.168.2.10');
      expect(ping).toContain('2 received');
      expect(responder.getQueryCount()).toBeGreaterThan(0);
    });
  });

  describe('13.B — CRL: revocation with stale local CRL does NOT tear down the next negotiation', () => {
    it('after CA revocation, if R1 keeps the pre-revocation CRL, re-negotiation still succeeds (vulnerability window)', async () => {
      const l = await buildLab();
      await configureBase(l.r1, '10.0.12.1', '10.0.12.2', '192.168.1.1', '192.168.1.0', '192.168.2.0');
      await configureBase(l.r2, '10.0.12.2', '10.0.12.1', '192.168.2.1', '192.168.2.0', '192.168.1.0');
      const ca = CertificateAuthority.generate('CN=SharedCA', { now: NOW });
      const c1 = ca.issueCertificate({ subject: 'CN=10.0.12.1', notBefore: NOW - 1000, notAfter: NOW + ONE_YEAR });
      const c2 = ca.issueCertificate({ subject: 'CN=10.0.12.2', notBefore: NOW - 1000, notAfter: NOW + ONE_YEAR });
      const staleCrl = ca.publishCRL(NOW, ONE_HOUR);
      l.r1.installIkeCertAuth({ localCert: c1.cert, localKey: c1.privateKey, trustAnchors: [ca.rootCertificate], crls: [staleCrl], revocationCheck: 'crl', clock: () => NOW });
      l.r2.installIkeCertAuth({ localCert: c2.cert, localKey: c2.privateKey, trustAnchors: [ca.rootCertificate], crls: [staleCrl], revocationCheck: 'crl', clock: () => NOW });
      await configureX509Profile(l.r1, '10.0.12.2', 'PROF1');
      await configureX509Profile(l.r2, '10.0.12.1', 'PROF2');
      await seedPcs(l.pc1, l.pc2);
      const pingBefore = await l.pc1.executeCommand('ping -c 1 192.168.2.10');
      expect(pingBefore).toContain('1 received');

      ca.revoke(c2.cert.serialNumber, NOW);
      await bounceCryptoOnPeers(l.r1, l.r2);

      const pingAfter = await l.pc1.executeCommand('ping -c 2 192.168.2.10');
      expect(pingAfter).toContain('2 received');
      const detail = await l.r1.executeCommand('show crypto isakmp sa detail');
      expect(detail).not.toMatch(/Certificate revoked/i);
    });

    it('once the fresh CRL is installed, the next negotiation is rejected', async () => {
      const log = captureCertRevokedLog();
      const l = await buildLab();
      await configureBase(l.r1, '10.0.12.1', '10.0.12.2', '192.168.1.1', '192.168.1.0', '192.168.2.0');
      await configureBase(l.r2, '10.0.12.2', '10.0.12.1', '192.168.2.1', '192.168.2.0', '192.168.1.0');
      const ca = CertificateAuthority.generate('CN=SharedCA', { now: NOW });
      const c1 = ca.issueCertificate({ subject: 'CN=10.0.12.1', notBefore: NOW - 1000, notAfter: NOW + ONE_YEAR });
      const c2 = ca.issueCertificate({ subject: 'CN=10.0.12.2', notBefore: NOW - 1000, notAfter: NOW + ONE_YEAR });
      const emptyCrl = ca.publishCRL(NOW);
      l.r1.installIkeCertAuth({ localCert: c1.cert, localKey: c1.privateKey, trustAnchors: [ca.rootCertificate], crls: [emptyCrl], revocationCheck: 'crl', clock: () => NOW });
      l.r2.installIkeCertAuth({ localCert: c2.cert, localKey: c2.privateKey, trustAnchors: [ca.rootCertificate], crls: [emptyCrl], revocationCheck: 'crl', clock: () => NOW });
      await configureX509Profile(l.r1, '10.0.12.2', 'PROF1');
      await configureX509Profile(l.r2, '10.0.12.1', 'PROF2');
      await seedPcs(l.pc1, l.pc2);
      await l.pc1.executeCommand('ping -c 1 192.168.2.10');

      ca.revoke(c2.cert.serialNumber, NOW);
      const freshCrl = ca.publishCRL(NOW);
      l.r1.installIkeCertAuth({ localCert: c1.cert, localKey: c1.privateKey, trustAnchors: [ca.rootCertificate], crls: [freshCrl], revocationCheck: 'crl', clock: () => NOW });
      await bounceCryptoOnPeers(l.r1, l.r2);

      await l.pc1.executeCommand('ping -c 1 192.168.2.10');
      const detail = await l.r1.executeCommand('show crypto isakmp sa detail');
      expect(detail).toMatch(/Certificate revoked/i);
      const revokedOnR1 = log.entries.filter((e) => e.deviceId === l.r1.getId() && e.event === 'ipsec:cert-revoked');
      expect(revokedOnR1.length).toBeGreaterThan(0);
    });
  });

  describe('13.C — OCSP: revocation is detected at the very next renegotiation', () => {
    it('after CA revocation, the immediately-following renegotiation is rejected without any CRL push', async () => {
      const log = captureCertRevokedLog();
      const l = await buildLab();
      await configureBase(l.r1, '10.0.12.1', '10.0.12.2', '192.168.1.1', '192.168.1.0', '192.168.2.0');
      await configureBase(l.r2, '10.0.12.2', '10.0.12.1', '192.168.2.1', '192.168.2.0', '192.168.1.0');
      const ca = CertificateAuthority.generate('CN=SharedCA', { now: NOW });
      const c1 = ca.issueCertificate({ subject: 'CN=10.0.12.1', notBefore: NOW - 1000, notAfter: NOW + ONE_YEAR });
      const c2 = ca.issueCertificate({ subject: 'CN=10.0.12.2', notBefore: NOW - 1000, notAfter: NOW + ONE_YEAR });
      const responder = new OcspResponder(ca);
      l.r1.installIkeCertAuth({ localCert: c1.cert, localKey: c1.privateKey, trustAnchors: [ca.rootCertificate], revocationCheck: 'ocsp', ocspResponder: responder, clock: () => NOW });
      l.r2.installIkeCertAuth({ localCert: c2.cert, localKey: c2.privateKey, trustAnchors: [ca.rootCertificate], revocationCheck: 'ocsp', ocspResponder: responder, clock: () => NOW });
      await configureX509Profile(l.r1, '10.0.12.2', 'PROF1');
      await configureX509Profile(l.r2, '10.0.12.1', 'PROF2');
      await seedPcs(l.pc1, l.pc2);
      const pingBefore = await l.pc1.executeCommand('ping -c 1 192.168.2.10');
      expect(pingBefore).toContain('1 received');

      ca.revoke(c2.cert.serialNumber, NOW);
      await bounceCryptoOnPeers(l.r1, l.r2);

      await l.pc1.executeCommand('ping -c 1 192.168.2.10');
      const detail = await l.r1.executeCommand('show crypto isakmp sa detail');
      expect(detail).toMatch(/Certificate revoked/i);
      const revokedOnR1 = log.entries.filter((e) => e.deviceId === l.r1.getId() && e.event === 'ipsec:cert-revoked');
      expect(revokedOnR1.length).toBeGreaterThan(0);
    });

    it('OCSP consultation count grows on every renegotiation (real-time query, no local cache)', async () => {
      const l = await buildLab();
      await configureBase(l.r1, '10.0.12.1', '10.0.12.2', '192.168.1.1', '192.168.1.0', '192.168.2.0');
      await configureBase(l.r2, '10.0.12.2', '10.0.12.1', '192.168.2.1', '192.168.2.0', '192.168.1.0');
      const ca = CertificateAuthority.generate('CN=SharedCA', { now: NOW });
      const c1 = ca.issueCertificate({ subject: 'CN=10.0.12.1', notBefore: NOW - 1000, notAfter: NOW + ONE_YEAR });
      const c2 = ca.issueCertificate({ subject: 'CN=10.0.12.2', notBefore: NOW - 1000, notAfter: NOW + ONE_YEAR });
      const responder = new OcspResponder(ca);
      l.r1.installIkeCertAuth({ localCert: c1.cert, localKey: c1.privateKey, trustAnchors: [ca.rootCertificate], revocationCheck: 'ocsp', ocspResponder: responder, clock: () => NOW });
      l.r2.installIkeCertAuth({ localCert: c2.cert, localKey: c2.privateKey, trustAnchors: [ca.rootCertificate], revocationCheck: 'ocsp', ocspResponder: responder, clock: () => NOW });
      await configureX509Profile(l.r1, '10.0.12.2', 'PROF1');
      await configureX509Profile(l.r2, '10.0.12.1', 'PROF2');
      await seedPcs(l.pc1, l.pc2);
      await l.pc1.executeCommand('ping -c 1 192.168.2.10');
      const firstQueryCount = responder.getQueryCount();
      expect(firstQueryCount).toBeGreaterThan(0);

      await bounceCryptoOnPeers(l.r1, l.r2);
      await l.pc1.executeCommand('ping -c 1 192.168.2.10');
      const secondQueryCount = responder.getQueryCount();
      expect(secondQueryCount).toBeGreaterThan(firstQueryCount);
    });
  });

  describe('13.D — active SA is NOT torn down by a revocation-in-flight', () => {
    it('revocation between two pings (no rekey trigger in between) does not break the running SA', async () => {
      const l = await buildLab();
      await configureBase(l.r1, '10.0.12.1', '10.0.12.2', '192.168.1.1', '192.168.1.0', '192.168.2.0');
      await configureBase(l.r2, '10.0.12.2', '10.0.12.1', '192.168.2.1', '192.168.2.0', '192.168.1.0');
      const ca = CertificateAuthority.generate('CN=SharedCA', { now: NOW });
      const c1 = ca.issueCertificate({ subject: 'CN=10.0.12.1', notBefore: NOW - 1000, notAfter: NOW + ONE_YEAR });
      const c2 = ca.issueCertificate({ subject: 'CN=10.0.12.2', notBefore: NOW - 1000, notAfter: NOW + ONE_YEAR });
      const responder = new OcspResponder(ca);
      l.r1.installIkeCertAuth({ localCert: c1.cert, localKey: c1.privateKey, trustAnchors: [ca.rootCertificate], revocationCheck: 'ocsp', ocspResponder: responder, clock: () => NOW });
      l.r2.installIkeCertAuth({ localCert: c2.cert, localKey: c2.privateKey, trustAnchors: [ca.rootCertificate], revocationCheck: 'ocsp', ocspResponder: responder, clock: () => NOW });
      await configureX509Profile(l.r1, '10.0.12.2', 'PROF1');
      await configureX509Profile(l.r2, '10.0.12.1', 'PROF2');
      await seedPcs(l.pc1, l.pc2);
      await l.pc1.executeCommand('ping -c 1 192.168.2.10');

      ca.revoke(c2.cert.serialNumber, NOW);

      const pingAfter = await l.pc1.executeCommand('ping -c 2 192.168.2.10');
      expect(pingAfter).toContain('2 received');
    });
  });

  describe('13.E — audit trail: the log line pinpoints the moment the gateway learned about revocation', () => {
    it('the ipsec:cert-revoked log carries the peer IP and its timestamp is the negotiation instant', async () => {
      const log = captureCertRevokedLog();
      const l = await buildLab();
      await configureBase(l.r1, '10.0.12.1', '10.0.12.2', '192.168.1.1', '192.168.1.0', '192.168.2.0');
      await configureBase(l.r2, '10.0.12.2', '10.0.12.1', '192.168.2.1', '192.168.2.0', '192.168.1.0');
      const ca = CertificateAuthority.generate('CN=SharedCA', { now: NOW });
      const c1 = ca.issueCertificate({ subject: 'CN=10.0.12.1', notBefore: NOW - 1000, notAfter: NOW + ONE_YEAR });
      const c2 = ca.issueCertificate({ subject: 'CN=10.0.12.2', notBefore: NOW - 1000, notAfter: NOW + ONE_YEAR });
      const responder = new OcspResponder(ca);
      l.r1.installIkeCertAuth({ localCert: c1.cert, localKey: c1.privateKey, trustAnchors: [ca.rootCertificate], revocationCheck: 'ocsp', ocspResponder: responder, clock: () => NOW });
      l.r2.installIkeCertAuth({ localCert: c2.cert, localKey: c2.privateKey, trustAnchors: [ca.rootCertificate], revocationCheck: 'ocsp', ocspResponder: responder, clock: () => NOW });
      await configureX509Profile(l.r1, '10.0.12.2', 'PROF1');
      await configureX509Profile(l.r2, '10.0.12.1', 'PROF2');
      await seedPcs(l.pc1, l.pc2);
      await l.pc1.executeCommand('ping -c 1 192.168.2.10');

      ca.revoke(c2.cert.serialNumber, NOW);
      await bounceCryptoOnPeers(l.r1, l.r2);
      const tBefore = Date.now();
      await l.pc1.executeCommand('ping -c 1 192.168.2.10');
      const tAfter = Date.now();

      const revokedOnR1 = log.entries.filter((e) => e.deviceId === l.r1.getId() && e.event === 'ipsec:cert-revoked');
      expect(revokedOnR1.length).toBeGreaterThan(0);
      const last = revokedOnR1[revokedOnR1.length - 1];
      expect(last.message).toContain('peer=10.0.12.2');
      expect(last.timestamp).toBeGreaterThanOrEqual(tBefore);
      expect(last.timestamp).toBeLessThanOrEqual(tAfter);
    });

    it('CertificateVerifier unit test: OCSP with a revoked serial returns revoked; without responder returns crl-stale', () => {
      const ca = CertificateAuthority.generate('CN=UnitCA', { now: NOW });
      const cert = ca.issueCertificate({ subject: 'CN=leaf', notBefore: NOW - 1000, notAfter: NOW + ONE_YEAR });
      const responder = new OcspResponder(ca);
      const goodVerifier = new CertificateVerifier({
        trustAnchors: [ca.rootCertificate], revocationCheck: 'ocsp', ocspResponder: responder, clock: () => NOW,
      });
      const goodResult = goodVerifier.verify(cert.cert);
      expect(goodResult.ok).toBe(true);

      ca.revoke(cert.cert.serialNumber, NOW);
      const revokedResult = goodVerifier.verify(cert.cert);
      expect(revokedResult.ok).toBe(false);
      if (!revokedResult.ok) expect(revokedResult.reason).toBe('revoked');

      const noResponderVerifier = new CertificateVerifier({
        trustAnchors: [ca.rootCertificate], revocationCheck: 'ocsp', clock: () => NOW,
      });
      const staleResult = noResponderVerifier.verify(cert.cert);
      expect(staleResult.ok).toBe(false);
      if (!staleResult.ok) expect(staleResult.reason).toBe('crl-stale');
    });
  });

  describe('13.F — reactivity comparison', () => {
    it('OCSP has zero-latency detection window compared to CRL after revocation', async () => {
      const l = await buildLab();
      await configureBase(l.r1, '10.0.12.1', '10.0.12.2', '192.168.1.1', '192.168.1.0', '192.168.2.0');
      await configureBase(l.r2, '10.0.12.2', '10.0.12.1', '192.168.2.1', '192.168.2.0', '192.168.1.0');
      const ca = CertificateAuthority.generate('CN=SharedCA', { now: NOW });
      const c1 = ca.issueCertificate({ subject: 'CN=10.0.12.1', notBefore: NOW - 1000, notAfter: NOW + ONE_YEAR });
      const c2 = ca.issueCertificate({ subject: 'CN=10.0.12.2', notBefore: NOW - 1000, notAfter: NOW + ONE_YEAR });
      const staleCrl = ca.publishCRL(NOW, ONE_HOUR);
      const responder = new OcspResponder(ca);

      l.r1.installIkeCertAuth({ localCert: c1.cert, localKey: c1.privateKey, trustAnchors: [ca.rootCertificate], revocationCheck: 'ocsp', ocspResponder: responder, clock: () => NOW });
      l.r2.installIkeCertAuth({ localCert: c2.cert, localKey: c2.privateKey, trustAnchors: [ca.rootCertificate], revocationCheck: 'ocsp', ocspResponder: responder, clock: () => NOW });
      await configureX509Profile(l.r1, '10.0.12.2', 'PROF1');
      await configureX509Profile(l.r2, '10.0.12.1', 'PROF2');
      await seedPcs(l.pc1, l.pc2);
      await l.pc1.executeCommand('ping -c 1 192.168.2.10');
      ca.revoke(c2.cert.serialNumber, NOW);
      await bounceCryptoOnPeers(l.r1, l.r2);
      await l.pc1.executeCommand('ping -c 1 192.168.2.10');
      const detailOcsp = await l.r1.executeCommand('show crypto isakmp sa detail');
      expect(detailOcsp).toMatch(/Certificate revoked/i);

      const l2 = await buildLab();
      await configureBase(l2.r1, '10.0.12.1', '10.0.12.2', '192.168.1.1', '192.168.1.0', '192.168.2.0');
      await configureBase(l2.r2, '10.0.12.2', '10.0.12.1', '192.168.2.1', '192.168.2.0', '192.168.1.0');
      l2.r1.installIkeCertAuth({ localCert: c1.cert, localKey: c1.privateKey, trustAnchors: [ca.rootCertificate], crls: [staleCrl], revocationCheck: 'crl', clock: () => NOW });
      l2.r2.installIkeCertAuth({ localCert: c2.cert, localKey: c2.privateKey, trustAnchors: [ca.rootCertificate], crls: [staleCrl], revocationCheck: 'crl', clock: () => NOW });
      await configureX509Profile(l2.r1, '10.0.12.2', 'PROF1');
      await configureX509Profile(l2.r2, '10.0.12.1', 'PROF2');
      await seedPcs(l2.pc1, l2.pc2);
      await l2.pc1.executeCommand('ping -c 1 192.168.2.10');
      await bounceCryptoOnPeers(l2.r1, l2.r2);
      await l2.pc1.executeCommand('ping -c 1 192.168.2.10');
      const detailCrl = await l2.r1.executeCommand('show crypto isakmp sa detail');
      expect(detailCrl).not.toMatch(/Certificate revoked/i);
    });
  });
});
