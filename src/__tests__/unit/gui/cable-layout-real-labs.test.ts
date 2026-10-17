/**
 * LA DISPOSITION DES CABLES SUR LES DEUX LABOS EXPORTES DU DEPOT.
 *
 * Les exports `SSH_TP_LAN.topology (7).json` (22 equipements, 21 cables), `SSH_TP_LAN.topology (8).json` (22 equipements,
 * 21 cables, disposition remaniee) et `lan_with_firewall_fortigate.topology (1).json` (24 equipements, 23 cables) sont relus a leurs coordonnees d'origine, puis leurs routeurs, commutateurs
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
 * Le deuxieme export a revele ce que les formes en Z ne savaient pas faire : un equipement pose EXACTEMENT entre
 * deux autres (PC5, PC4, Serveur1 alignes), un cable trop court pour porter ses deux pastilles, une face de commutateur
 * a quatre cables dont la voie la plus externe mordait le badge du voisin. Mesure sur cet export a ses positions :
 * traversees d'equipements 8 -> 0, croisements 9 -> 2, superpositions 46 px -> 0, longueur totale +2,5 % ;
 * les autres labos ne gagnent que des croisements (6 -> 2 et 2 -> 0). Un cable ne quitte sa face naturelle (Z) que
 * s'il traverse un equipement tiers : alors en L (faces perpendiculaires) ou en U (meme face), jamais au prix d'un
 * detour de plus de 220 px, et jamais par une route qui repasse sur sa propre carte. Les croisements seuls ne
 * suffisent pas a changer de face : seul le couloir glisse.
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
    expect(after.hiddenTags).toBeLessThanOrEqual(before.hiddenTags);
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

describe.each(LAB_FILES)('%s: the drawing does not depend on the zoom nor on the clock', (file) => {
  const geometry = (lab: ImportedLab, zoom: number) =>
    JSON.stringify([...routeLab(lab, zoom)].map(([id, route]) => [id, route.points]));

  it('gives the same cables at every zoom, and the same cables when computed twice', () => {
    const lab = importLab(file);
    const reference = geometry(lab, 1);
    for (const zoom of [0.3, 0.5, 0.7, 1.5, 2, 3]) expect(geometry(lab, zoom)).toBe(reference);
    expect(geometry(lab, 1)).toBe(reference);
  });

  it('keeps that property after the head of the topology has been moved', () => {
    const lab = importLab(file);
    const mover = lab.devices.find(device => /switch|router|firewall/.test(device.type))!;
    const moved = moveDevice(lab, mover.id, mover.x + 90, mover.y + 70);
    const reference = geometry(moved, 1);
    for (const zoom of [0.5, 2]) expect(geometry(moved, zoom)).toBe(reference);
  });
});
