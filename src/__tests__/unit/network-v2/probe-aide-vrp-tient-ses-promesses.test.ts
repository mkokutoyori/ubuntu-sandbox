/**
 * Les trois garde-fous de l'aide, portes a VRP.
 *
 * La campagne de `docs/AUDIT-Completion-Aide-CLI.md` a ferme dix-neuf
 * constats du cote Cisco et laisse trois balayages derriere elle. Ils ne
 * sont pas propres a IOS : ils enoncent trois proprietes qu'une aide
 * doit avoir sur n'importe quelle plateforme.
 *
 *   1. Un mot que `?` propose n'est pas INCONNU de l'analyseur.
 *   2. Un `<cr>` annonce se valide vraiment.
 *   3. Un mot offert porte une description.
 *
 * VRP dit les deux refus autrement qu'IOS, et la distinction est la
 * meme — c'est elle qui rend le premier balayage utile :
 *
 *   Error: Incomplete command found at '^' position.
 *       -> le mot-cle est bon, il en manque d'autres. L'aide avait raison.
 *   Error: Unrecognized command found at '^' position.
 *       -> ce mot-la n'existe pas ici. L'aide a menti.
 *
 * Une machine neuve par essai : la commande essayee peut modifier la
 * configuration, et un balayage qui s'observe lui-meme ne mesure plus
 * rien.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
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

type Dev = { cliHelp(s: string): string; executeCommand(c: string): Promise<string> };

const INCONNU = 'Unrecognized command';
const INCOMPLET = 'Incomplete command';

const MOT = /^\s\s(\S+)/;
const lignes = (t: string): string[] =>
  t.includes(INCONNU) ? [] : t.split('\n').filter((l) => MOT.test(l));
const offerts = (t: string): string[] =>
  lignes(t).map((l) => MOT.exec(l)![1]).filter((k) => k !== '<cr>');
const annonceCr = (t: string): boolean =>
  t.split('\n').some((l) => /^\s\s<cr>\s*$/.test(l));

/** Un substitut d'argument n'est pas un mot-cle : l'essayer ne mesure rien. */
const estSubstitut = (k: string): boolean =>
  k.startsWith('<') || /^[A-Z0-9.:$/<>-]+$/.test(k);

let serie = 0;
async function routeur(prelude: readonly string[]): Promise<Dev> {
  const r = new HuaweiRouter(`V${serie++}`) as unknown as Dev & { powerOn?(): void };
  r.powerOn?.();
  for (const c of prelude) await r.executeCommand(c);
  return r;
}

async function commutateur(prelude: readonly string[]): Promise<Dev> {
  const s = new HuaweiSwitch('huawei-switch', `W${serie++}`) as unknown as Dev
    & { powerOn?(): void };
  s.powerOn?.();
  for (const c of prelude) await s.executeCommand(c);
  return s;
}

type Fabrique = (prelude: readonly string[]) => Promise<Dev>;

async function promessesNonTenues(
  fab: Fabrique, prelude: readonly string[], racine: string, profondeur = 3,
): Promise<string[]> {
  const guide = await fab(prelude);
  const fautes: string[] = [];
  const vus = new Set<string>();
  let file = [racine];
  for (let p = 0; p < profondeur; p++) {
    const suivant: string[] = [];
    for (const base of file) {
      for (const k of offerts(guide.cliHelp(base === '' ? '' : `${base} `))) {
        if (estSubstitut(k)) continue;
        const chemin = base === '' ? k : `${base} ${k}`;
        if (vus.has(chemin)) continue;
        vus.add(chemin);
        if (suivant.length < 200) suivant.push(chemin);
        const essai = await fab(prelude);
        if (String(await essai.executeCommand(chemin)).includes(INCONNU)) {
          fautes.push(`«${base === '' ? '' : base + ' '}?» offre «${k}»`);
        }
      }
    }
    file = suivant;
  }
  return fautes;
}

async function crMensongers(
  fab: Fabrique, prelude: readonly string[], racine: string,
): Promise<string[]> {
  const guide = await fab(prelude);
  const fautes: string[] = [];
  const vus = new Set<string>();
  let file = [racine];
  for (let p = 0; p < 3; p++) {
    const suivant: string[] = [];
    for (const base of file) {
      const aide = guide.cliHelp(base === '' ? '' : `${base} `);
      if (base !== '' && annonceCr(aide)) {
        const essai = await fab(prelude);
        if (String(await essai.executeCommand(base)).includes(INCOMPLET)) {
          fautes.push(`«${base} ?» annonce <cr>`);
        }
      }
      for (const k of offerts(aide)) {
        if (estSubstitut(k)) continue;
        const chemin = base === '' ? k : `${base} ${k}`;
        if (vus.has(chemin)) continue;
        vus.add(chemin);
        if (suivant.length < 200) suivant.push(chemin);
      }
    }
    file = suivant;
  }
  return fautes;
}

async function sansDescription(
  fab: Fabrique, prelude: readonly string[], racine: string,
): Promise<string[]> {
  const guide = await fab(prelude);
  const fautes: string[] = [];
  const vus = new Set<string>();
  let file = [racine];
  for (let p = 0; p < 3; p++) {
    const suivant: string[] = [];
    for (const base of file) {
      const aide = guide.cliHelp(base === '' ? '' : `${base} `);
      for (const ligne of lignes(aide)) {
        const mot = MOT.exec(ligne)![1];
        if (mot === '<cr>') continue;
        // Une description est ce qui suit le mot apres au moins deux
        // blancs. Rien derriere le mot veut dire : aucune.
        if (!/^\s\s\S+\s\s+\S/.test(ligne)) {
          fautes.push(`«${base === '' ? '' : base + ' '}?» offre «${mot}» sans description`);
        }
        if (estSubstitut(mot)) continue;
        const chemin = base === '' ? mot : `${base} ${mot}`;
        if (vus.has(chemin)) continue;
        vus.add(chemin);
        if (suivant.length < 200) suivant.push(chemin);
      }
    }
    file = suivant;
  }
  return fautes;
}

/**
 * Le CLIQUET.
 *
 * Les listes sont NOMMEES plutot que tues, et l'egalite est exacte :
 * aucune faute nouvelle ne peut apparaitre sans faire echouer ce
 * fichier, et en corriger une oblige a la retirer d'ici. La liste ne
 * peut que decroitre.
 */
const RESTE_CONNU = {
  promessesUtilisateur: [] as readonly string[],
  promessesSysteme: [] as readonly string[],
  crUtilisateur: [] as readonly string[],
  crSysteme: [] as readonly string[],
  descriptionsUtilisateur: [] as readonly string[],
  descriptionsSysteme: [] as readonly string[],
};

describe('VRP — ce que `?` propose, la machine le connait', () => {
  it('en vue utilisateur, branche `display`', async () => {
    const f = await promessesNonTenues(routeur, [], 'display');
    expect(f.sort(), f.join('\n')).toEqual([...RESTE_CONNU.promessesUtilisateur].sort());
  }, 420_000);

  it('en vue systeme', async () => {
    const f = await promessesNonTenues(routeur, ['system-view'], '');
    expect(f.sort(), f.join('\n')).toEqual([...RESTE_CONNU.promessesSysteme].sort());
  }, 420_000);
});

describe('VRP — un `<cr>` annonce se valide vraiment', () => {
  it('en vue utilisateur', async () => {
    const f = await crMensongers(routeur, [], 'display');
    expect(f.sort(), f.join('\n')).toEqual([...RESTE_CONNU.crUtilisateur].sort());
  }, 300_000);

  it('en vue systeme', async () => {
    const f = await crMensongers(routeur, ['system-view'], '');
    expect(f.sort(), f.join('\n')).toEqual([...RESTE_CONNU.crSysteme].sort());
  }, 300_000);
});

describe('VRP — un mot offert porte une description', () => {
  it('en vue utilisateur', async () => {
    const f = await sansDescription(routeur, [], '');
    expect(f.sort(), f.join('\n')).toEqual([...RESTE_CONNU.descriptionsUtilisateur].sort());
  }, 300_000);

  it('en vue systeme', async () => {
    const f = await sansDescription(routeur, ['system-view'], '');
    expect(f.sort(), f.join('\n')).toEqual([...RESTE_CONNU.descriptionsSysteme].sort());
  }, 300_000);
});

describe('le commutateur VRP repond des trois memes facons', () => {
  it('promesses tenues en vue systeme', async () => {
    const f = await promessesNonTenues(commutateur, ['system-view'], '');
    expect(f.sort(), f.join('\n')).toEqual([]);
  }, 420_000);

  it('descriptions en vue systeme', async () => {
    const f = await sansDescription(commutateur, ['system-view'], '');
    expect(f.sort(), f.join('\n')).toEqual([]);
  }, 300_000);

  it('et ses `<cr>` se valident aussi', async () => {
    const f = await crMensongers(commutateur, ['system-view'], '');
    expect(f.sort(), f.join('\n')).toEqual([]);
  }, 300_000);
});

describe('les cas nommes', () => {
  it('`acl ?` n annonce plus `<cr>` — il attend son nom ou son numero', async () => {
    const r = await routeur(['system-view']);
    expect(annonceCr(r.cliHelp('acl '))).toBe(false);
    expect(String(await r.executeCommand('acl'))).toContain(INCOMPLET);
  });

  it('mais `acl 2000` s execute, et c est ce qui distingue les deux', async () => {
    const r = await routeur(['system-view']);
    expect(String(await r.executeCommand('acl 2000'))).not.toContain('Error');
  });

  it('`display logbuffer level 5` est accepte — VRP numerote ses severites', async () => {
    const r = await routeur([]);
    expect(String(await r.executeCommand('display logbuffer level 5')))
      .not.toContain('Error');
  });

  it('et `display logbuffer level` les reclame au lieu de les nier', async () => {
    const r = await routeur([]);
    const out = String(await r.executeCommand('display logbuffer level'));
    expect(out).toContain(INCOMPLET);
    expect(out).not.toContain(INCONNU);
  });

  it('`multicast` reclame sa sous-commande, et l aide la nomme', async () => {
    const r = await routeur(['system-view']);
    expect(offerts(r.cliHelp('multicast '))).toContain('routing-enable');
    expect(String(await r.executeCommand('multicast'))).toContain(INCOMPLET);
  });

  it('un mot qui n existe vraiment pas reste NIE', async () => {
    const r = await routeur(['system-view']);
    expect(String(await r.executeCommand('multicast zzzz'))).toContain(INCONNU);
    expect(String(await r.executeCommand('zzzz'))).toContain(INCONNU);
  });
});
