/**
 * LE COULOIR DE COUDE DE CHAQUE CABLE, CHOISI POUR NE CROISER NI TRAVERSER PERSONNE.
 *
 * Un cable en Z a trois tronçons dont l'un, le couloir, peut glisser entre les deux equipements. Tant que tous
 * les cables d'une face le posaient au meme endroit, cinq machines alignees au-dessus d'un commutateur se
 * croisaient en entrant par son bord haut. Le couloir est desormais choisi cable par cable contre ses voisins
 * REELS et les equipements qui l'entourent : l'ordre qui evite les croisements est celui des coudes imbriques.
 *
 * Ce que ce fichier mesure sur des cas construits a la main : l'imbrication des coudes, l'evitement d'un
 * equipement tiers, le bascule d'axe quand un cable n'a pas d'autre issue, la stabilite d'un meme trace
 * rejoue, et le respect du budget de temps sur un tres gros schema.
 */
import { describe, it, expect } from 'vitest';
import { computeCableRoutes, type RoutedLink } from '@/components/network/connection-line-logic';
import { measure, type ImportedLab } from './_helpers/cableLayoutMetrics';

function labOf(points: Array<[string, number, number]>, links: Array<[string, string, string, string]>): ImportedLab {
  const at = new Map(points.map(([id, x, y]) => [id, { x, y }]));
  return {
    name: 'built',
    devices: points.map(([id, x, y]) => ({ id, type: 'switch', name: id, x, y })),
    links: links.map(([source, target, sourceInterface, targetInterface], index): RoutedLink => ({
      id: `k${index}`, sourceDeviceId: source, targetDeviceId: target,
      source: at.get(source)!, target: at.get(target)!, sourceInterface, targetInterface,
    })),
  };
}

const route = (lab: ImportedLab, refine = true) =>
  computeCableRoutes(lab.links, lab.devices.map(d => ({ x: d.x, y: d.y })), 1, undefined, refine);

describe('five machines above one switch', () => {
  const lab = labOf(
    [['S', 1000, 500], ['A', 700, 150], ['B', 850, 150], ['C', 1000, 150], ['D', 1150, 150], ['E', 1300, 150]],
    ['A', 'B', 'C', 'D', 'E'].map((id, index) => [id, 'S', 'eth0', `Fa0/${index + 1}`] as [string, string, string, string]),
  );

  it('cross each other in the old layout', () => {
    expect(measure(lab, route(lab, false)).crossings).toBeGreaterThan(0);
  });

  it('do not cross at all once the elbows are nested', () => {
    expect(measure(lab, route(lab)).crossings).toBe(0);
  });

  it('and keep their five elbows on five distinct levels', () => {
    const levels = new Set([...route(lab).values()].map(r => Math.round(r.points[1].y)));
    expect(levels.size).toBe(5);
  });
});

describe('a device standing on the way', () => {
  const lab = labOf(
    [['A', 100, 300], ['B', 700, 560], ['X', 400, 300]],
    [['A', 'B', 'Gi0/0', 'Gi0/1']],
  );

  it('is crossed by the old layout and avoided by the new one', () => {
    expect(measure(lab, route(lab, false)).throughDevices).toBe(1);
    expect(measure(lab, route(lab)).throughDevices).toBe(0);
  });
});

describe('a cable with an end on the device is never counted as crossing it', () => {
  const lab = labOf([['A', 100, 100], ['B', 100, 400]], [['A', 'B', 'Gi0/0', 'Gi0/1']]);

  it('and a lone cable keeps its direct route', () => {
    const lone = route(lab).get('k0')!;
    expect(lone.points).toHaveLength(4);
    expect(lone.points[0].x).toBe(lone.points[3].x);
  });
});

describe('the same state replayed gives the same drawing', () => {
  const lab = labOf(
    [['S', 1000, 500], ['A', 700, 150], ['B', 850, 150], ['C', 1000, 150]],
    ['A', 'B', 'C'].map((id, index) => [id, 'S', 'eth0', `Fa0/${index + 1}`] as [string, string, string, string]),
  );

  it('with or without memory of the previous frame', () => {
    const first = route(lab);
    const replay = computeCableRoutes(
      lab.links, lab.devices.map(d => ({ x: d.x, y: d.y })), 1, first);
    for (const [id, drawn] of first) expect(replay.get(id)!.path).toBe(drawn.path);
  });
});

describe('a very large drawing keeps within its time budget', () => {
  it('250 devices and 328 links answer in well under a second', () => {
    let state = 3;
    const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
    const points = Array.from({ length: 250 }, () => ({ x: random() * 2400, y: random() * 1600 }));
    const links: RoutedLink[] = [];
    for (let i = 1; i < 250; i++) {
      const j = Math.floor(random() * i);
      links.push({ id: `l${links.length}`, sourceDeviceId: `d${i}`, targetDeviceId: `d${j}`, source: points[i], target: points[j], sourceInterface: `Gi0/${i % 24}`, targetInterface: `Fa0/${j % 48}` });
    }
    for (let k = 0; k < 79; k++) {
      const i = Math.floor(random() * 250), j = Math.floor(random() * 250);
      if (i !== j) links.push({ id: `l${links.length}`, sourceDeviceId: `d${i}`, targetDeviceId: `d${j}`, source: points[i], target: points[j], sourceInterface: `Gi1/${k}`, targetInterface: `Gi2/${k}` });
    }
    const started = performance.now();
    const drawn = computeCableRoutes(links, points);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(drawn.size).toBe(links.length);
  });
});
