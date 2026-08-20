/**
 * Les privileges tenus par une VRAIE equipe reseau, pas par un exemple.
 *
 * Le laboratoire est celui d'une banque : un coeur de reseau et un
 * commutateur d'acces, et une equipe entiere autour — le responsable
 * reseau, le chef d'equipe, un officier du centre d'exploitation, un
 * stagiaire, et un prestataire externe. Chacun a un role, et un role
 * n'est pas une politesse : c'est ce qui empeche le stagiaire de
 * reconfigurer le lien vers la compensation interbancaire, et le
 * prestataire de lire les secrets de la machine.
 *
 * Ce fichier mesure les DEUX sens de chaque regle. Verifier qu'un
 * administrateur peut tout faire ne prouve rien : ce qui se prouve, c'est
 * qu'un niveau inferieur est ARRETE, et qu'il l'est a l'endroit exact ou
 * IOS l'arrete — une commande hors de son arbre repond comme une commande
 * qui n'existe pas, pas comme un refus.
 *
 * Les cas d'echelle (`ESCALADE`) sont les plus importants : ce sont ceux
 * ou un mecanisme mal branche rend les droits d'administration sans que
 * personne l'ait demande.
 *
 * DISCRIMINATION — 27 des 31 cas tombent quand on restaure l'etat d'avant
 * les correctifs de privileges. Les QUATRE qui passent des deux cotes
 * sont nommes ici plutot que laisses a decouvrir, et deux d'entre eux
 * sont instructifs : « le bon secret l'ouvre » et « les secrets sont
 * condenses » passaient AVANT parce que `executeCommand('enable', {
 * passwordInput })` ignorait le mot de passe et accordait le niveau 15
 * sans rien demander — c'est-a-dire que la faille elle-meme les faisait
 * reussir. Les deux cas de vue passaient parce que la session restait au
 * niveau 1, ou `show running-config` est refuse de toute facon : ils
 * gardent le mecanisme des vues, ils ne le prouvent pas seuls.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
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

const REFUS = "% Invalid input detected at '^' marker.";

/**
 * En EXEC utilisateur, un mot que l'arbre ne contient pas n'est pas
 * refuse au caret : IOS le prend pour un NOM D'HOTE a joindre et tente de
 * le resoudre. Une commande de configuration tapee la — `username`,
 * `vlan` — tombe donc dans ce cas. Ce qui compte pour la securite reste
 * verifie a cote : elle ne s'execute pas.
 */
const INCONNU_EN_EXEC = /Translating "|% Unknown command or computer name/;

interface Compte { nom: string; secret: string; niveau: number }

const EQUIPE: readonly Compte[] = [
  { nom: 'dsi.reseau', secret: 'Dsi@Banque2026', niveau: 15 },
  { nom: 'lead.reseau', secret: 'Lead@Banque2026', niveau: 10 },
  { nom: 'officer.noc', secret: 'Noc@Banque2026', niveau: 5 },
  { nom: 'stagiaire', secret: 'Stag@Banque2026', niveau: 1 },
  { nom: 'presta.cisco', secret: 'Presta@Banque2026', niveau: 1 },
];

async function coeurDeBanque(): Promise<CiscoRouter> {
  const r = new CiscoRouter('BQ-CORE-01', 0, 0);
  r.powerOn();
  await r.executeCommand('enable');
  await r.executeCommand('configure terminal');
  await r.executeCommand('hostname BQ-CORE-01');
  await r.executeCommand('service password-encryption');
  await r.executeCommand('enable secret Coffre@Banque2026');
  await r.executeCommand('aaa new-model');

  for (const c of EQUIPE) {
    await r.executeCommand(`username ${c.nom} privilege ${c.niveau} secret ${c.secret}`);
  }

  // `show` redescendu au niveau 1 : hisser une commande hisse ses
  // PARENTES, donc toute la branche `show` quitterait le niveau 1 —
  // c'est le piège n°1 du chapitre, et cette ligne en est le remède
  // documenté par Cisco. Sans elle, ce laboratoire décrirait une
  // machine qui n'existe pas.
  await r.executeCommand('privilege exec level 1 show');
  await r.executeCommand('privilege exec level 5 show ip route');
  await r.executeCommand('privilege exec level 5 show interfaces');
  await r.executeCommand('privilege exec level 5 clear counters');

  await r.executeCommand('privilege exec level 10 show running-config');
  await r.executeCommand('privilege exec level 10 configure terminal');
  await r.executeCommand('privilege configure level 10 interface');
  await r.executeCommand('privilege interface level 10 shutdown');
  await r.executeCommand('privilege interface level 10 description');

  await r.executeCommand('parser view VUE_PRESTA');
  await r.executeCommand('secret Vue@Presta2026');
  await r.executeCommand('commands exec include show version');
  await r.executeCommand('commands exec include ping');
  await r.executeCommand('exit');

  await r.executeCommand('login block-for 300 attempts 3 within 60');
  await r.executeCommand('banner motd # ACCES RESERVE - BANQUE - TOUTE CONNEXION EST TRACEE #');
  await r.executeCommand('line console 0');
  await r.executeCommand('login local');
  await r.executeCommand('exit');
  await r.executeCommand('line vty 0 4');
  await r.executeCommand('login local');
  await r.executeCommand('transport input ssh');
  await r.executeCommand('exec-timeout 5 0');
  await r.executeCommand('end');
  await r.executeCommand('disable');
  return r;
}

async function connecte(r: CiscoRouter, c: Compte): Promise<void> {
  const ouvert = await r.loginAs(c.nom, c.secret);
  expect(ouvert, `${c.nom} doit pouvoir ouvrir sa session`).toBe(true);
}

describe('BANQUE — chaque role ouvre au niveau qui est le sien', () => {
  it.each(EQUIPE.map((c) => [c.nom, c] as const))(
    '%s ouvre exactement a son niveau declare', async (_nom, c) => {
      const r = await coeurDeBanque();
      await connecte(r, c);
      expect(await r.executeCommand('show privilege'))
        .toContain(`Current privilege level is ${c.niveau}`);
    }, 30_000);

  it('l\'invite dit le mode, et le niveau 1 ne porte pas le diese', async () => {
    const r = await coeurDeBanque();
    await connecte(r, EQUIPE[3]);
    expect(r.getPrompt()).toBe('BQ-CORE-01>');
    await connecte(r, EQUIPE[2]);
    expect(r.getPrompt()).toBe('BQ-CORE-01#');
    await connecte(r, EQUIPE[0]);
    expect(r.getPrompt()).toBe('BQ-CORE-01#');
  }, 30_000);

  it('un mauvais secret n\'ouvre aucune session', async () => {
    const r = await coeurDeBanque();
    expect(await r.loginAs('dsi.reseau', 'Lead@Banque2026')).toBe(false);
    expect(await r.loginAs('inconnu', 'peu importe')).toBe(false);
  }, 30_000);
});

describe('BANQUE — le stagiaire est arrete, et la ou IOS l\'arrete', () => {
  it('il ne peut pas entrer en configuration', async () => {
    const r = await coeurDeBanque();
    await connecte(r, EQUIPE[3]);
    expect(await r.executeCommand('configure terminal')).toContain(REFUS);
    expect(r.getPrompt()).toBe('BQ-CORE-01>');
  }, 30_000);

  it('il ne peut pas lire la configuration, donc pas les secrets', async () => {
    const r = await coeurDeBanque();
    await connecte(r, EQUIPE[3]);
    const vu = await r.executeCommand('show running-config');
    expect(vu).not.toContain('Coffre@Banque2026');
    expect(vu).not.toContain('username dsi.reseau');
  }, 30_000);

  it('il ne peut ni redemarrer la machine ni creer un compte', async () => {
    const r = await coeurDeBanque();
    await connecte(r, EQUIPE[3]);
    expect(await r.executeCommand('reload')).toContain(REFUS);
    expect(await r.executeCommand('username pirate privilege 15 secret x'))
      .toMatch(INCONNU_EN_EXEC);
    await connecte(r, EQUIPE[0]);
    expect(await r.executeCommand('show running-config')).not.toContain('username pirate');
  }, 30_000);

  it('le socle du niveau 1 lui reste, sinon il ne pourrait rien diagnostiquer', async () => {
    const r = await coeurDeBanque();
    await connecte(r, EQUIPE[3]);
    expect(await r.executeCommand('show version')).toContain('Cisco IOS Software');
  }, 30_000);
});

describe('BANQUE — l\'officier du NOC a ce qu\'on lui a donne, et rien de plus', () => {
  it('les trois commandes descendues au niveau 5 lui repondent', async () => {
    const r = await coeurDeBanque();
    await connecte(r, EQUIPE[2]);
    expect(await r.executeCommand('show ip route')).not.toContain(REFUS);
    expect(await r.executeCommand('show interfaces')).not.toContain(REFUS);
  }, 30_000);

  it('ce qui n\'a pas ete descendu lui reste invisible', async () => {
    const r = await coeurDeBanque();
    await connecte(r, EQUIPE[2]);
    expect(await r.executeCommand('show running-config')).toContain(REFUS);
    expect(await r.executeCommand('configure terminal')).toContain(REFUS);
  }, 30_000);

  it('la meme commande descendue au 5 reste refusee au stagiaire', async () => {
    const r = await coeurDeBanque();
    await connecte(r, EQUIPE[3]);
    expect(await r.executeCommand('clear counters')).toContain(REFUS);
    await connecte(r, EQUIPE[2]);
    expect(await r.executeCommand('clear counters')).not.toContain(REFUS);
  }, 30_000);
});

describe('BANQUE — le chef d\'equipe configure, mais pas tout', () => {
  it('il entre en configuration et decrit une interface', async () => {
    const r = await coeurDeBanque();
    await connecte(r, EQUIPE[1]);
    await r.executeCommand('configure terminal');
    expect(r.getPrompt()).toBe('BQ-CORE-01(config)#');
    await r.executeCommand('interface GigabitEthernet0/0');
    expect(r.getPrompt()).toBe('BQ-CORE-01(config-if)#');
    expect(await r.executeCommand('description LIEN-COMPENSATION')).toBe('');
    expect(await r.executeCommand('shutdown')).toBe('');
  }, 30_000);

  it('ce qu\'on ne lui a pas donne en configuration lui est refuse', async () => {
    const r = await coeurDeBanque();
    await connecte(r, EQUIPE[1]);
    await r.executeCommand('configure terminal');
    expect(await r.executeCommand('username pirate privilege 15 secret x')).toContain(REFUS);
    expect(await r.executeCommand('router ospf 1')).toContain(REFUS);
    expect(await r.executeCommand('enable secret AutreCoffre')).toContain(REFUS);
  }, 30_000);

  it('ESCALADE — `end` depuis la configuration ne le fait pas monter a 15', async () => {
    const r = await coeurDeBanque();
    await connecte(r, EQUIPE[1]);
    await r.executeCommand('configure terminal');
    await r.executeCommand('end');
    expect(await r.executeCommand('show privilege')).toContain('Current privilege level is 10');
    expect(await r.executeCommand('reload')).toContain(REFUS);
  }, 30_000);

  it('ESCALADE — il ne peut pas s\'elever en creant un compte de niveau 15', async () => {
    const r = await coeurDeBanque();
    await connecte(r, EQUIPE[1]);
    await r.executeCommand('configure terminal');
    await r.executeCommand('username lead.reseau privilege 15 secret Lead@Banque2026');
    await r.executeCommand('end');
    expect(await r.executeCommand('show privilege')).toContain('Current privilege level is 10');
    await connecte(r, EQUIPE[1]);
    expect(await r.executeCommand('show privilege')).toContain('Current privilege level is 10');
  }, 30_000);
});

describe('BANQUE — le prestataire vit dans une vue, pas dans un niveau', () => {
  it('la vue REMPLACE l\'arbre : ce qu\'elle n\'inclut pas est absent', async () => {
    const r = await coeurDeBanque();
    await r.executeCommand('enable', { passwordInput: 'Coffre@Banque2026' });
    await r.executeCommand('enable view VUE_PRESTA', { passwordInput: 'Vue@Presta2026' });
    expect(await r.executeCommand('show parser view')).toContain('VUE_PRESTA');
    expect(await r.executeCommand('show version')).not.toContain(REFUS);
    expect(await r.executeCommand('show running-config')).toContain(REFUS);
    expect(await r.executeCommand('configure terminal')).toContain(REFUS);
  }, 30_000);

  it('on sort toujours d\'une vue — un role n\'est pas une souriciere', async () => {
    const r = await coeurDeBanque();
    await r.executeCommand('enable', { passwordInput: 'Coffre@Banque2026' });
    await r.executeCommand('enable view VUE_PRESTA', { passwordInput: 'Vue@Presta2026' });
    expect(await r.executeCommand('exit')).not.toContain(REFUS);
  }, 30_000);
});

describe('BANQUE — le coffre : le secret d\'activation tient vraiment', () => {
  it('un mauvais secret n\'ouvre pas le mode privilegie', async () => {
    const r = await coeurDeBanque();
    const refuse = await r.executeCommand('enable', { passwordInput: 'CeQueJeCrois' });
    expect(refuse).toContain('% Bad secrets');
    expect(r.getPrompt()).toBe('BQ-CORE-01>');
  }, 30_000);

  it('le bon secret l\'ouvre', async () => {
    const r = await coeurDeBanque();
    const ok = await r.executeCommand('enable', { passwordInput: 'Coffre@Banque2026' });
    expect(ok).not.toContain('% Bad secrets');
    expect(r.getPrompt()).toBe('BQ-CORE-01#');
  }, 30_000);

  it('les secrets sont condenses dans la configuration, jamais en clair', async () => {
    const r = await coeurDeBanque();
    await r.executeCommand('enable', { passwordInput: 'Coffre@Banque2026' });
    const cfg = await r.executeCommand('show running-config');
    for (const c of EQUIPE) expect(cfg, c.nom).not.toContain(c.secret);
    expect(cfg).not.toContain('Coffre@Banque2026');
    expect(cfg).toMatch(/enable secret 5 \$1\$/);
  }, 30_000);
});

describe('BANQUE — la force brute ferme le reseau, jamais la console', () => {
  it('trois echecs sur vty declenchent le mode silencieux', async () => {
    const r = await coeurDeBanque();
    for (const essai of ['x1', 'x2', 'x3']) {
      expect(await r.authenticateLine('vty', { user: 'dsi.reseau', pass: essai })).toBe(false);
    }
    expect(r.getLoginBlocker()?.isBlocked()).toBe(true);
    expect(await r.authenticateLine('vty', { user: 'dsi.reseau', pass: 'Dsi@Banque2026' }))
      .toBe(false);
  }, 30_000);

  it('la console reste ouverte pendant le mode silencieux — c\'est le retour', async () => {
    const r = await coeurDeBanque();
    for (const essai of ['x1', 'x2', 'x3']) {
      await r.authenticateLine('vty', { user: 'dsi.reseau', pass: essai });
    }
    expect(r.getLoginBlocker()?.isBlocked()).toBe(true);
    expect(await r.authenticateLine('console', { user: 'dsi.reseau', pass: 'Dsi@Banque2026' }))
      .toBe(true);
  }, 30_000);
});

describe('BANQUE — la machine dit qui est dessus, et le rappelle', () => {
  it('la banniere d\'avertissement est celle qui a ete posee', async () => {
    const r = await coeurDeBanque();
    expect(r.getBanner()).toContain('ACCES RESERVE - BANQUE');
  }, 30_000);

  it('`show users` nomme l\'operateur connecte', async () => {
    const r = await coeurDeBanque();
    await connecte(r, EQUIPE[0]);
    const vu = await r.executeCommand('show users');
    expect(vu).toContain('Line');
    expect(vu).toContain('dsi.reseau');
  }, 30_000);

  it('AAA replie sur la base locale quand le serveur TACACS+ ne repond pas', async () => {
    const r = await coeurDeBanque();
    await r.executeCommand('enable', { passwordInput: 'Coffre@Banque2026' });
    await r.executeCommand('configure terminal');
    await r.executeCommand('aaa authentication login default group tacacs+ local');
    await r.executeCommand('end');
    const verdict = await r.authenticateAAA({
      user: 'dsi.reseau', pass: 'Dsi@Banque2026', serverAvailable: false,
    });
    expect(verdict.success).toBe(true);
    expect(verdict.methodUsed).toBe('local');
  }, 30_000);
});

describe('BANQUE — le commutateur d\'acces applique les memes regles', () => {
  async function acces(): Promise<CiscoSwitch> {
    const sw = new CiscoSwitch('sw-bq', 'BQ-ACCES-01', 24, 0, 0);
    sw.powerOn();
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('enable secret Coffre@Acces2026');
    await sw.executeCommand('username stagiaire privilege 1 secret Stag@Banque2026');
    await sw.executeCommand('username dsi.reseau privilege 15 secret Dsi@Banque2026');
    await sw.executeCommand('end');
    await sw.executeCommand('disable');
    return sw;
  }

  it('le coffre du commutateur tient comme celui du routeur', async () => {
    const sw = await acces();
    expect(await sw.executeCommand('enable', { passwordInput: 'faux' }))
      .toContain('% Bad secrets');
    expect(sw.getPrompt()).toBe('BQ-ACCES-01>');
    await sw.executeCommand('enable', { passwordInput: 'Coffre@Acces2026' });
    expect(sw.getPrompt()).toBe('BQ-ACCES-01#');
  }, 30_000);

  it('le stagiaire y ouvre au niveau 1, le responsable au niveau 15', async () => {
    const sw = await acces();
    expect(await sw.loginAs('stagiaire', 'Stag@Banque2026')).toBe(true);
    expect(await sw.executeCommand('show privilege')).toContain('Current privilege level is 1');
    expect(await sw.loginAs('dsi.reseau', 'Dsi@Banque2026')).toBe(true);
    expect(await sw.executeCommand('show privilege')).toContain('Current privilege level is 15');
  }, 30_000);

  it('le stagiaire ne configure pas le commutateur d\'acces', async () => {
    const sw = await acces();
    await sw.loginAs('stagiaire', 'Stag@Banque2026');
    expect(await sw.executeCommand('configure terminal')).toContain(REFUS);
    expect(await sw.executeCommand('vlan 666')).toMatch(INCONNU_EN_EXEC);
    await sw.loginAs('dsi.reseau', 'Dsi@Banque2026');
    expect(await sw.executeCommand('show vlan brief')).not.toContain('666');
  }, 30_000);
});
