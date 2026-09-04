/**
 * Une ligne vty RETIENT le nom de la liste de methodes qu'on lui donne.
 *
 * Sonde ecrite AVANT lecture du gestionnaire, contre la reference IOS :
 *
 *   login authentication { default | <nom> }
 *   accounting { commands <0-15> | connection | exec } { default | <nom> }
 *   authorization { commands <0-15> | exec }          { default | <nom> }
 *
 * Mesure de depart sous `line vty 0 4`, la configuration relue apres
 * chaque ligne :
 *
 *   login authentication MALISTE      -> rendu `login authentication default`
 *   login authentication              -> ACCEPTE, meme rendu
 *   login authentication zorglub      -> ACCEPTE, meme rendu
 *   accounting exec MALISTE           -> rendu `accounting exec MALISTE`
 *   accounting commands 15 MALISTE    -> rendu `accounting commands 15`
 *   accounting exec zorglub           -> ACCEPTE et RENDU tel quel
 *   accounting exec                   -> ACCEPTE, rendu NULLE PART
 *   accounting zorglub                -> ACCEPTE
 *
 * LE TEMOIN EST DANS LE MEME FICHIER, et c'est ce qui rend ce lot court
 * a expliquer : la LIGNE CONSOLE porte deja `consoleLineLoginAuthList`,
 * ajoute par un lot precedent dont le commentaire dit exactement
 * pourquoi ce nom compte — « elle garde la console sur la base LOCALE,
 * pour qu'un serveur TACACS+ en panne ne ferme pas la porte ». La moitie
 * vty du meme reglage n'a jamais ete faite : `VtyLineConfig` n'a aucun
 * champ pour ce nom, le gestionnaire reduit `login authentication X` a
 * l'etat `aaa`, et le rendu ecrit `default` EN DUR.
 *
 * LA CONSEQUENCE EST CELLE QUE LE COMMENTAIRE DE LA CONSOLE DECRIT, a
 * l'envers. Un operateur qui protege ses vty par une liste nommee —
 * `aaa authentication login VTY-AAA group tacacs+ local` puis `login
 * authentication VTY-AAA` — voit sa configuration ecrire `default`. La
 * configuration rendue etant REJOUEE a l'import d'une topologie, les
 * vty basculent au rechargement sur la liste `default`, qui est une
 * AUTRE liste, avec d'autres methodes et un autre repli. C'est un
 * changement silencieux de qui a le droit d'entrer.
 *
 * LES DEUX AUTRES FAMILLES ONT LA MEME FORME AVEC UNE CAUSE DIFFERENTE :
 * `authorizationList` et `accountingList` EXISTENT comme champs et sont
 * rendus, mais le gestionnaire y range la QUEUE DE LIGNE entiere au lieu
 * de la lire — d'ou `accounting exec zorglub` rendu tel quel (le mot de
 * trop DEVIENT le nom de la liste) et `accounting commands 15 MALISTE`
 * rendu `accounting commands 15` (le vrai nom, dernier mot, est perdu).
 * Un magasin qui accepte une chaine quelconque ne peut pas refuser, et
 * c'est pour cela que les deux defauts se tiennent.
 *
 * CE QUE CETTE SONDE NE DEMANDE DELIBEREMENT PAS : que la liste nommee
 * SOIT CONSULTEE a l'ouverture d'une session vty. Ce serait la moitie
 * suivante — relier `VtyLineConfig` a `AaaAuthenticator.methodsFor(nom)`
 * — et elle demande de mesurer d'abord ce que fait aujourd'hui
 * l'admission d'une vty sous AAA. La sonde n'observe que ce que la
 * machine ACCEPTE, RETIENT et RELIT ; le reste est inscrit au `TODO.md`.
 *
 * UNE PREMISSE DE CETTE SONDE ETAIT FAUSSE, corrigee dans la sonde et
 * non dans le code : son cas de refus tapait `accounting exec
 * zorglub-refuse` en attendant un refus. C'est une commande VALIDE — un
 * nom de liste de methodes est un mot quelconque, et le mot choisi en
 * est un. Le cas tape desormais les trois formes qui sont vraiment
 * refusees : un genre inconnu, et un niveau hors de la plage 0-15.
 *
 * Discrimine par `git stash` sur les deux fichiers cables : 18 des 40
 * cas tombent avant correctif. Les 22 autres sont nommes ici :
 *
 *   - le TEMOIN de la console, dont c'est l'objet de passer des deux
 *     cotes ;
 *   - `login authentication default`, qui passait parce que le rendu
 *     ecrivait `default` EN DUR — il n'observait donc pas le nom mais
 *     la constante, et c'est la coincidence qui rendait le defaut
 *     invisible aux operateurs qui emploient la liste par defaut ;
 *   - la vty neuve, qui ne rendait rien avant comme apres ;
 *   - les six formes A UN SEUL MOT (`accounting exec MALISTE`,
 *     `accounting connection MALISTE`, `authorization exec MALISTE`, et
 *     les trois memes en `default`) : l'ancien magasin rangeait
 *     `args[0] args[1]`, donc ces formes-la faisaient exactement DEUX
 *     mots et retombaient juste par accident ; c'est `commands <n>
 *     <nom>`, qui en fait trois, qui perdait le nom ;
 *   - « un refus ne laisse rien dans la configuration », qui passait
 *     pour la RAISON INVERSE de celle qu'on lui demande : l'ancien
 *     gestionnaire exigeait `args[0] && args[1]`, donc `accounting
 *     zorglub` tombait hors de la branche et n'etait range nulle part,
 *     et `accounting commands 16 MALISTE` etait range en perdant
 *     `MALISTE` — l'absence observee etait celle du nom perdu, pas
 *     celle d'un refus ;
 *   - les douze cas de non-regression, sans lesquels un correctif qui
 *     refuserait toute la famille satisferait la sonde.
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

type Dev = { executeCommand(c: string): Promise<string> };

const routeur = (n: string) => new CiscoRouter(n) as unknown as Dev;

const LIGNE = 'line vty 0 4';

async function conf(d: Dev, ...cmds: string[]): Promise<string> {
  let last = '';
  for (const c of ['enable', 'configure terminal', 'aaa new-model', LIGNE, ...cmds]) {
    last = String(await d.executeCommand(c));
  }
  return last;
}

async function blocVty(d: Dev): Promise<string> {
  await d.executeCommand('end');
  const cfg = String(await d.executeCommand('show running-config'));
  await d.executeCommand('configure terminal');
  await d.executeCommand(LIGNE);
  const apres = cfg.split(LIGNE)[1] ?? '';
  return apres.split(/^\S/m)[0] ?? '';
}

const cle = (s: string) => s.replace(/\W/g, '');

describe('le TEMOIN : la ligne CONSOLE retient deja le nom', () => {
  it('`login authentication MALISTE` sur la console est rendu avec son nom', async () => {
    const d = routeur('T1');
    for (const c of ['enable', 'configure terminal', 'aaa new-model',
      'line console 0', 'login authentication MALISTE', 'end']) {
      await d.executeCommand(c);
    }
    expect(String(await d.executeCommand('show running-config')))
      .toContain('login authentication MALISTE');
  });
});

describe('une vty retient le nom de sa liste d authentification', () => {
  it.each(['MALISTE', 'default', 'VTY-AAA'])(
    '`login authentication %s` est rendu tel quel', async (nom) => {
      const d = routeur(`A${cle(nom)}`);
      await conf(d, `login authentication ${nom}`);
      expect(await blocVty(d)).toContain(`login authentication ${nom}`);
    });

  it('`login authentication` sans nom dit INCOMPLET', async () => {
    const d = routeur('AN');
    expect(await conf(d, 'login authentication')).toContain('% Incomplete command.');
  });

  it('et une vty neuve ne rend aucune ligne d authentification', async () => {
    const d = routeur('AV');
    await conf(d);
    expect(await blocVty(d)).not.toContain('login authentication');
  });

  it('poser une seconde liste remplace la premiere', async () => {
    const d = routeur('AR');
    await conf(d, 'login authentication PREMIERE', 'login authentication SECONDE');
    const bloc = await blocVty(d);
    expect(bloc).toContain('login authentication SECONDE');
    expect(bloc).not.toContain('PREMIERE');
  });
});

describe('les listes de comptabilite et d autorisation gardent leur nom', () => {
  const FORMES: ReadonlyArray<readonly [string, string]> = [
    ['accounting exec', 'MALISTE'],
    ['accounting connection', 'MALISTE'],
    ['accounting commands 15', 'MALISTE'],
    ['authorization exec', 'MALISTE'],
    ['authorization commands 15', 'MALISTE'],
  ];

  it.each(FORMES)('`%s %s` est rendu tel quel', async (forme, nom) => {
    const d = routeur(`B${cle(forme)}`);
    expect(await conf(d, `${forme} ${nom}`)).not.toContain('%');
    expect(await blocVty(d)).toContain(`${forme} ${nom}`);
  });

  it.each(FORMES)('`%s default` reste accepte et rendu', async (forme) => {
    const d = routeur(`C${cle(forme)}`);
    expect(await conf(d, `${forme} default`)).not.toContain('%');
    expect(await blocVty(d)).toContain(`${forme} default`);
  });
});

describe('ce que ces commandes ne lisent pas est refuse', () => {
  it.each(['accounting zorglub', 'authorization zorglub',
    'accounting exec', 'authorization exec',
    'accounting commands zorglub', 'authorization commands zorglub',
    'accounting commands 16 MALISTE', 'accounting commands 15',
    'accounting exec MALISTE zorglub'])(
    '`%s` est refuse', async (ligne) => {
      const d = routeur(`D${cle(ligne)}`);
      expect(await conf(d, ligne)).toMatch(/% (Invalid input|Incomplete command)/);
    });

  it('et un refus ne laisse rien dans la configuration', async () => {
    const d = routeur('DR');
    await conf(d, 'accounting zorglub', 'authorization zorglub',
      'accounting commands 16 MALISTE');
    const bloc = await blocVty(d);
    expect(bloc).not.toContain('zorglub');
    expect(bloc).not.toContain('MALISTE');
  });
});

describe('non-regression — le reste de la ligne vty', () => {
  it.each(['login', 'login local', 'no login'])(
    '`%s` reste accepte', async (ligne) => {
      const d = routeur(`E${cle(ligne)}`);
      expect(await conf(d, ligne)).not.toContain('% Invalid');
    });

  it.each([['login local', 'login local'], ['login', 'login']])(
    '`%s` reste rendu `%s`', async (ligne, attendu) => {
      const d = routeur(`F${cle(ligne)}`);
      await conf(d, ligne);
      expect(await blocVty(d)).toContain(attendu);
    });

  it.each(['exec-timeout 5 0', 'password s3cr3t', 'transport input ssh',
    'privilege level 15', 'logging synchronous', 'session-timeout 10',
    'access-class 10 in'])(
    '`%s` reste accepte', async (ligne) => {
      const d = routeur(`G${cle(ligne)}`);
      expect(await conf(d, ligne)).not.toContain('% Invalid');
    });

  it('une ligne vty complete se relit entierement', async () => {
    const d = routeur('GC');
    await conf(d, 'exec-timeout 5 0', 'login authentication VTY-AAA',
      'authorization exec VTY-EXEC', 'accounting exec VTY-ACCT',
      'transport input ssh');
    const bloc = await blocVty(d);
    for (const attendu of ['exec-timeout 5 0', 'login authentication VTY-AAA',
      'authorization exec VTY-EXEC', 'accounting exec VTY-ACCT']) {
      expect(bloc, attendu).toContain(attendu);
    }
  });
});
