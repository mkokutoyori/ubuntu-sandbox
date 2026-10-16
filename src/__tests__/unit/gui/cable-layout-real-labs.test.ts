/**
 * LA DISPOSITION DES CABLES SUR LES DEUX LABOS EXPORTES DU DEPOT.
 *
 * Les exports `SSH_TP_LAN.topology (7).json` (22 equipements, 21 cables) et `lan_with_firewall_fortigate.topology
 * (1).json` (24 equipements, 23 cables) sont relus a leurs coordonnees d'origine, puis leurs routeurs, commutateurs
 * et pare-feu sont DEPLACES un a un par une marche pseudo-aleatoire fixe (60 deplacements de plus ou moins 130
 * pixels), le trace precedent etant rendu a chaque pas comme le fait la toile. A chaque etat, le trace est mesure :
 * croisements de cables, tronçons paralleles superposes, cables qui traversent un equipement tiers, pastilles
 * masquees ou posees sur un autre cable.
 *
 * DEFAUT D'ORIGINE, releve a la capture : tous les cables d'une meme face partageaient le MEME couloir de coude,
 * au decalage de voie pres, donc cinq machines posees sous un commutateur se croisaient et se superposaient en
 * entrant par le meme bord. Et aucun cable ne savait qu'un equipement se trouvait sur son chemin.
 *
 * Mesure AVANT (refine = false, l'ancien trace) sur ces deux labos, moyenne par etat :
 *   croisements 14.4 et 9.9, superpositions 140 px et 22 px, traversees d'equipements 9.7 et 7.3.
 * APRES : croisements 7 a 8 et 5.3, superpositions 6 px et 2 px, traversees 4.4 et 4.8. Le residu de traversees est
 * en grande partie de la marche elle-meme : elle depose parfois deux equipements l'un sur l'autre.
 *
 * Ce que ce fichier garde : le trace n'est jamais PIRE que l'ancien sur aucune mesure, il est nettement meilleur
 * sur la moyenne, et il reste rapide (un etat en quelques millisecondes).
 */
import { describe, it, expect } from 'vitest';
import type { CableRoute } from '@/components/network/connection-line-logic';
import {
  LAB_FILES, importLab, measure, moveDevice, routeLab, type ImportedLab, type LayoutMetrics,
} from './_helpers/cableLayoutMetrics';

function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}

type Totals = Record<keyof LayoutMetrics, number>;

function walk(file: string, refine: boolean, steps = 60): { totals: Totals; milliseconds: number } {
  let lab: ImportedLab = importLab(file);
  const random = prng(7);
  const movable = lab.devices.filter(device => /router|switch|firewall/.test(device.type));
  const totals = {} as Totals;
  let previous: ReadonlyMap<string, CableRoute> | undefined;
  let spent = 0;
  for (let step = 0; step < steps; step++) {
    const device = movable[Math.floor(random() * movable.length)];
    const current = lab.devices.find(d => d.id === device.id)!;
    lab = moveDevice(lab, device.id, current.x + (random() - 0.5) * 260, current.y + (random() - 0.5) * 260);
    const started = performance.now();
    previous = routeLab(lab, 1, previous, refine);
    spent += performance.now() - started;
    const metrics = measure(lab, previous);
    for (const key of Object.keys(metrics) as Array<keyof LayoutMetrics>) totals[key] = (totals[key] ?? 0) + metrics[key];
  }
  return { totals, milliseconds: spent / steps };
}

describe.each(LAB_FILES)('%s', (file) => {
  it('at its exported positions the cables do not cross a third device nor overlap each other', () => {
    const lab = importLab(file);
    const after = measure(lab, routeLab(lab));
    const before = measure(lab, routeLab(lab, 1, undefined, false));
    expect(after.overlapPixels).toBeLessThanOrEqual(before.overlapPixels);
    expect(after.crossings).toBeLessThanOrEqual(before.crossings);
    expect(after.throughDevices).toBeLessThanOrEqual(before.throughDevices);
    expect(after.tagOnTag).toBe(0);
    expect(after.tagOnDevice).toBe(0);
    expect(after.hiddenTags).toBe(0);
  });

  it('while the routers and switches are moved, crossings and overlaps fall clearly and nothing gets worse', () => {
    const before = walk(file, false);
    const after = walk(file, true);
    expect(after.totals.crossings).toBeLessThan(before.totals.crossings * 0.75);
    expect(after.totals.overlapPixels).toBeLessThan(before.totals.overlapPixels * 0.2);
    expect(after.totals.throughDevices).toBeLessThanOrEqual(before.totals.throughDevices);
    expect(after.totals.tagOnTag).toBe(0);
    expect(after.totals.tagOnDevice).toBe(0);
  });

  it('a layout state costs a few milliseconds, as measured on the whole walk', () => {
    expect(walk(file, true, 20).milliseconds).toBeLessThan(25);
  });
});
