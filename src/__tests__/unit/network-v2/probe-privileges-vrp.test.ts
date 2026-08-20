/**
 * VRP : la gestion des acces chez l'AUTRE constructeur.
 *
 * Ecrite A L'AVEUGLE. Les assertions decrivent ce qu'un vrai VRP fait.
 *
 * Tout ce qui a ete sonde jusqu'ici est du Cisco. Or VRP ne copie pas
 * IOS : il n'a pas de mot de passe d'activation (`enable secret`) — le
 * niveau est une propriete du COMPTE, acquise a l'ouverture de session
 * et non elevee ensuite —, ses niveaux vont de 0 a 15 avec quatre noms
 * (visit, monitor, system, manage), et une commande porte elle aussi un
 * niveau, reglable par `command-privilege level`. La difference qui
 * compte : chez Cisco on MONTE, chez Huawei on ENTRE deja au niveau de
 * son compte. Un simulateur qui ferait monter un utilisateur VRP avec un
 * mot de passe apprendrait une commande qui n'existe pas.
 *
 * Le second sujet est le `service-type` : un compte VRP declare les
 * services qu'il a le droit d'employer (`terminal`, `ssh`, `telnet`,
 * `ftp`, `http`). Un compte sans le service demande est refuse meme avec
 * le bon mot de passe — c'est le controle que Cisco n'a pas.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.clear();
});

async function routeurVrp(): Promise<HuaweiRouter> {
  const r = new HuaweiRouter('AR1', 0, 0);
  r.powerOn();
  await r.executeCommand('system-view');
  await r.executeCommand('sysname AR1');
  await r.executeCommand('interface GigabitEthernet0/0/0');
  await r.executeCommand('ip address 10.0.0.1 255.255.255.0');
  await r.executeCommand('undo shutdown');
  await r.executeCommand('quit');
  await r.executeCommand('aaa');
  await r.executeCommand('local-user admin password irreversible-cipher Admin@2026');
  await r.executeCommand('local-user admin privilege level 15');
  await r.executeCommand('local-user admin service-type terminal ssh');
  await r.executeCommand('local-user tech password irreversible-cipher Tech@2026');
  await r.executeCommand('local-user tech privilege level 3');
  await r.executeCommand('local-user tech service-type terminal ssh');
  await r.executeCommand('quit');
  await r.executeCommand('quit');
  return r;
}

async function config(r: HuaweiRouter, ...lignes: string[]): Promise<void> {
  await r.executeCommand('system-view');
  for (const l of lignes) await r.executeCommand(l);
  await r.executeCommand('quit');
}

describe('VRP — le niveau appartient au COMPTE', () => {
  it('`display current-configuration` rend le niveau de chaque compte', async () => {
    const r = await routeurVrp();
    const vu = await r.executeCommand('display current-configuration');
    expect(vu).toContain('local-user admin privilege level 15');
    expect(vu).toContain('local-user tech privilege level 3');
  }, 30_000);

  it('une session ouverte par un compte prend le niveau de ce compte', async () => {
    const r = await routeurVrp();
    expect(r.resolveVtyExecLevel('admin')).toBe(15);
    expect(r.resolveVtyExecLevel('tech')).toBe(3);
  }, 30_000);

  it('VRP n\'a pas de commande `enable` — on n\'y monte pas de niveau', async () => {
    const r = await routeurVrp();
    const dit = await r.executeCommand('enable');
    expect(dit).toMatch(/Error|Unrecognized|Unknown/i);
  }, 30_000);

  it('un compte inconnu ou un mauvais secret est refuse', async () => {
    const r = await routeurVrp();
    expect(await r.loginAs('admin', 'Admin@2026')).toBe(true);
    expect(await r.loginAs('admin', 'MauvaisSecret')).toBe(false);
    expect(await r.loginAs('fantome', 'Admin@2026')).toBe(false);
  }, 30_000);
});

describe('VRP — `service-type` decide QUEL service le compte peut employer', () => {
  it('un compte sans le service ssh est refuse en ssh, bon mot de passe compris', async () => {
    const r = await routeurVrp();
    await config(r, 'aaa', 'local-user ftpuser password irreversible-cipher Ftp@2026',
      'local-user ftpuser privilege level 3', 'local-user ftpuser service-type ftp', 'quit');
    expect(r.sshdAcceptsLogin('ftpuser').ok).toBe(false);
    expect(r.sshdAcceptsLogin('admin').ok).toBe(true);
  }, 30_000);

  it('le service-type figure dans la configuration', async () => {
    const r = await routeurVrp();
    const vu = await r.executeCommand('display current-configuration');
    expect(vu).toContain('local-user admin service-type');
  }, 30_000);
});

describe('VRP — `authentication-mode` de la user-interface', () => {
  it('`authentication-mode aaa` exige un COMPTE', async () => {
    const r = await routeurVrp();
    await config(r, 'user-interface vty 0 4', 'authentication-mode aaa', 'quit');
    expect(await r.authenticateLine('vty', { user: 'admin', pass: 'Admin@2026' })).toBe(true);
    expect(await r.authenticateLine('vty', { user: 'admin', pass: 'Faux' })).toBe(false);
  }, 30_000);

  it('`authentication-mode password` authentifie sans nom', async () => {
    const r = await routeurVrp();
    await config(r, 'user-interface vty 0 4', 'authentication-mode password',
      'set authentication password cipher Ligne@2026', 'quit');
    expect(await r.authenticateLine('vty', { pass: 'Ligne@2026' })).toBe(true);
    expect(await r.authenticateLine('vty', { pass: 'Faux' })).toBe(false);
  }, 30_000);

  it('`authentication-mode none` ouvre la ligne sans rien demander', async () => {
    const r = await routeurVrp();
    await config(r, 'user-interface vty 0 4', 'authentication-mode none', 'quit');
    expect(await r.authenticateLine('vty', { pass: '' })).toBe(true);
  }, 30_000);

  it('le mode figure dans la configuration', async () => {
    const r = await routeurVrp();
    await config(r, 'user-interface vty 0 4', 'authentication-mode aaa', 'quit');
    expect(await r.executeCommand('display current-configuration')).toContain('authentication-mode aaa');
  }, 30_000);
});

describe('VRP — `user privilege level` de la ligne l\'emporte sur le compte', () => {
  it('la ligne fixe le niveau d\'ouverture', async () => {
    const r = await routeurVrp();
    await config(r, 'user-interface vty 0 4', 'authentication-mode aaa',
      'user privilege level 1', 'quit');
    expect(r.resolveVtyExecLevel('admin')).toBe(1);
  }, 30_000);
});

describe('VRP — `protocol inbound` est une directive de LIGNE', () => {
  it('durcir les vty du haut ne ferme pas celles du bas', async () => {
    const r = await routeurVrp();
    await config(r, 'stelnet server enable',
      'user-interface vty 0 4', 'authentication-mode aaa', 'protocol inbound ssh', 'quit',
      'user-interface vty 5 14', 'authentication-mode aaa', 'protocol inbound none', 'quit');
    expect(r.vtyAdmissionVerdict('ssh', '10.0.0.5').accept).toBe(true);
    expect(r.vtyAdmissionVerdict('telnet', '10.0.0.5').accept).toBe(false);
  }, 30_000);

  it('`protocol inbound none` ferme les deux protocoles', async () => {
    const r = await routeurVrp();
    await config(r, 'user-interface vty 0 4', 'protocol inbound none', 'quit');
    expect(r.vtyAdmissionVerdict('ssh', '10.0.0.5').accept).toBe(false);
    expect(r.vtyAdmissionVerdict('telnet', '10.0.0.5').accept).toBe(false);
  }, 30_000);
});

describe('VRP — `acl inbound` filtre la source avant le mot de passe', () => {
  it('une source hors de la liste est refusee', async () => {
    const r = await routeurVrp();
    await config(r, 'acl number 2000', 'rule 5 permit source 10.0.0.5 0', 'quit',
      'user-interface vty 0 4', 'acl 2000 inbound', 'quit');
    expect(r.vtyAdmissionVerdict('ssh', '10.0.0.5').accept).toBe(true);
    expect(r.vtyAdmissionVerdict('ssh', '10.0.0.99').accept).toBe(false);
  }, 30_000);
});

describe('VRP — un compte bloque ou expire ne passe plus', () => {
  it('`local-user … state block` refuse le compte', async () => {
    const r = await routeurVrp();
    await config(r, 'aaa', 'local-user tech state block', 'quit');
    expect(await r.loginAs('tech', 'Tech@2026')).toBe(false);
    expect(await r.loginAs('admin', 'Admin@2026')).toBe(true);
  }, 30_000);
});
