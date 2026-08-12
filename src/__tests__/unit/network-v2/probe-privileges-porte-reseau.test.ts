/**
 * La porte RESEAU : ce qu'un operateur distant obtient, et ce qu'on lui
 * refuse avant meme qu'il tape son nom.
 *
 * Ecrite A L'AVEUGLE. Les assertions decrivent ce qu'un vrai IOS fait.
 *
 * Tout ce qui a ete sonde jusqu'ici entre par la CONSOLE — c'est-a-dire
 * par la porte qu'il faut deja etre devant la machine pour franchir. La
 * vty est l'autre porte, celle qui est exposee, et elle a ses controles
 * a elle, qui s'appliquent DANS UN ORDRE : le transport d'abord (quel
 * protocole est admis), puis la liste d'acces (quelle source), puis
 * l'authentification (qui), puis le niveau d'ouverture (quoi). Un
 * controle qui s'applique dans le mauvais ordre ne protege rien : une
 * ACL consultee apres l'authentification laisse un inconnu essayer des
 * mots de passe.
 *
 * Ce fichier mesure les quatre etages separement, puis ce que la session
 * distante obtient reellement une fois entree.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
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

/**
 * Un routeur joignable, avec de quoi ouvrir une session SSH : une
 * adresse, un nom de domaine et une paire de cles — sans cles, IOS
 * n'ecoute pas, et c'est la premiere chose a ne pas oublier.
 */
async function routeurJoignable(): Promise<CiscoRouter> {
  const r = new CiscoRouter('BORD', 0, 0);
  r.powerOn();
  await r.executeCommand('enable');
  await r.executeCommand('configure terminal');
  await r.executeCommand('hostname BORD');
  await r.executeCommand('interface GigabitEthernet0/0');
  await r.executeCommand('ip address 10.0.0.1 255.255.255.0');
  await r.executeCommand('no shutdown');
  await r.executeCommand('exit');
  await r.executeCommand('aaa new-model');
  await r.executeCommand('enable secret Coffre15');
  await r.executeCommand('username admin privilege 15 secret Admin15');
  await r.executeCommand('username tech privilege 7 secret Tech7');
  await r.executeCommand('ip domain-name labo.local');
  await r.executeCommand('crypto key generate rsa modulus 1024');
  await r.executeCommand('end');
  await r.executeCommand('disable');
  return r;
}

async function config(r: CiscoRouter, ...lignes: string[]): Promise<void> {
  await r.executeCommand('enable', { passwordInput: 'Coffre15' });
  await r.executeCommand('configure terminal');
  for (const l of lignes) await r.executeCommand(l);
  await r.executeCommand('end');
  await r.executeCommand('disable');
}

describe('PORTE — etage 1 : le transport decide AVANT tout le reste', () => {
  it('`transport input none` ferme la vty aux deux protocoles', async () => {
    const r = await routeurJoignable();
    await config(r, 'line vty 0 4', 'login local', 'transport input none');
    expect(r.vtyAdmissionVerdict('ssh', '10.0.0.5').accept).toBe(false);
    expect(r.vtyAdmissionVerdict('telnet', '10.0.0.5').accept).toBe(false);
  }, 30_000);

  it('`transport input ssh` admet SSH et refuse telnet', async () => {
    const r = await routeurJoignable();
    await config(r, 'line vty 0 4', 'login local', 'transport input ssh');
    expect(r.vtyAdmissionVerdict('ssh', '10.0.0.5').accept).toBe(true);
    expect(r.vtyAdmissionVerdict('telnet', '10.0.0.5').accept).toBe(false);
  }, 30_000);

  it('`transport input telnet` fait l\'inverse', async () => {
    const r = await routeurJoignable();
    await config(r, 'line vty 0 4', 'login local', 'transport input telnet');
    expect(r.vtyAdmissionVerdict('telnet', '10.0.0.5').accept).toBe(true);
    expect(r.vtyAdmissionVerdict('ssh', '10.0.0.5').accept).toBe(false);
  }, 30_000);

  it('le transport figure dans la configuration, donc il survit au rechargement', async () => {
    const r = await routeurJoignable();
    await config(r, 'line vty 0 4', 'login local', 'transport input ssh');
    await r.executeCommand('enable', { passwordInput: 'Coffre15' });
    expect(await r.executeCommand('show running-config')).toContain('transport input ssh');
  }, 30_000);
});

describe('PORTE — etage 2 : la liste d\'acces filtre la SOURCE, avant le mot de passe', () => {
  it('une source hors de la liste est refusee', async () => {
    const r = await routeurJoignable();
    await config(r,
      'access-list 10 permit 10.0.0.5',
      'line vty 0 4', 'login local', 'transport input ssh', 'access-class 10 in');
    expect(r.vtyAdmissionVerdict('ssh', '10.0.0.5').accept).toBe(true);
    expect(r.vtyAdmissionVerdict('ssh', '10.0.0.99').accept).toBe(false);
  }, 30_000);

  it('le refus vient AVANT l\'authentification — un inconnu n\'essaie aucun secret', async () => {
    const r = await routeurJoignable();
    await config(r,
      'access-list 10 permit 10.0.0.5',
      'line vty 0 4', 'login local', 'transport input ssh', 'access-class 10 in');
    const avant = Logger.getLogs().length;
    expect(r.vtyAdmissionVerdict('ssh', '10.0.0.99').accept).toBe(false);
    const nouveaux = Logger.getLogs().slice(avant).map((l) => l.message).join('\n');
    expect(nouveaux).not.toContain('LOGIN_FAILED');
  }, 30_000);

  it('`access-class` figure dans la configuration', async () => {
    const r = await routeurJoignable();
    await config(r, 'access-list 10 permit 10.0.0.5', 'line vty 0 4', 'access-class 10 in');
    await r.executeCommand('enable', { passwordInput: 'Coffre15' });
    expect(await r.executeCommand('show running-config')).toContain('access-class 10 in');
  }, 30_000);
});

describe('PORTE — etage 3 : l\'authentification de la ligne', () => {
  it('`login` sans mot de passe de ligne REFUSE la session', async () => {
    const r = await routeurJoignable();
    await r.executeCommand('enable', { passwordInput: 'Coffre15' });
    await r.executeCommand('configure terminal');
    await r.executeCommand('line vty 0 4');
    const dit = await r.executeCommand('login');
    await r.executeCommand('end');
    await r.executeCommand('disable');
    expect(dit).toContain('Login disabled on line');
    expect(r.vtyAdmissionVerdict('telnet', '10.0.0.5').accept).toBe(false);
  }, 30_000);

  it('`login` + `password` authentifie par le mot de passe de LIGNE, sans nom', async () => {
    const r = await routeurJoignable();
    await config(r, 'line vty 0 4', 'password LigneVty2026', 'login', 'transport input telnet');
    expect(await r.authenticateLine('vty', { pass: 'LigneVty2026' })).toBe(true);
    expect(await r.authenticateLine('vty', { pass: 'PasLeBon' })).toBe(false);
  }, 30_000);

  it('`login local` exige un COMPTE, pas le mot de passe de ligne', async () => {
    const r = await routeurJoignable();
    await config(r, 'line vty 0 4', 'password LigneVty2026', 'login local');
    expect(await r.authenticateLine('vty', { user: 'admin', pass: 'Admin15' })).toBe(true);
    expect(await r.authenticateLine('vty', { user: 'admin', pass: 'LigneVty2026' })).toBe(false);
    expect(await r.authenticateLine('vty', { pass: 'LigneVty2026' })).toBe(false);
  }, 30_000);

  it('`no login` ouvre la ligne sans rien demander — et le dit dans la configuration', async () => {
    const r = await routeurJoignable();
    await config(r, 'line vty 0 4', 'no login', 'transport input telnet');
    expect(await r.authenticateLine('vty', { pass: '' })).toBe(true);
    await r.executeCommand('enable', { passwordInput: 'Coffre15' });
    expect(await r.executeCommand('show running-config')).toContain('no login');
  }, 30_000);

  it('un mot de passe de ligne est CHIFFRE par `service password-encryption`', async () => {
    const r = await routeurJoignable();
    await config(r, 'service password-encryption',
      'line vty 0 4', 'password LigneVty2026', 'login');
    await r.executeCommand('enable', { passwordInput: 'Coffre15' });
    const cfg = await r.executeCommand('show running-config');
    expect(cfg).not.toContain('LigneVty2026');
    expect(cfg).toMatch(/password 7 [0-9A-Fa-f]+/);
  }, 30_000);

  it('et il authentifie TOUJOURS une fois chiffre — l\'aller-retour ne le casse pas', async () => {
    const r = await routeurJoignable();
    await config(r, 'service password-encryption',
      'line vty 0 4', 'password LigneVty2026', 'login', 'transport input telnet');
    expect(await r.authenticateLine('vty', { pass: 'LigneVty2026' })).toBe(true);
  }, 30_000);
});

describe('PORTE — etage 4 : ce que la session distante obtient', () => {
  it('le niveau vient du COMPTE', async () => {
    const r = await routeurJoignable();
    await config(r, 'line vty 0 4', 'login local', 'transport input ssh');
    expect(r.resolveVtyExecLevel('admin')).toBe(15);
    expect(r.resolveVtyExecLevel('tech')).toBe(7);
  }, 30_000);

  it('`privilege level` sur la ligne l\'emporte sur le compte', async () => {
    const r = await routeurJoignable();
    await config(r, 'line vty 0 4', 'login local', 'privilege level 3');
    expect(r.resolveVtyExecLevel('admin')).toBe(3);
    expect(r.resolveVtyExecLevel('tech')).toBe(3);
  }, 30_000);

  it('une session distante apparait dans `show users` avec son nom et sa source', async () => {
    const r = await routeurJoignable();
    await config(r, 'line vty 0 4', 'login local', 'transport input ssh');
    const registre = r.getSshSessionRegistry();
    registre.open({ user: 'tech', privilege: 7, fromIp: '10.0.0.5', localPort: 22 });
    await r.executeCommand('enable', { passwordInput: 'Coffre15' });
    const vu = await r.executeCommand('show users');
    expect(vu).toContain('tech');
    expect(vu).toContain('10.0.0.5');
    expect(vu).toContain('vty');
  }, 30_000);

  it('sur une vty, `enable` sans coffre est REFUSE — la console seule passe', async () => {
    const r = new CiscoRouter('NU', 0, 0);
    r.powerOn();
    const shell = (r as unknown as {
      getShell(): {
        interactionPlanFor(c: string, ctx: Record<string, unknown>): unknown;
      };
    }).getShell();
    const surVty = shell.interactionPlanFor('enable', { onVtyLine: true, mode: 'user' });
    expect(JSON.stringify(surVty)).toContain('% No password set');
    expect(shell.interactionPlanFor('enable', { onVtyLine: false, mode: 'user' })).toBeNull();
  }, 30_000);
});

describe('PORTE — le mode silencieux et son exemption', () => {
  it('`login quiet-mode access-class` laisse passer l\'hote permis', async () => {
    const r = await routeurJoignable();
    await config(r,
      'access-list 20 permit 10.0.0.5',
      'login block-for 300 attempts 3 within 60',
      'login quiet-mode access-class 20',
      'line vty 0 4', 'login local', 'transport input ssh');
    for (const faux of ['f1', 'f2', 'f3']) {
      await r.authenticateLine('vty', { user: 'admin', pass: faux });
    }
    expect(r.getLoginBlocker()?.isBlocked()).toBe(true);
    expect(r.vtyAdmissionVerdict('ssh', '10.0.0.5').accept).toBe(true);
    expect(r.vtyAdmissionVerdict('ssh', '10.0.0.99').accept).toBe(false);
  }, 30_000);
});

describe('PORTE — deux plages de vty qui ne disent pas la meme chose', () => {
  it('durcir les vty du haut ne ferme pas celles du bas', async () => {
    const r = await routeurJoignable();
    await config(r,
      'line vty 0 4', 'login local', 'transport input ssh',
      'line vty 5 15', 'login local', 'transport input none');
    expect(r.vtyAdmissionVerdict('ssh', '10.0.0.5').accept).toBe(true);
    expect(r.isSshActive()).toBe(true);
  }, 30_000);

  it('la plage du haut refuse quand les cinq premieres lignes sont prises', async () => {
    const r = await routeurJoignable();
    await config(r,
      'line vty 0 4', 'login local', 'transport input ssh',
      'line vty 5 15', 'login local', 'transport input none');
    const registre = r.getSshSessionRegistry();
    for (let i = 0; i < 5; i++) {
      expect(registre.open({ user: 'tech', fromIp: `10.0.0.${i + 10}`, localPort: 22 })).not.toBeNull();
    }
    expect(r.vtyAdmissionVerdict('ssh', '10.0.0.99').accept).toBe(false);
  }, 30_000);

  it('la liste d\'acces d\'une plage ne filtre pas l\'autre', async () => {
    const r = await routeurJoignable();
    await config(r,
      'access-list 30 permit 10.0.0.5',
      'line vty 0 4', 'login local',
      'line vty 5 15', 'access-class 30 in');
    expect(r.vtyAdmissionVerdict('ssh', '10.0.0.99').accept).toBe(true);
  }, 30_000);

  it('`privilege level` d\'une plage ne s\'applique pas a l\'autre', async () => {
    const r = await routeurJoignable();
    await config(r,
      'line vty 0 4', 'login local',
      'line vty 5 15', 'login local', 'privilege level 1');
    expect(r.resolveVtyExecLevel('admin')).toBe(15);
  }, 30_000);

  it('les deux plages figurent dans la configuration avec leur transport', async () => {
    const r = await routeurJoignable();
    await config(r,
      'line vty 0 4', 'transport input ssh',
      'line vty 5 15', 'transport input none');
    await r.executeCommand('enable', { passwordInput: 'Coffre15' });
    const vu = await r.executeCommand('show running-config');
    expect(vu).toContain('line vty 0 4');
    expect(vu).toContain('transport input ssh');
    expect(vu).toContain('line vty 5 15');
    expect(vu).toContain('transport input none');
  }, 30_000);
});

describe('PORTE — la reserve de lignes', () => {
  it('une vty de trop est refusee, et la machine le dit', async () => {
    const r = await routeurJoignable();
    await config(r, 'line vty 0 4', 'login local', 'transport input ssh');
    const registre = r.getSshSessionRegistry();
    for (let i = 0; i < 5; i++) {
      expect(registre.open({ user: 'tech', fromIp: `10.0.0.${i + 10}`, localPort: 22 })).not.toBeNull();
    }
    expect(registre.open({ user: 'tech', fromIp: '10.0.0.99', localPort: 22 })).toBeNull();
    expect(r.vtyAdmissionVerdict('ssh', '10.0.0.99').accept).toBe(false);
  }, 30_000);
});
