/**
 * `set authmethod signature` authentifie pour de bon.
 *
 * Le mot-cle etait accepte, range, rendu par `show` — et le moteur
 * continuait de s'authentifier par cle partagee, parce que rien
 * n'appelait `setIkeCertAuth`. Le moteur, lui, sait deja tout faire :
 * il emet une charge utile de certificat, la VERIFIE contre des ancres
 * de confiance, refuse un certificat expire ou revoque. Il lui manquait
 * uniquement d'etre configure depuis FortiOS.
 *
 * Ecrite A L'AVEUGLE contre ce qu'un vrai FortiGate fait :
 *
 *   1. **`config vpn certificate local` et `config vpn certificate ca`
 *      sont deux magasins distincts** — l'un porte l'identite de la
 *      machine (certificat ET cle privee), l'autre les ancres de
 *      confiance. Les noms d'attributs sont ceux de FortiOS
 *      (`certificate`, `private-key`, `range`, `source`, `trusted`).
 *   2. **Le certificat entre en PEM**, la forme que produit n'importe
 *      quel outil, y compris l'`openssl` de ce depot.
 *   3. **Un certificat qu'aucune ancre ne signe fait ECHOUER le
 *      tunnel.** C'est le seul cas qui distingue une verification d'une
 *      decoration : une implantation qui rangerait le certificat sans le
 *      lire laisserait le tunnel monter.
 *   4. **`authmethod signature` sans certificat est REFUSE** a la
 *      fermeture de l'objet, comme un vrai FortiGate refuse une phase 1
 *      incomplete.
 *
 * Discriminee par `git stash push -- src/network/` : 7 des 10 cas
 * tombent avant correctif. Les 3 restants sont nommes ici plutot que
 * laisses a decouvrir : « un certificat qu'aucune ancre ne signe fait
 * echouer le tunnel » passait parce que le tunnel ne montait de toute
 * facon pas — `signature` etait inerte et aucune cle partagee n'etait
 * posee, donc ce cas ne prouve rien SEUL et ne vaut qu'avec celui qui le
 * precede ; « un certificat local inconnu est refuse » passait parce que
 * `set certificate` n'existait pas du tout ; et « la cle partagee reste
 * utilisable » est le temoin de non-regression, dont c'est l'objet de
 * passer des deux cotes.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress, IP_PROTO_ESP, type IPv4Packet } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import { certToPem, privateKeyToPem } from '@/network/pki/pem';
import { pingOnSimulatedClock } from '../../../support/fastPing';

interface Cmd { executeCommand(cmd: string): Promise<string> }

const runOn = (d: Cmd, cmds: string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); }, Promise.resolve<unknown>(undefined));

function run(sh: FortiShell, ...lines: string[]): string {
  let last = '';
  for (const line of lines) last = sh.execute(line);
  return last;
}

function flat(pem: string): string {
  return pem.replace(/\s+/g, ' ').trim();
}

const NOW = Date.UTC(2026, 0, 1);

interface Identity {
  certificate: string;
  privateKey: string;
}

function issue(ca: CertificateAuthority, subject: string): Identity {
  const issued = ca.issueCertificate({
    subject,
    notBefore: NOW - 3600_000,
    notAfter: NOW + 365 * 24 * 3600_000,
  });
  return {
    certificate: flat(certToPem(issued.cert)),
    privateKey: flat(privateKeyToPem(issued.privateKey)),
  };
}

interface Site {
  fw: FortiGate;
  sh: FortiShell;
  pc: LinuxPC;
}

function site(name: string, lan: string, wan: string, at: number): Site {
  const fw = new FortiGate('firewall-fortinet', name, at, 0, { now: () => NOW });
  const sh = new FortiShell(fw);
  const pc = new LinuxPC('linux-pc', `PC-${name}`, at, 120);

  run(sh,
    'config system interface',
    'edit "port1"', 'set mode static',
    `set ip ${lan}.1 255.255.255.0`, 'set allowaccess ping', 'next',
    'edit "port2"', 'set mode static',
    `set ip ${wan} 255.255.255.0`, 'set allowaccess ping', 'next', 'end');

  return { fw, sh, pc };
}

function installerCertificats(
  s: Site, local: Identity, autorite: string, localName: string,
): void {
  run(s.sh,
    'config vpn certificate ca',
    'edit "CA_Cert_1"', `set certificate "${autorite}"`, 'next', 'end',
    'config vpn certificate local',
    `edit "${localName}"`,
    `set certificate "${local.certificate}"`,
    `set private-key "${local.privateKey}"`,
    'next', 'end');
}

function tunnel(
  s: Site, name: string, peer: string, localLan: string, remoteLan: string,
  auth: { method: 'psk' } | { method: 'signature'; certificate: string },
): void {
  run(s.sh,
    'config vpn ipsec phase1-interface',
    `edit "${name}"`,
    'set interface "port2"',
    'set ike-version 2',
    `set remote-gw ${peer}`,
    'set proposal aes256-sha256',
    'set dhgrp 14');

  if (auth.method === 'psk') run(s.sh, 'set psksecret "SecretPartage2026"');
  else run(s.sh, 'set authmethod signature', `set certificate "${auth.certificate}"`);

  run(s.sh, 'next', 'end',
    'config vpn ipsec phase2-interface',
    `edit "${name}-p2"`,
    `set phase1name "${name}"`,
    `set src-subnet ${localLan}.0 255.255.255.0`,
    `set dst-subnet ${remoteLan}.0 255.255.255.0`,
    'next', 'end',
    'config router static',
    'edit 1',
    `set dst ${remoteLan}.0 255.255.255.0`,
    `set device "${name}"`,
    'next', 'end',
    'config firewall policy',
    'edit 1',
    'set srcintf "port1"', `set dstintf "${name}"`,
    'set srcaddr "all"', 'set dstaddr "all"',
    'set action accept', 'set schedule "always"', 'set service "ALL"',
    'next',
    'edit 2',
    `set srcintf "${name}"`, 'set dstintf "port1"',
    'set srcaddr "all"', 'set dstaddr "all"',
    'set action accept', 'set schedule "always"', 'set service "ALL"',
    'next', 'end');
}

async function laboratoire(options: { autoriteDeB?: 'commune' | 'etrangere' } = {}) {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();

  const autorite = CertificateAuthority.generate('CN = Labo VPN', { now: NOW - 86_400_000 });
  const intruse = CertificateAuthority.generate('CN = Autre labo', { now: NOW - 86_400_000 });

  const a = site('FGT-A', '192.168.1', '203.0.113.1', -200);
  const b = site('FGT-B', '192.168.2', '203.0.113.2', 200);

  new Cable('lan-a').connect(a.pc.getPort('eth0')!, a.fw.getPort('port1')!);
  new Cable('lan-b').connect(b.pc.getPort('eth0')!, b.fw.getPort('port1')!);
  new Cable('wan').connect(a.fw.getPort('port2')!, b.fw.getPort('port2')!);

  const emetteurDeB = options.autoriteDeB === 'etrangere' ? intruse : autorite;
  const pemAutorite = flat(certToPem(autorite.rootCertificate));

  installerCertificats(a, issue(autorite, 'CN = fgt-a.labo'), pemAutorite, 'FGT_A');
  installerCertificats(b, issue(emetteurDeB, 'CN = fgt-b.labo'), pemAutorite, 'FGT_B');

  tunnel(a, 'vers_b', '203.0.113.2', '192.168.1', '192.168.2',
    { method: 'signature', certificate: 'FGT_A' });
  tunnel(b, 'vers_a', '203.0.113.1', '192.168.2', '192.168.1',
    { method: 'signature', certificate: 'FGT_B' });

  await runOn(a.pc, ['ip link set eth0 up', 'ip addr add 192.168.1.10/24 dev eth0',
    'ip route add default via 192.168.1.1']);
  await runOn(b.pc, ['ip link set eth0 up', 'ip addr add 192.168.2.10/24 dev eth0',
    'ip route add default via 192.168.2.1']);

  return { a, b, autorite, intruse, pemAutorite };
}

function tramesEsp(s: Site): IPv4Packet[] {
  return s.fw.getPacketCapture()
    .select({ iface: 'port2', filter: {}, limit: 0 })
    .map(entry => entry.frame.payload as IPv4Packet)
    .filter(packet => packet?.type === 'ipv4' && packet.protocol === IP_PROTO_ESP);
}

beforeEach(() => { Logger.reset(); });

describe('config vpn certificate', () => {
  it('le magasin local garde le certificat et la cle, et `show` les rend', async () => {
    const { a } = await laboratoire();

    const rendu = a.sh.execute('show vpn certificate local');
    expect(rendu).toMatch(/edit "FGT_A"/);
    expect(rendu).toMatch(/BEGIN CERTIFICATE/);
  });

  it('le magasin des autorites est distinct du magasin local', async () => {
    const { a } = await laboratoire();

    expect(a.sh.execute('show vpn certificate ca')).toMatch(/edit "CA_Cert_1"/);
    expect(a.sh.execute('show vpn certificate ca')).not.toMatch(/FGT_A/);
  });

  it('un PEM illisible est refuse plutot que range', async () => {
    const { a } = await laboratoire();

    const sortie = run(a.sh,
      'config vpn certificate ca',
      'edit "MAUVAIS"', 'set certificate "ceci n`est pas un certificat"', 'next');

    expect(sortie).toMatch(/Command fail/);
    expect(a.fw.getCertificateStore().authority('MAUVAIS')).toBeUndefined();
    run(a.sh, 'abort');
  });
});

describe('authmethod signature', () => {
  it('le tunnel monte et un ping traverse', async () => {
    const { a } = await laboratoire();

    const sortie = await pingOnSimulatedClock(a.pc, 'ping -c 2 192.168.2.10');

    expect(sortie).toMatch(/, 0% packet loss/);
    expect(tramesEsp(a).length).toBeGreaterThan(0);
  });

  it('un certificat qu`aucune ancre ne signe fait echouer le tunnel', async () => {
    const { a } = await laboratoire({ autoriteDeB: 'etrangere' });

    const sortie = await pingOnSimulatedClock(a.pc, 'ping -c 1 192.168.2.10');

    expect(sortie).toMatch(/, 100% packet loss/);
    expect(a.sh.execute('get vpn ipsec tunnel summary'))
      .toMatch(/'vers_b' 203\.0\.113\.2:0\s+selectors\(total,up\): \d+\/0/);
  });

  it('la cle partagee reste utilisable — non-regression', async () => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();

    const a = site('FGT-A', '192.168.1', '203.0.113.1', -200);
    const b = site('FGT-B', '192.168.2', '203.0.113.2', 200);
    new Cable('lan-a').connect(a.pc.getPort('eth0')!, a.fw.getPort('port1')!);
    new Cable('lan-b').connect(b.pc.getPort('eth0')!, b.fw.getPort('port1')!);
    new Cable('wan').connect(a.fw.getPort('port2')!, b.fw.getPort('port2')!);

    tunnel(a, 'vers_b', '203.0.113.2', '192.168.1', '192.168.2', { method: 'psk' });
    tunnel(b, 'vers_a', '203.0.113.1', '192.168.2', '192.168.1', { method: 'psk' });

    await runOn(a.pc, ['ip link set eth0 up', 'ip addr add 192.168.1.10/24 dev eth0',
      'ip route add default via 192.168.1.1']);
    await runOn(b.pc, ['ip link set eth0 up', 'ip addr add 192.168.2.10/24 dev eth0',
      'ip route add default via 192.168.2.1']);

    expect(await pingOnSimulatedClock(a.pc, 'ping -c 1 192.168.2.10'))
      .toMatch(/, 0% packet loss/);
  });

  it('sans certificat, la phase 1 est refusee a la fermeture', async () => {
    const { a } = await laboratoire();

    const sortie = run(a.sh,
      'config vpn ipsec phase1-interface',
      'edit "sans_cert"',
      'set interface "port2"',
      'set remote-gw 198.51.100.9',
      'set authmethod signature',
      'next');

    expect(sortie).toMatch(/Command fail/);
    run(a.sh, 'abort');
  });

  it('un certificat local inconnu est refuse comme reference', async () => {
    const { a } = await laboratoire();

    const sortie = run(a.sh,
      'config vpn ipsec phase1-interface',
      'edit "inconnu"',
      'set certificate "PAS_LA"');

    expect(sortie).toMatch(/entry not found|Command fail/);
    run(a.sh, 'abort');
  });

  it('`set certificate ?` propose les certificats locaux declares', async () => {
    const { a } = await laboratoire();

    const aide = run(a.sh,
      'config vpn ipsec phase1-interface', 'edit "T"', 'set certificate ?');

    expect(aide).toMatch(/FGT_A/);
    run(a.sh, 'abort');
  });

  it('la configuration rendue reproduit la methode et le certificat', async () => {
    const { a } = await laboratoire();

    const rendu = a.sh.execute('show vpn ipsec phase1-interface');
    expect(rendu).toMatch(/set authmethod signature/);
    expect(rendu).toMatch(/set certificate "FGT_A"/);
    expect(rendu).not.toMatch(/set psksecret/);
  });
});
