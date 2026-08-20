import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import { certificateMatchesHostname } from '@/network/pki/CertificateVerifier';
import { HttpsServerSession } from '@/network/http/https/HttpsServerSession';
import { createResponse } from '@/network/http/semantics/types';
import { FilesNssSource } from '@/network/devices/linux/nss/FilesNssSource';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

const NOW = Date.now();

describe('Scénario 3 — certificateMatchesHostname (RFC 6125)', () => {
  it('correspond exactement au CN quand aucun SAN n\'est présent', () => {
    const ca = CertificateAuthority.generate('CN=test-ca', { now: NOW });
    const issued = ca.issueCertificate({ subject: 'CN=serveur.domaine.local', notBefore: NOW - 1000, notAfter: NOW + 1e9 });
    expect(certificateMatchesHostname(issued.cert, 'serveur.domaine.local')).toBe(true);
    expect(certificateMatchesHostname(issued.cert, 'autre.domaine.local')).toBe(false);
  });

  it('un SAN dNSName correspondant valide même si le CN diffère', () => {
    const ca = CertificateAuthority.generate('CN=test-ca', { now: NOW });
    const issued = ca.issueCertificate({
      subject: 'CN=legacy-name', notBefore: NOW - 1000, notAfter: NOW + 1e9,
      subjectAltNames: ['serveur.domaine.local'],
    });
    expect(certificateMatchesHostname(issued.cert, 'serveur.domaine.local')).toBe(true);
    expect(certificateMatchesHostname(issued.cert, 'legacy-name')).toBe(false);
  });

  it('un wildcard *.domaine.local couvre un seul label', () => {
    const ca = CertificateAuthority.generate('CN=test-ca', { now: NOW });
    const issued = ca.issueCertificate({
      subject: 'CN=wildcard', notBefore: NOW - 1000, notAfter: NOW + 1e9,
      subjectAltNames: ['*.domaine.local'],
    });
    expect(certificateMatchesHostname(issued.cert, 'serveur.domaine.local')).toBe(true);
    expect(certificateMatchesHostname(issued.cert, 'a.b.domaine.local')).toBe(false);
  });
});

describe('Scénario 3 — /etc/hosts: doublons et priorité de la première entrée', () => {
  it('un nom dupliqué avec des IP différentes ne retourne que la première occurrence', () => {
    const vfs = new VirtualFileSystem();
    vfs.writeFile(
      '/etc/hosts',
      '10.0.0.1 serveur\n10.0.0.2 serveur\n',
      0, 0, 0o022,
    );
    const source = new FilesNssSource(vfs, null);
    const r = source.gethostbyname('serveur');
    expect(r.status).toBe('SUCCESS');
    expect(r.entry).toHaveLength(1);
    expect(r.entry![0].address).toBe('10.0.0.1');
  });

  it('plusieurs alias sur une même ligne résolvent tous vers la même IP', () => {
    const vfs = new VirtualFileSystem();
    vfs.writeFile(
      '/etc/hosts',
      '192.168.10.1 switch switch.local huawei-sw1\n',
      0, 0, 0o022,
    );
    const source = new FilesNssSource(vfs, null);
    const r = source.gethostbyname('huawei-sw1');
    expect(r.status).toBe('SUCCESS');
    expect(r.entry![0].address).toBe('192.168.10.1');
  });
});

async function buildHijackLab() {
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  const client = new LinuxPC('linux-pc', 'CLIENT', 0, 0);
  const legit = new LinuxServer('linux-server', 'LEGIT', 0, 0);
  const rogue = new LinuxServer('linux-server', 'ROGUE', 0, 0);
  legit.setHostname('legit');
  rogue.setHostname('rogue');
  await rogue.executeCommand('rm -f /etc/ssh/ssh_host_ed25519_key /etc/ssh/ssh_host_ed25519_key.pub');
  await rogue.executeCommand('ssh-keygen -A');
  new Cable('c1').connect(client.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(legit.getPorts()[0], sw.getPorts()[1]);
  new Cable('c3').connect(rogue.getPorts()[0], sw.getPorts()[2]);
  const mask = new SubnetMask('255.255.255.0');
  client.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), mask);
  legit.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), mask);
  rogue.getPorts()[0].configureIP(new IPAddress('10.0.0.3'), mask);
  return { client, legit, rogue };
}

async function pointHostsAt(client: LinuxPC, ip: string): Promise<void> {
  await client.executeCommand(
    `cat > /etc/hosts <<'EOF'\n127.0.0.1 localhost\n${ip} serveur-legitime.domaine.local\nEOF`,
  );
}

describe('Scénario 3 — hijack /etc/hosts: getent priorise le fichier local', () => {
  it('getent hosts retourne l\'IP du fichier hijacké, pas celle du DNS', async () => {
    const { client } = await buildHijackLab();
    await pointHostsAt(client, '10.0.0.3');
    const out = await client.executeCommand('getent hosts serveur-legitime.domaine.local');
    expect(out).toMatch(/10\.0\.0\.3/);
  });
});

describe('Scénario 3 — hijack /etc/hosts + SSH: TOFU détecte la redirection', () => {
  it('première connexion légitime enregistre la clé du vrai serveur sous le nom d\'hôte', async () => {
    const { client, legit } = await buildHijackLab();
    const um = (legit as unknown as { executor: { userMgr: { useradd: (u: string, o?: object) => void; setPassword: (u: string, p: string) => void; getUser: (u: string) => unknown } } }).executor.userMgr;
    um.useradd('alice', { m: true, s: '/bin/bash' });
    um.setPassword('alice', 'wonderland');
    legit.getSshServerContext();
    await pointHostsAt(client, '10.0.0.2');

    const out = await client.executeCommand(
      'ssh -o StrictHostKeyChecking=accept-new alice@serveur-legitime.domaine.local "echo ok"',
      'wonderland\n',
    );
    expect(out).not.toMatch(/Host key verification failed/i);
    const kh = await client.executeCommand('cat /root/.ssh/known_hosts');
    expect(kh).toContain('serveur-legitime.domaine.local');
  });

  it('rediriger le nom vers le serveur pirate déclenche l\'alerte MITM malgré le hijack DNS/hosts', async () => {
    const { client, legit, rogue } = await buildHijackLab();
    const um = (legit as unknown as { executor: { userMgr: { useradd: (u: string, o?: object) => void; setPassword: (u: string, p: string) => void; getUser: (u: string) => unknown } } }).executor.userMgr;
    um.useradd('alice', { m: true, s: '/bin/bash' });
    um.setPassword('alice', 'wonderland');
    legit.getSshServerContext();
    const rogueUm = (rogue as unknown as { executor: { userMgr: { useradd: (u: string, o?: object) => void; setPassword: (u: string, p: string) => void; getUser: (u: string) => unknown } } }).executor.userMgr;
    rogueUm.useradd('alice', { m: true, s: '/bin/bash' });
    rogueUm.setPassword('alice', 'wonderland');
    rogue.getSshServerContext();
    await pointHostsAt(client, '10.0.0.2');
    await client.executeCommand(
      'ssh -o StrictHostKeyChecking=accept-new alice@serveur-legitime.domaine.local "echo first"',
      'wonderland\n',
    );

    await pointHostsAt(client, '10.0.0.3');
    const out = await client.executeCommand(
      'ssh alice@serveur-legitime.domaine.local "echo second"',
      'wonderland\n',
    );
    expect(out).toMatch(/WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!/);
    expect(out).not.toContain('second');
  });
});

describe('Scénario 3 — hijack /etc/hosts + curl HTTPS: la vérification de nom protège', () => {
  it('curl réussit vers le vrai serveur (certificat valide pour le bon nom)', async () => {
    const { client, legit } = await buildHijackLab();
    const ca = CertificateAuthority.generate('CN=lab-ca', { now: NOW });
    const issued = ca.issueCertificate({
      subject: 'CN=serveur-legitime.domaine.local', notBefore: NOW - 1000, notAfter: NOW + 1e9,
    });
    (client as unknown as { addTrustedCertificateAuthority: (c: unknown) => void }).addTrustedCertificateAuthority(ca.rootCertificate);
    const srv = new HttpsServerSession(
      legit.getTcpStack(), 443, { serverCert: issued.cert, serverPrivateKey: issued.privateKey },
      () => createResponse(200, 'OK'),
    );
    srv.start();

    await pointHostsAt(client, '10.0.0.2');
    const out = await client.executeCommand('curl https://serveur-legitime.domaine.local/');
    expect(out).not.toMatch(/curl: \(60\)/);
  });

  it('curl échoue après hijack: le certificat du serveur pirate ne correspond pas au nom demandé', async () => {
    const { client, legit, rogue } = await buildHijackLab();
    const ca = CertificateAuthority.generate('CN=lab-ca', { now: NOW });
    const legitIssued = ca.issueCertificate({
      subject: 'CN=serveur-legitime.domaine.local', notBefore: NOW - 1000, notAfter: NOW + 1e9,
    });
    const rogueIssued = ca.issueCertificate({
      subject: 'CN=attacker.evil', notBefore: NOW - 1000, notAfter: NOW + 1e9,
    });
    (client as unknown as { addTrustedCertificateAuthority: (c: unknown) => void }).addTrustedCertificateAuthority(ca.rootCertificate);

    new HttpsServerSession(
      legit.getTcpStack(), 443, { serverCert: legitIssued.cert, serverPrivateKey: legitIssued.privateKey },
      () => createResponse(200, 'OK'),
    ).start();
    new HttpsServerSession(
      rogue.getTcpStack(), 443, { serverCert: rogueIssued.cert, serverPrivateKey: rogueIssued.privateKey },
      () => createResponse(200, 'OK'),
    ).start();

    await pointHostsAt(client, '10.0.0.3');
    const out = await client.executeCommand('curl https://serveur-legitime.domaine.local/');
    expect(out).toMatch(/no alternative certificate subject name matches/);
  });
});

describe('Scénario 3 — hostnamectl set-hostname: propagation et discontinuité de logs', () => {
  it('propage immédiatement à hostname/uname sans redémarrage', async () => {
    const { client } = await buildHijackLab();
    await client.executeCommand('sudo hostnamectl set-hostname pc-renomme');
    const hn = await client.executeCommand('hostname');
    const un = await client.executeCommand('uname -n');
    expect(hn.trim()).toBe('pc-renomme');
    expect(un.trim()).toBe('pc-renomme');
  });

  it('les entrées syslog déjà écrites gardent l\'ancien nom, les nouvelles reflètent le nouveau', async () => {
    const { client } = await buildHijackLab();
    await client.executeCommand('logger -t probe "before rename"');
    await client.executeCommand('sudo hostnamectl set-hostname pc-renomme');
    await client.executeCommand('logger -t probe "after rename"');

    const syslog = await client.executeCommand('cat /var/log/syslog');
    const beforeLine = syslog.split('\n').find(l => l.includes('before rename'));
    const afterLine = syslog.split('\n').find(l => l.includes('after rename'));
    expect(beforeLine).toBeDefined();
    expect(afterLine).toBeDefined();
    expect(beforeLine).not.toContain('pc-renomme');
    expect(afterLine).toContain('pc-renomme');
  });
});
