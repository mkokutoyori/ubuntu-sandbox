import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import { X509Certificate } from '@/network/pki/X509Certificate';
import { CertificateRevocationList } from '@/network/pki/CertificateRevocationList';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';

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

async function configurePskProfile(router: CiscoRouter, peerWan: string, psk: string, keyring: string, profile: string): Promise<void> {
  for (const cmd of [
    'enable', 'configure terminal',
    `crypto ikev2 keyring ${keyring}`, 'peer P', `address ${peerWan}`, `pre-shared-key ${psk}`, 'exit', 'exit',
    `crypto ikev2 profile ${profile}`,
    `match identity remote address ${peerWan} 255.255.255.255`,
    'authentication remote pre-share', 'authentication local pre-share',
    `keyring local ${keyring}`, 'exit',
    'crypto map CMAP 10 ipsec-isakmp',
    `set peer ${peerWan}`, `set ikev2-profile ${profile}`,
    'set transform-set TSET', 'match address VPN_ACL', 'exit',
    'interface GigabitEthernet0/1', 'crypto map CMAP', 'exit', 'end',
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

const NOW = Date.parse('2026-07-01T00:00:00Z');
const ONE_YEAR = 365 * 24 * 3600 * 1000;

describe('Scénario 3 — Authentification IKE: PSK vs X.509', () => {
  beforeEach(() => {
    resetCounters();
    resetDeviceCounters();
    Logger.reset();
  });

  describe('§A — PSK', () => {
    it('PSK correcte des deux côtés: le tunnel s\'établit, ping OK', async () => {
      const l = await buildLab();
      await configureBase(l.r1, '10.0.12.1', '10.0.12.2', '192.168.1.1', '192.168.1.0', '192.168.2.0');
      await configureBase(l.r2, '10.0.12.2', '10.0.12.1', '192.168.2.1', '192.168.2.0', '192.168.1.0');
      await configurePskProfile(l.r1, '10.0.12.2', 'SecretMatching', 'KR1', 'PROF1');
      await configurePskProfile(l.r2, '10.0.12.1', 'SecretMatching', 'KR2', 'PROF2');
      await seedPcs(l.pc1, l.pc2);
      const ping = await l.pc1.executeCommand('ping -c 3 192.168.2.10');
      expect(ping).toContain('3 received');
      const sa = await l.r1.executeCommand('show crypto ikev2 sa');
      expect(sa).toMatch(/READY/);
    });

    it('PSK divergente: échec authentication failed, message générique (pas de détail de cause)', async () => {
      const l = await buildLab();
      await configureBase(l.r1, '10.0.12.1', '10.0.12.2', '192.168.1.1', '192.168.1.0', '192.168.2.0');
      await configureBase(l.r2, '10.0.12.2', '10.0.12.1', '192.168.2.1', '192.168.2.0', '192.168.1.0');
      await configurePskProfile(l.r1, '10.0.12.2', 'SecretA', 'KR1', 'PROF1');
      await configurePskProfile(l.r2, '10.0.12.1', 'SecretB', 'KR2', 'PROF2');
      await seedPcs(l.pc1, l.pc2);
      await l.pc1.executeCommand('ping -c 1 192.168.2.10');
      const detail = await l.r1.executeCommand('show crypto isakmp sa detail');
      expect(detail).toMatch(/Last negotiation failure:.*PSK mismatch|authentication failed/i);
      expect(detail).not.toMatch(/certificate/i);
    });
  });

  describe('§B — X.509', () => {
    it('deux certificats émis par la même CA et non expirés: le tunnel s\'établit', async () => {
      const l = await buildLab();
      await configureBase(l.r1, '10.0.12.1', '10.0.12.2', '192.168.1.1', '192.168.1.0', '192.168.2.0');
      await configureBase(l.r2, '10.0.12.2', '10.0.12.1', '192.168.2.1', '192.168.2.0', '192.168.1.0');
      const ca = CertificateAuthority.generate('CN=SharedCA', { now: NOW });
      const cert1 = ca.issueCertificate({ subject: 'CN=10.0.12.1', notBefore: NOW - 1000, notAfter: NOW + ONE_YEAR });
      const cert2 = ca.issueCertificate({ subject: 'CN=10.0.12.2', notBefore: NOW - 1000, notAfter: NOW + ONE_YEAR });
      l.r1.installIkeCertAuth({ localCert: cert1.cert, localKey: cert1.privateKey, trustAnchors: [ca.rootCertificate] });
      l.r2.installIkeCertAuth({ localCert: cert2.cert, localKey: cert2.privateKey, trustAnchors: [ca.rootCertificate] });
      await configureX509Profile(l.r1, '10.0.12.2', 'PROF1');
      await configureX509Profile(l.r2, '10.0.12.1', 'PROF2');
      await seedPcs(l.pc1, l.pc2);
      const ping = await l.pc1.executeCommand('ping -c 2 192.168.2.10');
      expect(ping).toContain('2 received');
      const sa = await l.r1.executeCommand('show crypto ikev2 sa');
      expect(sa).toMatch(/READY/);
    });

    it('certificat émis par une CA différente (non de confiance): rejet distinct "Certificate unknown"', async () => {
      const l = await buildLab();
      await configureBase(l.r1, '10.0.12.1', '10.0.12.2', '192.168.1.1', '192.168.1.0', '192.168.2.0');
      await configureBase(l.r2, '10.0.12.2', '10.0.12.1', '192.168.2.1', '192.168.2.0', '192.168.1.0');
      const caTrusted = CertificateAuthority.generate('CN=TrustedCA', { now: NOW });
      const caRogue = CertificateAuthority.generate('CN=RogueCA', { now: NOW });
      const cert1 = caTrusted.issueCertificate({ subject: 'CN=10.0.12.1', notBefore: NOW - 1000, notAfter: NOW + ONE_YEAR });
      const cert2 = caRogue.issueCertificate({ subject: 'CN=10.0.12.2', notBefore: NOW - 1000, notAfter: NOW + ONE_YEAR });
      l.r1.installIkeCertAuth({ localCert: cert1.cert, localKey: cert1.privateKey, trustAnchors: [caTrusted.rootCertificate] });
      l.r2.installIkeCertAuth({ localCert: cert2.cert, localKey: cert2.privateKey, trustAnchors: [caTrusted.rootCertificate] });
      await configureX509Profile(l.r1, '10.0.12.2', 'PROF1');
      await configureX509Profile(l.r2, '10.0.12.1', 'PROF2');
      await seedPcs(l.pc1, l.pc2);
      await l.pc1.executeCommand('ping -c 1 192.168.2.10');
      const detail = await l.r1.executeCommand('show crypto isakmp sa detail');
      expect(detail).toMatch(/Certificate unknown/i);
    });

    it('certificat local expiré (notAfter dans le passé): rejet distinct "Certificate expired"', async () => {
      const l = await buildLab();
      await configureBase(l.r1, '10.0.12.1', '10.0.12.2', '192.168.1.1', '192.168.1.0', '192.168.2.0');
      await configureBase(l.r2, '10.0.12.2', '10.0.12.1', '192.168.2.1', '192.168.2.0', '192.168.1.0');
      const ca = CertificateAuthority.generate('CN=SharedCA', { now: NOW });
      const goodCert = ca.issueCertificate({ subject: 'CN=10.0.12.1', notBefore: NOW - 1000, notAfter: NOW + ONE_YEAR });
      const expiredCert = ca.issueCertificate({ subject: 'CN=10.0.12.2', notBefore: NOW - 2 * ONE_YEAR, notAfter: NOW - ONE_YEAR });
      l.r1.installIkeCertAuth({ localCert: goodCert.cert, localKey: goodCert.privateKey, trustAnchors: [ca.rootCertificate], clock: () => NOW });
      l.r2.installIkeCertAuth({ localCert: expiredCert.cert, localKey: expiredCert.privateKey, trustAnchors: [ca.rootCertificate], clock: () => NOW });
      await configureX509Profile(l.r1, '10.0.12.2', 'PROF1');
      await configureX509Profile(l.r2, '10.0.12.1', 'PROF2');
      await seedPcs(l.pc1, l.pc2);
      await l.pc1.executeCommand('ping -c 1 192.168.2.10');
      const detail = await l.r1.executeCommand('show crypto isakmp sa detail');
      expect(detail).toMatch(/Certificate expired/i);
      expect(detail).not.toMatch(/Certificate unknown/i);
      expect(detail).not.toMatch(/Certificate revoked/i);
    });

    it('certificat révoqué (présent dans la CRL) avec revocation-check activé: rejet "Certificate revoked"', async () => {
      const l = await buildLab();
      await configureBase(l.r1, '10.0.12.1', '10.0.12.2', '192.168.1.1', '192.168.1.0', '192.168.2.0');
      await configureBase(l.r2, '10.0.12.2', '10.0.12.1', '192.168.2.1', '192.168.2.0', '192.168.1.0');
      const ca = CertificateAuthority.generate('CN=SharedCA', { now: NOW });
      const cert1 = ca.issueCertificate({ subject: 'CN=10.0.12.1', notBefore: NOW - 1000, notAfter: NOW + ONE_YEAR });
      const cert2 = ca.issueCertificate({ subject: 'CN=10.0.12.2', notBefore: NOW - 1000, notAfter: NOW + ONE_YEAR });
      ca.revoke(cert2.cert.serialNumber, NOW - 10);
      const crl = ca.publishCRL(NOW);
      l.r1.installIkeCertAuth({ localCert: cert1.cert, localKey: cert1.privateKey, trustAnchors: [ca.rootCertificate], crls: [crl], revocationCheck: 'crl', clock: () => NOW });
      l.r2.installIkeCertAuth({ localCert: cert2.cert, localKey: cert2.privateKey, trustAnchors: [ca.rootCertificate], clock: () => NOW });
      await configureX509Profile(l.r1, '10.0.12.2', 'PROF1');
      await configureX509Profile(l.r2, '10.0.12.1', 'PROF2');
      await seedPcs(l.pc1, l.pc2);
      await l.pc1.executeCommand('ping -c 1 192.168.2.10');
      const detail = await l.r1.executeCommand('show crypto isakmp sa detail');
      expect(detail).toMatch(/Certificate revoked/i);
    });

    it('même certificat révoqué mais revocation-check désactivé: le tunnel s\'établit (choix opérationnel)', async () => {
      const l = await buildLab();
      await configureBase(l.r1, '10.0.12.1', '10.0.12.2', '192.168.1.1', '192.168.1.0', '192.168.2.0');
      await configureBase(l.r2, '10.0.12.2', '10.0.12.1', '192.168.2.1', '192.168.2.0', '192.168.1.0');
      const ca = CertificateAuthority.generate('CN=SharedCA', { now: NOW });
      const cert1 = ca.issueCertificate({ subject: 'CN=10.0.12.1', notBefore: NOW - 1000, notAfter: NOW + ONE_YEAR });
      const cert2 = ca.issueCertificate({ subject: 'CN=10.0.12.2', notBefore: NOW - 1000, notAfter: NOW + ONE_YEAR });
      ca.revoke(cert2.cert.serialNumber, NOW - 10);
      const crl = ca.publishCRL(NOW);
      l.r1.installIkeCertAuth({ localCert: cert1.cert, localKey: cert1.privateKey, trustAnchors: [ca.rootCertificate], crls: [crl], revocationCheck: 'none', clock: () => NOW });
      l.r2.installIkeCertAuth({ localCert: cert2.cert, localKey: cert2.privateKey, trustAnchors: [ca.rootCertificate], clock: () => NOW });
      await configureX509Profile(l.r1, '10.0.12.2', 'PROF1');
      await configureX509Profile(l.r2, '10.0.12.1', 'PROF2');
      await seedPcs(l.pc1, l.pc2);
      const ping = await l.pc1.executeCommand('ping -c 2 192.168.2.10');
      expect(ping).toContain('2 received');
    });
  });

  describe('§C — verifier & CRL unit tests', () => {
    it('X509Certificate expose subject, issuer, serial, validity', () => {
      const ca = CertificateAuthority.generate('CN=RootCA', { now: NOW });
      const issued = ca.issueCertificate({ subject: 'CN=leaf.example.com', notBefore: NOW, notAfter: NOW + ONE_YEAR });
      expect(issued.cert.subject).toBe('CN=leaf.example.com');
      expect(issued.cert.issuer).toBe('CN=RootCA');
      expect(issued.cert.serialNumber).toMatch(/^[0-9a-f]{16,}$/);
      expect(issued.cert.notBefore).toBe(NOW);
      expect(issued.cert.notAfter).toBe(NOW + ONE_YEAR);
      expect(issued.cert.publicKey).toBeDefined();
      expect(issued.cert.signature).toBeDefined();
    });

    it('CertificateRevocationList: contains(serial) reflète les révocations et est signée par la CA', () => {
      const ca = CertificateAuthority.generate('CN=RootCA', { now: NOW });
      const c1 = ca.issueCertificate({ subject: 'CN=one', notBefore: NOW, notAfter: NOW + ONE_YEAR });
      const c2 = ca.issueCertificate({ subject: 'CN=two', notBefore: NOW, notAfter: NOW + ONE_YEAR });
      ca.revoke(c1.cert.serialNumber, NOW);
      const crl = ca.publishCRL(NOW);
      expect(crl.contains(c1.cert.serialNumber)).toBe(true);
      expect(crl.contains(c2.cert.serialNumber)).toBe(false);
      expect(crl.issuer).toBe('CN=RootCA');
      expect(crl.isValidSignature(ca.rootCertificate.publicKey)).toBe(true);
    });

    it('CertificateAuthority.verify identifie les 4 cas: valid, unknown-issuer, expired, revoked', () => {
      const ca = CertificateAuthority.generate('CN=RootCA', { now: NOW });
      const other = CertificateAuthority.generate('CN=Other', { now: NOW });
      const good = ca.issueCertificate({ subject: 'CN=a', notBefore: NOW - 1000, notAfter: NOW + ONE_YEAR });
      const expired = ca.issueCertificate({ subject: 'CN=b', notBefore: NOW - ONE_YEAR * 2, notAfter: NOW - ONE_YEAR });
      const rogue = other.issueCertificate({ subject: 'CN=c', notBefore: NOW, notAfter: NOW + ONE_YEAR });
      const revoked = ca.issueCertificate({ subject: 'CN=d', notBefore: NOW, notAfter: NOW + ONE_YEAR });
      ca.revoke(revoked.cert.serialNumber, NOW);
      const crl = ca.publishCRL(NOW);
      const v = new CertificateVerifier({ trustAnchors: [ca.rootCertificate], crls: [crl], revocationCheck: 'crl', clock: () => NOW });
      expect(v.verify(good.cert)).toEqual({ ok: true });
      expect(v.verify(expired.cert)).toEqual({ ok: false, reason: 'expired' });
      expect(v.verify(rogue.cert)).toEqual({ ok: false, reason: 'unknown' });
      expect(v.verify(revoked.cert)).toEqual({ ok: false, reason: 'revoked' });
    });
  });
});
