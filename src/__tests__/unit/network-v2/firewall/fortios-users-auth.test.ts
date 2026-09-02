/**
 * Phase 7 : utilisateurs, authentification et comptes administrateurs.
 *
 * Ecrite A L'AVEUGLE contre ce qu'un vrai FortiGate fait, verifie contre
 * la documentation Fortinet AVANT d'ecrire une ligne de produit.
 *
 * Cinq points ne sont pas cosmetiques :
 *
 *   1. **Une politique qui nomme un groupe EXIGE l'authentification.**
 *      Tant que l'adresse n'est pas associee a une identite, le trafic
 *      est refuse — c'est tout l'objet du mecanisme, et un test qui ne
 *      verifierait que l'apres-authentification ne prouverait rien.
 *   2. **Le portail est un VRAI serveur HTTP** sur la pile TCP du
 *      pare-feu. Le FortiGate n'en avait aucune avant cette phase ;
 *      c'est la brique dont l'absence avait fait refuser
 *      `deep-inspection` en phase 6.
 *   3. **L'association expire.** Une identite qui ne vieillit pas est
 *      une porte ouverte pour toujours ; `diagnose firewall auth list`
 *      doit cesser de la montrer et le trafic doit redevenir refuse.
 *   4. **`trusthost` filtre pour de vrai**, et une liste vide veut dire
 *      « depuis partout » — l'inverse ferait de la valeur par defaut un
 *      verrou que personne n'a pose.
 *   5. **Le profil d'acces est une MATRICE**, pas un ordre total : un
 *      compte qui a `fwgrp read-write` et `sysgrp none` peut configurer
 *      la politique et ne voit meme pas `config system`.
 *
 * Discrimination : `git stash push -- src/network/`.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { IdentityTable } from '@/network/devices/firewall/identity/IdentityTable';
import {
  AccessMatrix, trustHostAllows, emptyRights,
  type TrustHost,
} from '@/network/devices/firewall/authz/AccessMatrix';
import { renderAuthList } from '@/network/devices/firewall/vendors/fortios/diag/authListRenderer';

interface Cmd { executeCommand(cmd: string): Promise<string> }

const runOn = (d: Cmd, cmds: string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); }, Promise.resolve<unknown>(undefined));

function run(sh: FortiShell, ...lines: string[]): string {
  let last = '';
  for (const line of lines) last = sh.execute(line);
  return last;
}

const CLIENT_IP = '192.168.1.10';
const SERVER_IP = '203.0.113.10';

function shell(): { fw: FortiGate; sh: FortiShell } {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  const fw = new FortiGate('firewall-fortinet', 'FGT1', 0, 0);
  return { fw, sh: new FortiShell(fw) };
}

async function laboratoire() {
  const { fw, sh } = shell();
  const poste = new LinuxPC('linux-pc', 'POSTE', -100, 0);
  const serveur = new LinuxServer('linux-server', 'WEB', 100, 0);

  new Cable('a').connect(poste.getPort('eth0')!, fw.getPort('port1')!);
  new Cable('b').connect(fw.getPort('port2')!, serveur.getPort('eth0')!);

  run(sh,
    'config system interface',
    'edit "port1"', 'set mode static',
    'set ip 192.168.1.1 255.255.255.0', 'set allowaccess ping', 'next',
    'edit "port2"', 'set mode static',
    'set ip 203.0.113.1 255.255.255.0', 'set allowaccess ping', 'next', 'end');

  await runOn(poste, ['ip link set eth0 up', `ip addr add ${CLIENT_IP}/24 dev eth0`,
    'ip route add default via 192.168.1.1']);
  await runOn(serveur, ['ip link set eth0 up', `ip addr add ${SERVER_IP}/24 dev eth0`,
    'ip route add default via 203.0.113.1']);

  return { fw, sh, poste, serveur };
}

function utilisateur(sh: FortiShell, nom = 'jdupont', motDePasse = 'Secret2026!'): void {
  run(sh, 'config user local', `edit "${nom}"`,
    'set type password', `set passwd "${motDePasse}"`, 'next', 'end');
}

function groupe(sh: FortiShell, nom = 'COMMERCIAUX', membre = 'jdupont'): void {
  run(sh, 'config user group', `edit "${nom}"`,
    `set member "${membre}"`, 'next', 'end');
}

function politique(sh: FortiShell, ...extra: string[]): string {
  return run(sh,
    'config firewall policy', 'edit 1',
    'set name "SORTIE"',
    'set srcintf "port1"', 'set dstintf "port2"',
    'set srcaddr "all"', 'set dstaddr "all"',
    'set action accept', 'set schedule "always"', 'set service "ALL"',
    'set nat enable', ...extra, 'next', 'end');
}

beforeEach(() => { Logger.reset(); });

describe('une politique qui nomme un groupe exige l`authentification', () => {
  it('sans groupe, le trafic passe — temoin', async () => {
    const { sh, poste, serveur } = await laboratoire();
    await serveur.executeCommand('systemctl start nginx');
    politique(sh);

    expect(await poste.executeCommand(`curl -sS http://${SERVER_IP}/`))
      .toContain('Welcome to nginx!');
  });

  it('avec un groupe et sans identite, le trafic est REFUSE', async () => {
    const { sh, poste, serveur } = await laboratoire();
    await serveur.executeCommand('systemctl start nginx');
    utilisateur(sh);
    groupe(sh);
    politique(sh, 'set groups "COMMERCIAUX"');

    expect(await poste.executeCommand(`curl -sS http://${SERVER_IP}/`))
      .not.toContain('Welcome to nginx!');
  });

  it('une fois authentifie, le meme trafic passe', async () => {
    const { fw, sh, poste, serveur } = await laboratoire();
    await serveur.executeCommand('systemctl start nginx');
    utilisateur(sh);
    groupe(sh);
    politique(sh, 'set groups "COMMERCIAUX"');

    const verdict = await fw.getAuthPortal().authenticate(
      CLIENT_IP, { username: 'jdupont', password: 'Secret2026!' });

    expect(verdict.ok).toBe(true);
    expect(await poste.executeCommand(`curl -sS http://${SERVER_IP}/`))
      .toContain('Welcome to nginx!');
  });

  it('un mauvais mot de passe n`associe rien', async () => {
    const { fw, sh } = await laboratoire();
    utilisateur(sh);
    groupe(sh);

    const verdict = await fw.getAuthPortal().authenticate(
      CLIENT_IP, { username: 'jdupont', password: 'faux' });

    expect(verdict.ok).toBe(false);
    expect(fw.getIdentityTable().lookup(CLIENT_IP)).toBeUndefined();
  });

  it('un utilisateur d`un AUTRE groupe ne passe pas la politique', async () => {
    const { fw, sh, poste, serveur } = await laboratoire();
    await serveur.executeCommand('systemctl start nginx');
    utilisateur(sh, 'mmartin', 'Autre2026!');
    groupe(sh, 'TECHNIQUES', 'mmartin');
    groupe(sh, 'COMMERCIAUX', 'jdupont');
    politique(sh, 'set groups "COMMERCIAUX"');

    await fw.getAuthPortal().authenticate(
      CLIENT_IP, { username: 'mmartin', password: 'Autre2026!' });

    expect(await poste.executeCommand(`curl -sS http://${SERVER_IP}/`))
      .not.toContain('Welcome to nginx!');
  });

  it('un compte desactive n`authentifie pas', async () => {
    const { fw, sh } = await laboratoire();
    run(sh, 'config user local', 'edit "jdupont"',
      'set type password', 'set passwd "Secret2026!"',
      'set status disable', 'next', 'end');

    const verdict = await fw.getAuthPortal().authenticate(
      CLIENT_IP, { username: 'jdupont', password: 'Secret2026!' });

    expect(verdict.ok).toBe(false);
  });
});

describe('le portail est un vrai serveur HTTP sur la pile du pare-feu', () => {
  it('le pare-feu porte une pile TCP', async () => {
    const { fw } = await laboratoire();

    expect(fw.getTcpStack()).toBeDefined();
  });

  it('le portail ecoute sur le port 1000 par defaut', async () => {
    const { fw } = await laboratoire();

    expect(fw.startAuthPortal()).toBe(true);
    expect(fw.getAuthPortalPorts().http).toBe(1000);
  });

  it('`config system global` deplace le port du portail', async () => {
    const { fw, sh } = await laboratoire();

    run(sh, 'config system global', 'set auth-http-port 8000', 'end');

    expect(fw.getAuthPortalPorts().http).toBe(8000);
  });

  it('`auth-timeout` gouverne la duree de l`association', async () => {
    const { fw, sh } = await laboratoire();

    run(sh, 'config user setting', 'set auth-timeout 30', 'end');

    expect(fw.getAuthPortal().getTimeoutSeconds()).toBe(1800);
  });
});

describe('l`association identite <-> adresse expire', () => {
  it('elle disparait passe le delai', () => {
    let horloge = 1_000_000;
    const table = new IdentityTable({ now: () => horloge });
    table.bind({
      address: CLIENT_IP, user: 'jdupont', source: 'local',
      groups: ['COMMERCIAUX'], timeoutSec: 300,
    });

    expect(table.lookup(CLIENT_IP)).toBeDefined();
    horloge += 301_000;

    expect(table.lookup(CLIENT_IP)).toBeUndefined();
  });

  it('le trafic redevient refuse une fois l`identite expiree', async () => {
    const { fw, sh, poste, serveur } = await laboratoire();
    await serveur.executeCommand('systemctl start nginx');
    utilisateur(sh);
    groupe(sh);
    run(sh, 'config user setting', 'set auth-timeout 1', 'end');
    politique(sh, 'set groups "COMMERCIAUX"');
    await fw.getAuthPortal().authenticate(
      CLIENT_IP, { username: 'jdupont', password: 'Secret2026!' });

    fw.getIdentityTable().release(CLIENT_IP);

    expect(await poste.executeCommand(`curl -sS http://${SERVER_IP}/`))
      .not.toContain('Welcome to nginx!');
  });

  it('`authtimeout` du groupe l`emporte sur le reglage global', async () => {
    const { fw, sh } = await laboratoire();
    utilisateur(sh);
    run(sh, 'config user group', 'edit "COMMERCIAUX"',
      'set member "jdupont"', 'set authtimeout 2', 'next', 'end');

    await fw.getAuthPortal().authenticate(
      CLIENT_IP, { username: 'jdupont', password: 'Secret2026!' });
    const identity = fw.getIdentityTable().lookup(CLIENT_IP);

    expect(identity).toBeDefined();
    expect(identity!.expiresAt - identity!.authenticatedAt).toBe(120_000);
  });
});

describe('`diagnose firewall auth list` rend le format de FortiOS', () => {
  it('sans personne, il annonce zero liste et zero filtre', async () => {
    const { sh } = await laboratoire();

    expect(run(sh, 'diagnose firewall auth list'))
      .toBe('----- 0 listed, 0 filtered ------');
  });

  it('un utilisateur local est rendu avec son groupe', async () => {
    const { fw, sh } = await laboratoire();
    utilisateur(sh);
    groupe(sh);
    await fw.getAuthPortal().authenticate(
      CLIENT_IP, { username: 'jdupont', password: 'Secret2026!' });

    const vu = run(sh, 'diagnose firewall auth list');

    expect(vu).toContain(`${CLIENT_IP}, jdupont`);
    expect(vu).toContain('type: fw, id: 0, duration: ');
    expect(vu).toContain('packets: in 0 out 0, bytes: in 0 out 0');
    expect(vu).toContain('group_name: COMMERCIAUX');
    expect(vu).toContain('----- 1 listed, 0 filtered ------');
  });

  it('la ligne `server:` n`apparait que pour une authentification distante', () => {
    const table = new IdentityTable({ now: () => 1_000_000 });
    table.bind({
      address: CLIENT_IP, user: 'jdupont', source: 'local',
      groups: [], timeoutSec: 300,
    });

    expect(renderAuthList(table)).not.toContain('server:');
  });

  it('elle apparait pour une identite RADIUS', () => {
    const table = new IdentityTable({ now: () => 1_000_000 });
    table.bind({
      address: CLIENT_IP, user: 'jdupont', source: 'radius', server: 'RADIUS_AD',
      groups: [], timeoutSec: 300,
    });

    expect(renderAuthList(table)).toContain('server: RADIUS_AD');
  });

  it('le filtre compte ce qu`il ecarte', () => {
    const table = new IdentityTable({ now: () => 1_000_000 });
    table.bind({
      address: CLIENT_IP, user: 'jdupont', source: 'local', groups: [], timeoutSec: 300,
    });
    table.bind({
      address: '192.168.1.11', user: 'mmartin', source: 'local', groups: [], timeoutSec: 300,
    });

    expect(renderAuthList(table, { user: 'jdupont' }))
      .toContain('----- 1 listed, 1 filtered ------');
  });

  it('`diagnose firewall auth clear` desassocie tout le monde', async () => {
    const { fw, sh } = await laboratoire();
    utilisateur(sh);
    groupe(sh);
    await fw.getAuthPortal().authenticate(
      CLIENT_IP, { username: 'jdupont', password: 'Secret2026!' });

    run(sh, 'diagnose firewall auth clear');

    expect(run(sh, 'diagnose firewall auth list'))
      .toBe('----- 0 listed, 0 filtered ------');
  });
});

describe('serveurs distants : les agents reels du depot', () => {
  it('`config user radius` declare un serveur', async () => {
    const { fw, sh } = await laboratoire();

    run(sh, 'config user radius', 'edit "RADIUS_AD"',
      'set server 10.0.0.5', 'set secret "partage"', 'next', 'end');

    const declared = fw.getUserDirectory().getServer('RADIUS_AD');
    expect(declared?.kind).toBe('radius');
    expect(declared?.address).toBe('10.0.0.5');
    expect(declared?.port).toBe(1812);
  });

  it('`config user tacacs+` declare le sien, sur le port 49', async () => {
    const { fw, sh } = await laboratoire();

    run(sh, 'config user tacacs+', 'edit "TACACS"',
      'set server 10.0.0.6', 'set key "secret"', 'next', 'end');

    expect(fw.getUserDirectory().getServer('TACACS')?.port).toBe(49);
  });

  it('`config user ldap` existe et n`est pas refuse', async () => {
    const { fw, sh } = await laboratoire();

    const vu = run(sh, 'config user ldap', 'edit "AD"',
      'set server 10.0.0.7', 'set dn "dc=labo,dc=local"', 'set cnid "cn"',
      'next', 'end');

    expect(vu).not.toContain('Command fail');
    expect(fw.getUserDirectory().getServer('AD')?.kind).toBe('ldap');
  });

  it('FSSO et SAML sont refuses en nommant la brique absente', async () => {
    const { sh } = await laboratoire();

    expect(run(sh, 'config user fsso', 'edit "X"', 'set name "X"'))
      .toContain('Command fail');
    expect(run(sh, 'config user saml', 'edit "X"', 'set name "X"'))
      .toContain('Command fail');
  });

  it('un utilisateur de type radius pointe son serveur', async () => {
    const { fw, sh } = await laboratoire();
    run(sh, 'config user radius', 'edit "RADIUS_AD"',
      'set server 10.0.0.5', 'set secret "partage"', 'next', 'end');

    run(sh, 'config user local', 'edit "mmartin"',
      'set type radius', 'set radius-server "RADIUS_AD"', 'next', 'end');

    expect(fw.getUserDirectory().getUser('mmartin')?.server).toBe('RADIUS_AD');
  });
});

describe('`trusthost` filtre pour de vrai', () => {
  const host = (address: string, mask: string): TrustHost =>
    ({ index: 1, address, mask });

  it('une liste vide autorise toute origine', () => {
    expect(trustHostAllows([], '198.51.100.9')).toBe(true);
  });

  it('`0.0.0.0 0.0.0.0` ne verrouille rien non plus', () => {
    expect(trustHostAllows([host('0.0.0.0', '0.0.0.0')], '198.51.100.9')).toBe(true);
  });

  it('une origine dans le reseau declare est admise', () => {
    expect(trustHostAllows([host('192.168.1.0', '255.255.255.0')], '192.168.1.10'))
      .toBe(true);
  });

  it('une origine hors du reseau declare est refusee', () => {
    expect(trustHostAllows([host('192.168.1.0', '255.255.255.0')], '10.0.0.1'))
      .toBe(false);
  });

  it('le compte administrateur porte ses hotes de confiance', async () => {
    const { fw, sh } = await laboratoire();

    run(sh, 'config system admin', 'edit "auditeur"',
      'set accprofile "super_admin"',
      'set trusthost1 192.168.1.0 255.255.255.0', 'next', 'end');

    expect(fw.adminTrustsSource('auditeur', '192.168.1.5')).toBe(true);
    expect(fw.adminTrustsSource('auditeur', '10.0.0.5')).toBe(false);
  });
});

describe('le profil d`acces est une MATRICE', () => {
  it('`super_admin` est predefini et donne tout', () => {
    const matrix = new AccessMatrix();

    expect(matrix.authorize('super_admin', 'fwgrp', 'write')).toBe('run');
    expect(matrix.authorize('super_admin', 'sysgrp', 'write')).toBe('run');
  });

  it('un groupe `none` rend le chemin ABSENT', () => {
    const matrix = new AccessMatrix();
    matrix.setProfile({ name: 'partiel', rights: { ...emptyRights(), fwgrp: 'read-write' } });

    expect(matrix.authorize('partiel', 'sysgrp', 'read')).toBe('absent');
  });

  it('un groupe `read` laisse lire et refuse d`ecrire', () => {
    const matrix = new AccessMatrix();
    matrix.setProfile({ name: 'lecture', rights: { ...emptyRights(), fwgrp: 'read' } });

    expect(matrix.authorize('lecture', 'fwgrp', 'read')).toBe('run');
    expect(matrix.authorize('lecture', 'fwgrp', 'write')).toBe('read-only');
  });

  it('un profil inconnu ne donne rien', () => {
    expect(new AccessMatrix().authorize('inexistant', 'fwgrp', 'read')).toBe('absent');
  });

  it('`config system accprofile` pose les neuf groupes', async () => {
    const { fw, sh } = await laboratoire();

    run(sh, 'config system accprofile', 'edit "readonly"',
      'set fwgrp read', 'set sysgrp read', 'set netgrp read',
      'next', 'end');

    const profile = fw.getAccessMatrix().getProfile('readonly');
    expect(profile?.rights.fwgrp).toBe('read');
    expect(profile?.rights.utmgrp).toBe('none');
  });

  it('un profil predefini ne se supprime pas', () => {
    expect(new AccessMatrix().removeProfile('super_admin')).toBe(false);
  });

  it('un compte `readonly` ne peut pas entrer en configuration de politique', async () => {
    const { sh } = await laboratoire();
    run(sh, 'config system accprofile', 'edit "readonly"',
      'set fwgrp read', 'next', 'end');
    run(sh, 'config system admin', 'edit "auditeur"',
      'set accprofile "readonly"', 'next', 'end');

    sh.setAdminIdentity('auditeur');
    const vu = sh.execute('config firewall policy');

    expect(vu).toContain('Command fail');
  });

  it('et il ne voit meme pas un groupe qu`il n`a pas', async () => {
    const { sh } = await laboratoire();
    run(sh, 'config system accprofile', 'edit "readonly"',
      'set fwgrp read', 'next', 'end');
    run(sh, 'config system admin', 'edit "auditeur"',
      'set accprofile "readonly"', 'next', 'end');

    sh.setAdminIdentity('auditeur');

    expect(sh.execute('config antivirus profile')).toContain('Command fail');
  });

  it('un `super_admin` garde tous ses chemins', async () => {
    const { sh } = await laboratoire();
    run(sh, 'config system admin', 'edit "root"',
      'set accprofile "super_admin"', 'next', 'end');

    sh.setAdminIdentity('root');

    expect(sh.execute('config firewall policy')).not.toContain('Command fail');
  });

  it('la double authentification est refusee en nommant la brique absente', async () => {
    const { sh } = await laboratoire();

    const vu = run(sh, 'config system admin', 'edit "admin"',
      'set two-factor fortitoken');

    expect(vu).toContain('Command fail');
    expect(vu).toContain('token');
  });
});

describe('la configuration rendue reproduit ce qui a ete tape', () => {
  it('un utilisateur local et son groupe', async () => {
    const { sh } = await laboratoire();
    utilisateur(sh);
    groupe(sh);

    expect(run(sh, 'show user local')).toContain('edit "jdupont"');
    expect(run(sh, 'show user group')).toContain('set member "jdupont"');
  });

  it('la reference de groupe d`une politique', async () => {
    const { sh } = await laboratoire();
    utilisateur(sh);
    groupe(sh);
    politique(sh, 'set groups "COMMERCIAUX"');

    expect(run(sh, 'show firewall policy')).toContain('set groups "COMMERCIAUX"');
  });

  it('un compte administrateur et son hote de confiance', async () => {
    const { sh } = await laboratoire();

    run(sh, 'config system admin', 'edit "auditeur"',
      'set accprofile "super_admin"',
      'set trusthost1 192.168.1.0 255.255.255.0', 'next', 'end');
    const vu = run(sh, 'show system admin');

    expect(vu).toContain('edit "auditeur"');
    expect(vu).toContain('set trusthost1 192.168.1.0 255.255.255.0');
  });

  it('supprimer un utilisateur le desassocie aussi', async () => {
    const { fw, sh } = await laboratoire();
    utilisateur(sh);
    groupe(sh);
    await fw.getAuthPortal().authenticate(
      CLIENT_IP, { username: 'jdupont', password: 'Secret2026!' });

    run(sh, 'config user local');
    const refus = sh.execute('delete "jdupont"');
    run(sh, 'end');
    expect(refus).toMatch(/used by other entries/i);
    expect(fw.getIdentityTable().lookup(CLIENT_IP)).toBeDefined();

    run(sh, 'config user group', 'delete "COMMERCIAUX"', 'end');
    run(sh, 'config user local', 'delete "jdupont"', 'end');

    expect(fw.getIdentityTable().lookup(CLIENT_IP)).toBeUndefined();
  });
});
