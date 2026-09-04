/**
 * Les petites tetes GLOBALES sans sous-mode passent au socle.
 *
 * Sonde ecrite contre la reference IOS, avant lecture des gestionnaires :
 *
 *   security passwords min-length <0-16>
 *   priority-list <1-16> …
 *   queue-list <1-16> …
 *   clock calendar-valid
 *
 * POURQUOI CETTE FAMILLE. Ce sont quatre tetes que les DEUX coquilles
 * Cisco enregistrent — donc huit chemins de trie — et dont aucune
 * n'ouvre de sous-mode : elles se declarent d'un bloc. Trois portent une
 * PLAGE, c'est-a-dire ce qu'un noeud glouton ne juge pas.
 *
 * `alias`, migre dans le meme lot, n'est PAS ici : il a deja sa sonde
 * (`probe-socle-alias.test.ts`), ecrite pour lui, et les trois defauts
 * que la migration lui a trouves y sont ajoutes plutot que redits — deux
 * sondes a tenir d'accord sur un meme fait sont le defaut que ce
 * chantier referme.
 *
 * CE QUE CETTE SONDE DEMANDE : qu'une longueur hors de `<0-16>` soit
 * refusee, qu'un numero de liste hors de `<1-16>` le soit aussi, que
 * `clock calendar-valid` — qui ne prend rien — refuse le mot de trop,
 * que `?` annonce ce que chaque place accepte, que ce qui est pose se
 * RELISE dans la configuration (elle est rejouee a l'import d'une
 * topologie), et que les deux plateformes repondent la meme chose.
 *
 * CE QU'ELLE NE DEMANDE DELIBEREMENT PAS : que `priority-list` et
 * `queue-list` fassent la moindre file. Leurs gestionnaires rangent la
 * ligne sans l'evaluer — ce simulateur n'a pas de file d'attente
 * heritee — et ce lot ne change pas cela ; ce qu'il ferme de leur cote
 * est seulement leur negation.
 *
 * CE QUE LA MESURE A TROUVE — un defaut : `no clock calendar-valid`
 * etait REFUSE, alors que sa forme positive etait rangee et rendue. Le
 * reglage revenait donc au rechargement d'une topologie ou l'operateur
 * venait de l'oter.
 *
 * Discrimine en rejouant la sonde dans un arbre de travail pose sur
 * l'etat d'AVANT (`git worktree add … HEAD`) plutot qu'en remisant : le
 * remisage modifie l'arbre courant, donc il ne peut pas cohabiter avec
 * une autre tache qui y ecrit, et ce chantier en a fait la mesure a ses
 * depens. 3 des 52 cas tombent avant migration — le refus de `no clock
 * calendar-valid` sur chaque plateforme, et son retrait de la
 * configuration. Les 49 autres passent des deux cotes et le DOIVENT : ce
 * sont les formes que le trie servait deja et les refus de plage, qu'il
 * appliquait par un controle ecrit a la main dans ses gestionnaires
 * (`exigerNumeroDeListe`). Sans eux, une migration qui perdrait une
 * forme ou cesserait de borner satisferait la sonde.
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

type Dev = {
  executeCommand(c: string): Promise<string>;
  cliHelp(s: string): string;
};

async function enConfig(d: Dev): Promise<Dev> {
  for (const c of ['enable', 'configure terminal']) await d.executeCommand(c);
  return d;
}

const routeur = (n: string) =>
  enConfig(new CiscoRouter(n) as unknown as Dev);
const commutateur = (n: string) =>
  enConfig(new CiscoSwitch('switch-cisco', n) as unknown as Dev);

async function config(d: Dev): Promise<string> {
  await d.executeCommand('end');
  const cfg = String(await d.executeCommand('show running-config'));
  await d.executeCommand('configure terminal');
  return cfg;
}

const cle = (s: string) => s.replace(/\W/g, '');

function estAcceptee(out: string): void {
  expect(out, out).not.toContain('% Invalid');
  expect(out, out).not.toContain('% Incomplete');
}

const ATTESTEES: readonly string[] = [
  'security passwords min-length 6',
  'security passwords min-length 0',
  'security passwords min-length 16',
  'priority-list 1 protocol ip high',
  'priority-list 16 default normal',
  'queue-list 1 protocol ip 1',
  'queue-list 16 default 2',
  'clock calendar-valid',
  'no clock calendar-valid',
];

const REFUSEES: readonly string[] = [
  'security passwords min-length 17',
  'security passwords min-length zorglub',
  'priority-list 0 protocol ip high',
  'priority-list 17 protocol ip high',
  'priority-list zorglub protocol ip high',
  'queue-list 0 protocol ip 1',
  'queue-list 17 protocol ip 1',
  'clock calendar-valid zorglub',
];

describe('les formes attestees restent acceptees', () => {
  it.each(ATTESTEES)('`%s` sur un routeur', async (ligne) => {
    const d = await routeur(`A${cle(ligne)}`);
    estAcceptee(String(await d.executeCommand(ligne)));
  });

  it.each(ATTESTEES)('`%s` sur un commutateur', async (ligne) => {
    const d = await commutateur(`B${cle(ligne)}`);
    estAcceptee(String(await d.executeCommand(ligne)));
  });
});

describe('ce que ces commandes ne lisent pas est refuse', () => {
  it.each(REFUSEES)('`%s` est refuse', async (ligne) => {
    const d = await routeur(`C${cle(ligne)}`);
    expect(String(await d.executeCommand(ligne))).toContain('% Invalid');
  });

  it('`security passwords min-length` sans valeur est INCOMPLETE', async () => {
    const d = await routeur('C2');
    const out = String(await d.executeCommand('security passwords min-length'));
    expect(out, out).toContain('% Incomplete');
  });
});

describe('`?` annonce ce que chaque place accepte', () => {
  it('`security passwords min-length ?` annonce `<0-16>`', async () => {
    const d = await routeur('E2');
    expect(d.cliHelp('security passwords min-length ')).toContain('<0-16>');
  });

  it.each(['priority-list ', 'queue-list '])(
    '`%s?` annonce `<1-16>`', async (ligne) => {
      const d = await routeur(`E${cle(ligne)}`);
      expect(d.cliHelp(ligne)).toContain('<1-16>');
    });
});

describe('ce qui est POSE se relit', () => {
  it('la longueur minimale revient', async () => {
    const d = await routeur('F3');
    await d.executeCommand('security passwords min-length 8');
    expect(await config(d)).toContain('security passwords min-length 8');
  });

  it('et une longueur REFUSEE ne laisse rien', async () => {
    const d = await routeur('F4');
    await d.executeCommand('security passwords min-length 17');
    expect(await config(d)).not.toContain('security passwords min-length 17');
  });

  it('`clock calendar-valid` revient', async () => {
    const d = await routeur('F5');
    await d.executeCommand('clock calendar-valid');
    expect(await config(d)).toContain('clock calendar-valid');
  });

  it('et `no clock calendar-valid` le retire', async () => {
    const d = await routeur('F6');
    await d.executeCommand('clock calendar-valid');
    await d.executeCommand('no clock calendar-valid');
    expect(await config(d)).not.toContain('clock calendar-valid');
  });

  it('une liste heritee revient telle qu elle a ete ecrite', async () => {
    const d = await routeur('F7');
    await d.executeCommand('priority-list 1 protocol ip high');
    expect(await config(d)).toContain('priority-list 1 protocol ip high');
  });
});

describe('les DEUX plateformes repondent pareil', () => {
  it.each([...ATTESTEES, ...REFUSEES])('`%s`', async (ligne) => {
    const r = await routeur(`G${cle(ligne)}`);
    const s = await commutateur(`H${cle(ligne)}`);
    const surRouteur = String(await r.executeCommand(ligne)).trim();
    const surCommutateur = String(await s.executeCommand(ligne)).trim();
    expect(surCommutateur, `routeur=${JSON.stringify(surRouteur)}`)
      .toBe(surRouteur);
  });
});
