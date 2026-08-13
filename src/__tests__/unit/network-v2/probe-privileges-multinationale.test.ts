/**
 * Les privileges d'une multinationale, ecrits A L'AVEUGLE.
 *
 * Les assertions de ce fichier decrivent ce qu'un VRAI IOS fait, sans
 * avoir ete ajustees sur ce que le simulateur rend aujourd'hui : c'est
 * la methode qui fait apparaitre les manques au lieu de les contourner.
 * Un cas rouge ici est donc une question ouverte — soit le produit, soit
 * l'assertion — et non un echec de la sonde.
 *
 * L'organisation est celle d'un groupe : un siege, un commutateur
 * d'acces, une agence, et dix roles qui ne se recouvrent que
 * partiellement. Ce qui est mesure ici et ne l'etait pas dans la sonde
 * bancaire :
 *
 * - la SEPARATION DES DEVOIRS : l'auditeur lit tout et n'ecrit rien, le
 *   gestionnaire de changement ecrit et ne touche pas aux comptes ;
 * - l'ESCALADE PAR PALIERS : monter du 7 au 12 exige le secret du 12 ;
 * - le CYCLE DE VIE d'un compte : depart, verrouillage, deverrouillage ;
 * - les VUES COMPOSEES (`superview`) et la vue attachee a un compte ;
 * - le RETRAIT d'une delegation (`privilege exec reset`), qui doit la
 *   retirer a toute l'equipe d'un coup ;
 * - l'ALLER-RETOUR DE CONFIGURATION : la configuration rendue est
 *   rejouee a l'import d'une topologie, donc une delegation qui ne
 *   survit pas au round-trip n'existe pas vraiment ;
 * - la COHERENCE ENTRE PLATEFORMES : un role ne doit pas etre plus
 *   puissant sur un commutateur que sur un routeur.
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

interface Role { nom: string; secret: string; niveau: number }

const ARCHITECTE: Role = { nom: 'arch.reseau', secret: 'Arch@Acme2026', niveau: 15 };
const CHANGEMENT: Role = { nom: 'chg.manager', secret: 'Chg@Acme2026', niveau: 12 };
const AUDITEUR: Role = { nom: 'rssi.audit', secret: 'Rssi@Acme2026', niveau: 5 };
const NOC2: Role = { nom: 'noc.n2', secret: 'Noc2@Acme2026', niveau: 7 };
const NOC1: Role = { nom: 'noc.n1', secret: 'Noc1@Acme2026', niveau: 3 };
const STAGIAIRE: Role = { nom: 'stagiaire', secret: 'Stag@Acme2026', niveau: 1 };
const PARTANT: Role = { nom: 'ancien.employe', secret: 'Part@Acme2026', niveau: 12 };

const TOUS: readonly Role[] = [
  ARCHITECTE, CHANGEMENT, AUDITEUR, NOC2, NOC1, STAGIAIRE, PARTANT,
];

async function siege(): Promise<CiscoRouter> {
  const r = new CiscoRouter('ACME-HQ-CORE', 0, 0);
  r.powerOn();
  await r.executeCommand('enable');
  await r.executeCommand('configure terminal');
  await r.executeCommand('hostname ACME-HQ-CORE');
  await r.executeCommand('service password-encryption');
  await r.executeCommand('aaa new-model');
  await r.executeCommand('aaa authentication login default local');
  await r.executeCommand('aaa authorization exec default local');
  await r.executeCommand('aaa local authentication attempts max-fail 3');

  await r.executeCommand('enable secret Coffre15@Acme');
  await r.executeCommand('enable secret level 12 Coffre12@Acme');
  await r.executeCommand('enable secret level 5 Coffre5@Acme');

  for (const c of TOUS) {
    await r.executeCommand(`username ${c.nom} privilege ${c.niveau} secret ${c.secret}`);
  }

  await r.executeCommand('privilege exec level 3 show ip interface brief');
  await r.executeCommand('privilege exec level 3 show cdp neighbors');

  await r.executeCommand('privilege exec level 7 clear counters');
  await r.executeCommand('privilege exec level 7 debug ip icmp');
  await r.executeCommand('privilege exec level 7 configure terminal');
  await r.executeCommand('privilege configure level 7 interface');
  await r.executeCommand('privilege interface level 7 shutdown');

  await r.executeCommand('privilege exec level 5 show running-config');
  await r.executeCommand('privilege exec level 5 show archive log config all');

  await r.executeCommand('privilege exec level 12 write memory');
  await r.executeCommand('privilege configure level 12 router');
  await r.executeCommand('privilege configure level 12 ip route');

  await r.executeCommand('parser view VUE_WAN_LECTURE');
  await r.executeCommand('secret Wan@Lecture2026');
  await r.executeCommand('commands exec include show ip route');
  await r.executeCommand('commands exec include show interfaces');
  await r.executeCommand('exit');
  await r.executeCommand('parser view VUE_WAN_TESTS');
  await r.executeCommand('secret Wan@Tests2026');
  await r.executeCommand('commands exec include ping');
  await r.executeCommand('commands exec include traceroute');
  await r.executeCommand('exit');
  await r.executeCommand('parser view VUE_PRESTA_WAN superview');
  await r.executeCommand('secret Presta@Wan2026');
  await r.executeCommand('view VUE_WAN_LECTURE');
  await r.executeCommand('view VUE_WAN_TESTS');
  await r.executeCommand('exit');
  await r.executeCommand('username presta.wan privilege 1 view VUE_PRESTA_WAN secret Presta@Wan2026');

  await r.executeCommand('archive');
  await r.executeCommand('log config');
  await r.executeCommand('logging enable');
  await r.executeCommand('hidekeys');
  await r.executeCommand('exit');
  await r.executeCommand('exit');

  await r.executeCommand('login block-for 300 attempts 3 within 60');
  await r.executeCommand('line console 0');
  await r.executeCommand('login local');
  await r.executeCommand('exit');
  await r.executeCommand('line vty 0 4');
  await r.executeCommand('login local');
  await r.executeCommand('transport input ssh');
  await r.executeCommand('exec-timeout 10 0');
  await r.executeCommand('end');
  await r.executeCommand('disable');
  return r;
}

async function ouvre(r: CiscoRouter, c: Role): Promise<void> {
  expect(await r.loginAs(c.nom, c.secret), `${c.nom} doit ouvrir sa session`).toBe(true);
}

describe('ACME — chaque role ouvre a son niveau, sur dix roles', () => {
  it.each(TOUS.map((c) => [c.nom, c] as const))('%s ouvre au bon niveau', async (_n, c) => {
    const r = await siege();
    await ouvre(r, c);
    expect(await r.executeCommand('show privilege'))
      .toContain(`Current privilege level is ${c.niveau}`);
  }, 30_000);
});

describe('ACME — separation des devoirs : lire n\'est pas ecrire', () => {
  /**
   * Ce cas affirmait que l'auditeur lit la configuration ENTIÈRE, dont
   * les comptes locaux et les délégations. C'est exactement ce que Cisco
   * dit qui ne doit pas arriver : `show running-config` ne montre que
   * « les commandes que l'utilisateur courant peut MODIFIER », et la
   * documentation nomme elle-même le risque — un niveau intermédiaire
   * qui lit `snmp-server community` reprend la machine.
   *
   * Le scénario garde son objet, « lire n'est pas écrire », et gagne le
   * bon enseignement : déléguer `show running-config` ne délègue pas la
   * lecture de tout. Ce que l'auditeur doit voir se délègue ligne à
   * ligne, dans l'espace `configure`.
   */
  it('l\'auditeur lit la configuration RAMENÉE à ce qu\'il peut modifier', async () => {
    const r = await siege();
    await ouvre(r, AUDITEUR);
    const cfg = await r.executeCommand('show running-config');
    expect(cfg).toContain('Building configuration');
    expect(cfg).not.toContain('username arch.reseau');
    expect(cfg).not.toContain('privilege exec level 7 configure terminal');
  }, 30_000);

  it('ce que l\'auditeur doit voir se délègue explicitement', async () => {
    const r = await siege();
    await ouvre(r, ARCHITECTE);
    await r.executeCommand('configure terminal');
    await r.executeCommand('privilege configure level 5 hostname');
    await r.executeCommand('end');

    await ouvre(r, AUDITEUR);
    expect(await r.executeCommand('show running-config')).toContain('hostname ');
  }, 30_000);

  it('l\'auditeur n\'ECRIT rien — ni configuration, ni interface', async () => {
    const r = await siege();
    await ouvre(r, AUDITEUR);
    expect(await r.executeCommand('configure terminal')).toContain(REFUS);
    expect(await r.executeCommand('clear counters')).toContain(REFUS);
  }, 30_000);

  /**
   * LA limite du modele par niveaux, et elle vaut d'etre epinglee : les
   * niveaux forment un ordre TOTAL, donc un niveau superieur herite de
   * tout ce qu'on a donne aux niveaux inferieurs. « Un auditeur qui lit
   * tout sans que les operateurs puissent lire ce qu'il lit » est donc
   * IMPOSSIBLE a decrire avec des niveaux seuls — et c'est exactement la
   * raison d'etre des vues d'analyseur, qui remplacent l'arbre au lieu
   * de s'y ajouter. Le cas suivant le mesure dans les deux sens.
   */
  it('un niveau superieur HERITE de ce qu\'on a donne aux inferieurs', async () => {
    const r = await siege();
    await ouvre(r, CHANGEMENT);
    expect(await r.executeCommand('show archive log config all')).not.toContain(REFUS);
    expect(await r.executeCommand('show running-config')).toContain('Building configuration');
  }, 30_000);

  it('une VUE, elle, ne herite de rien — c\'est a cela qu\'elle sert', async () => {
    const r = await siege();
    expect(await r.loginAs('presta.wan', 'Presta@Wan2026')).toBe(true);
    expect(await r.executeCommand('show running-config')).toContain(REFUS);
    expect(await r.executeCommand('show archive log config all')).toContain(REFUS);
    expect(await r.executeCommand('show ip route')).not.toContain(REFUS);
  }, 30_000);

  it('le gestionnaire de changement ECRIT le routage mais ne cree aucun compte', async () => {
    const r = await siege();
    await ouvre(r, CHANGEMENT);
    await r.executeCommand('configure terminal');
    expect(r.getPrompt()).toBe('ACME-HQ-CORE(config)#');
    expect(await r.executeCommand('ip route 10.9.0.0 255.255.0.0 192.0.2.1')).toBe('');
    expect(await r.executeCommand('username pirate privilege 15 secret x')).toContain(REFUS);
    expect(await r.executeCommand('aaa authentication login default none')).toContain(REFUS);
  }, 30_000);

  it('le NOC1 ne LIT ni la configuration ni la piste d\'audit', async () => {
    const r = await siege();
    await ouvre(r, NOC1);
    expect(await r.executeCommand('show running-config')).toContain(REFUS);
    expect(await r.executeCommand('show archive log config all')).toContain(REFUS);
  }, 30_000);
});

describe('ACME — l\'escalade se fait par paliers, chacun avec son coffre', () => {
  it('le NOC2 monte au 12 avec le secret du 12, et pas avec le sien', async () => {
    const r = await siege();
    await ouvre(r, NOC2);
    expect(await r.executeCommand('enable 12', { passwordInput: 'Noc2@Acme2026' }))
      .toContain('% Bad secrets');
    expect(await r.executeCommand('show privilege')).toContain('Current privilege level is 7');

    await r.executeCommand('enable 12', { passwordInput: 'Coffre12@Acme' });
    expect(await r.executeCommand('show privilege')).toContain('Current privilege level is 12');
  }, 30_000);

  it('le secret du 12 n\'ouvre pas le 15', async () => {
    const r = await siege();
    await ouvre(r, NOC2);
    expect(await r.executeCommand('enable', { passwordInput: 'Coffre12@Acme' }))
      .toContain('% Bad secrets');
    expect(await r.executeCommand('show privilege')).toContain('Current privilege level is 7');
  }, 30_000);

  it('ESCALADE — `end` depuis la configuration ne fait pas monter le NOC2', async () => {
    const r = await siege();
    await ouvre(r, NOC2);
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand('shutdown');
    await r.executeCommand('end');
    expect(await r.executeCommand('show privilege')).toContain('Current privilege level is 7');
    expect(await r.executeCommand('write memory')).toContain(REFUS);
  }, 30_000);

  it('ESCALADE — le NOC2 ne peut pas s\'octroyer une commande de niveau 12', async () => {
    const r = await siege();
    await ouvre(r, NOC2);
    await r.executeCommand('configure terminal');
    expect(await r.executeCommand('privilege exec level 7 write memory')).toContain(REFUS);
    await r.executeCommand('end');
    expect(await r.executeCommand('write memory')).toContain(REFUS);
  }, 30_000);
});

describe('ACME — retirer une delegation la retire a toute l\'equipe', () => {
  it('`privilege exec reset` rend la commande au niveau 15', async () => {
    const r = await siege();
    await ouvre(r, AUDITEUR);
    expect(await r.executeCommand('show running-config')).toContain('Building configuration');

    await ouvre(r, ARCHITECTE);
    await r.executeCommand('configure terminal');
    expect(await r.executeCommand('privilege exec reset show running-config')).toBe('');
    await r.executeCommand('end');

    await ouvre(r, AUDITEUR);
    expect(await r.executeCommand('show running-config')).toContain(REFUS);
  }, 30_000);
});

describe('ACME — cycle de vie des comptes', () => {
  it('un employe qui part ne se connecte plus', async () => {
    const r = await siege();
    await ouvre(r, PARTANT);
    await ouvre(r, ARCHITECTE);
    await r.executeCommand('configure terminal');
    await r.executeCommand(`no username ${PARTANT.nom}`);
    await r.executeCommand('end');
    expect(await r.loginAs(PARTANT.nom, PARTANT.secret)).toBe(false);
    expect(await r.executeCommand('show running-config')).not.toContain(PARTANT.nom);
  }, 30_000);

  it('trois secrets faux verrouillent le compte, meme avec le bon ensuite', async () => {
    const r = await siege();
    for (const faux of ['f1', 'f2', 'f3']) {
      expect(await r.loginAs(NOC1.nom, faux)).toBe(false);
    }
    expect(await r.loginAs(NOC1.nom, NOC1.secret)).toBe(false);
    expect(await r.executeCommand('show aaa local user lockout')).toContain(NOC1.nom);
  }, 30_000);

  it('l\'architecte deverrouille le compte', async () => {
    const r = await siege();
    for (const faux of ['f1', 'f2', 'f3']) await r.loginAs(NOC1.nom, faux);
    await ouvre(r, ARCHITECTE);
    expect(await r.executeCommand(`clear aaa local user lockout username ${NOC1.nom}`)).toBe('');
    expect(await r.loginAs(NOC1.nom, NOC1.secret)).toBe(true);
  }, 30_000);
});

describe('ACME — le prestataire vit dans une vue COMPOSEE', () => {
  it('la superview reunit ce que ses deux vues incluent', async () => {
    const r = await siege();
    await r.executeCommand('enable', { passwordInput: 'Coffre15@Acme' });
    await r.executeCommand('enable view VUE_PRESTA_WAN', { passwordInput: 'Presta@Wan2026' });
    expect(await r.executeCommand('show ip route')).not.toContain(REFUS);
    expect(await r.executeCommand('ping 127.0.0.1')).not.toContain(REFUS);
    expect(await r.executeCommand('show running-config')).toContain(REFUS);
    expect(await r.executeCommand('configure terminal')).toContain(REFUS);
  }, 30_000);

  it('la vue attachee au compte s\'applique a la connexion', async () => {
    const r = await siege();
    expect(await r.loginAs('presta.wan', 'Presta@Wan2026')).toBe(true);
    expect(await r.executeCommand('show parser view')).toContain('VUE_PRESTA_WAN');
    expect(await r.executeCommand('show running-config')).toContain(REFUS);
  }, 30_000);
});

describe('ACME — la piste d\'audit nomme qui a tape quoi', () => {
  it('une commande de configuration est retenue avec son auteur', async () => {
    const r = await siege();
    await ouvre(r, CHANGEMENT);
    await r.executeCommand('configure terminal');
    await r.executeCommand('ip route 10.42.0.0 255.255.0.0 192.0.2.9');
    await r.executeCommand('end');
    await ouvre(r, ARCHITECTE);
    const journal = await r.executeCommand('show archive log config all');
    expect(journal).toContain('ip route 10.42.0.0');
    expect(journal).toContain(CHANGEMENT.nom);
  }, 30_000);

  it('un secret n\'entre jamais en clair dans la piste d\'audit', async () => {
    const r = await siege();
    await ouvre(r, ARCHITECTE);
    await r.executeCommand('configure terminal');
    await r.executeCommand('username temporaire privilege 1 secret TresSecret@2026');
    await r.executeCommand('end');
    expect(await r.executeCommand('show archive log config all'))
      .not.toContain('TresSecret@2026');
  }, 30_000);
});

describe('ACME — la configuration rendue REJOUE toute la delegation', () => {
  async function rejoue(source: CiscoRouter): Promise<CiscoRouter> {
    await source.loginAs(ARCHITECTE.nom, ARCHITECTE.secret);
    const cfg = await source.executeCommand('show running-config');
    const cible = new CiscoRouter('ACME-HQ-BIS', 0, 0);
    cible.powerOn();
    await cible.executeCommand('enable');
    await cible.executeCommand('configure terminal');
    for (const ligne of cfg.split('\n')) {
      const t = ligne.trim();
      if (!t || t === '!' || t.startsWith('Building') || t.startsWith('Current configuration')) continue;
      const sortie = await cible.executeCommand(t);
      // Une configuration rendue doit se rejouer SANS une seule erreur :
      // c'est ce que fait l'import d'une topologie, et une ligne refusee
      // en silence est une part de la delegation qui disparait.
      expect(sortie, `rejeu de [${t}]`).not.toMatch(/Invalid input|Incomplete command/);
    }
    await cible.executeCommand('end');
    await cible.executeCommand('disable');
    return cible;
  }

  it('les niveaux des comptes survivent', async () => {
    const bis = await rejoue(await siege());
    for (const c of TOUS) {
      expect(await bis.loginAs(c.nom, c.secret), c.nom).toBe(true);
      expect(await bis.executeCommand('show privilege'), c.nom)
        .toContain(`Current privilege level is ${c.niveau}`);
    }
  }, 60_000);

  it('les commandes deleguees survivent, dans les deux sens', async () => {
    const bis = await rejoue(await siege());
    await ouvre(bis, AUDITEUR);
    expect(await bis.executeCommand('show running-config')).toContain('Building configuration');
    expect(await bis.executeCommand('configure terminal')).toContain(REFUS);
    expect(await bis.executeCommand('write memory')).toContain(REFUS);
    await ouvre(bis, NOC1);
    expect(await bis.executeCommand('show ip interface brief')).not.toContain(REFUS);
    expect(await bis.executeCommand('clear counters')).toContain(REFUS);
  }, 60_000);

  it('les coffres par palier survivent', async () => {
    const bis = await rejoue(await siege());
    await ouvre(bis, NOC2);
    expect(await bis.executeCommand('enable 12', { passwordInput: 'mauvais' }))
      .toContain('% Bad secrets');
    await bis.executeCommand('enable 12', { passwordInput: 'Coffre12@Acme' });
    expect(await bis.executeCommand('show privilege')).toContain('Current privilege level is 12');
  }, 60_000);

  it('les vues survivent', async () => {
    const bis = await rejoue(await siege());
    expect(await bis.loginAs('presta.wan', 'Presta@Wan2026')).toBe(true);
    expect(await bis.executeCommand('show parser view')).toContain('VUE_PRESTA_WAN');
    expect(await bis.executeCommand('show running-config')).toContain(REFUS);
  }, 60_000);
});

describe('ACME — un role n\'est pas plus puissant sur le commutateur', () => {
  async function acces(): Promise<CiscoSwitch> {
    const sw = new CiscoSwitch('sw-acme', 'ACME-HQ-ACCES', 24, 0, 0);
    sw.powerOn();
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('enable secret Coffre15@Acme');
    for (const c of [ARCHITECTE, NOC2, NOC1, STAGIAIRE]) {
      await sw.executeCommand(`username ${c.nom} privilege ${c.niveau} secret ${c.secret}`);
    }
    await sw.executeCommand('privilege exec level 3 show ip interface brief');
    await sw.executeCommand('privilege exec level 7 clear counters');
    await sw.executeCommand('end');
    await sw.executeCommand('disable');
    return sw;
  }

  it('les niveaux sont les memes des deux cotes', async () => {
    const sw = await acces();
    for (const c of [ARCHITECTE, NOC2, NOC1, STAGIAIRE]) {
      expect(await sw.loginAs(c.nom, c.secret), c.nom).toBe(true);
      expect(await sw.executeCommand('show privilege'), c.nom)
        .toContain(`Current privilege level is ${c.niveau}`);
    }
  }, 30_000);

  it('la meme delegation vaut, et rien de plus', async () => {
    const sw = await acces();
    await sw.loginAs(NOC1.nom, NOC1.secret);
    expect(await sw.executeCommand('show ip interface brief')).not.toContain(REFUS);
    expect(await sw.executeCommand('clear counters')).toContain(REFUS);
    expect(await sw.executeCommand('show running-config')).toContain(REFUS);
    await sw.loginAs(NOC2.nom, NOC2.secret);
    expect(await sw.executeCommand('clear counters')).not.toContain(REFUS);
  }, 30_000);

  it('le stagiaire ne configure aucun VLAN', async () => {
    const sw = await acces();
    await sw.loginAs(STAGIAIRE.nom, STAGIAIRE.secret);
    expect(await sw.executeCommand('configure terminal')).toContain(REFUS);
    await sw.loginAs(ARCHITECTE.nom, ARCHITECTE.secret);
    expect(await sw.executeCommand('show vlan brief')).not.toContain('666');
  }, 30_000);
});

describe('ACME — la force brute ferme le reseau, pas la console', () => {
  /**
   * DEUX mecanismes se superposent ici, et les confondre coute cher le
   * jour ou l'on est enferme dehors :
   *
   * - le mode SILENCIEUX porte sur la LIGNE. Il ferme les vty et laisse
   *   la console — « the only available connection is through the
   *   console » — c'est le chemin de retour.
   * - le VERROU porte sur le COMPTE. Il vaut partout, console comprise :
   *   le compte qui vient d'echouer trois fois ne rentre plus, meme
   *   devant la machine. C'est pour cela qu'une equipe garde un second
   *   compte d'administration.
   */
  it('le mode silencieux ferme les vty, et la console reste ouverte a un AUTRE compte', async () => {
    const r = await siege();
    for (const faux of ['a1', 'a2', 'a3']) {
      expect(await r.authenticateLine('vty', { user: ARCHITECTE.nom, pass: faux })).toBe(false);
    }
    expect(r.getLoginBlocker()?.isBlocked()).toBe(true);
    expect(await r.authenticateLine('vty', { user: ARCHITECTE.nom, pass: ARCHITECTE.secret }))
      .toBe(false);

    // Le compte de l'architecte est verrouille : la console le refuse
    // aussi, et c'est le verrou qui parle, pas le mode silencieux.
    expect(await r.authenticateLine('console', { user: ARCHITECTE.nom, pass: ARCHITECTE.secret }))
      .toBe(false);
    expect(await r.executeCommand('show aaa local user lockout')).toContain(ARCHITECTE.nom);

    // Un compte intact passe par la console pendant le mode silencieux.
    expect(await r.authenticateLine('console', { user: CHANGEMENT.nom, pass: CHANGEMENT.secret }))
      .toBe(true);
    expect(await r.authenticateLine('vty', { user: CHANGEMENT.nom, pass: CHANGEMENT.secret }))
      .toBe(false);
  }, 30_000);
});
