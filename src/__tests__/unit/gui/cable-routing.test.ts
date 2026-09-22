/**
 * UN CABLE SORT PAR SON PROPRE PORT, ET PORTE UNE SEULE ETIQUETTE.
 *
 * LE DEFAUT MESURE, sur capture Playwright : un routeur, trois machines
 * posees cote a cote dessous, chacune cablee au routeur. Les trois
 * cables quittent le routeur par le MEME point -- `computeOrthogonalPoints`
 * ancre la sortie au centre du bord de la carte sans regarder qui
 * d'autre sort par la -- et se superposent sur toute la descente. Pire
 * que de l'encombrement : les trois pastilles `Gi0/0`, `Gi0/1`, `Gi0/2`
 * sont empilees au pixel pres, la derniere rendue masque les deux
 * autres, et le lecteur voit UN cable etiquete `Gi0/2`. La toile ment.
 *
 * Le faisceau ne reglait qu'un cas particulier : plusieurs cables entre
 * la MEME paire d'equipements. Trois cables vers trois machines
 * differentes ne forment aucune paire commune, donc aucune voie.
 *
 * CE QUI EST RETENU, et les deux tiennent ensemble :
 *
 *  1. L'EVENTAIL PAR FACE. Ce qui doit etre ecarte, ce sont les cables
 *     qui quittent le MEME equipement par la MEME face, quelle que soit
 *     leur destination. Le faisceau meme-paire en devient un cas
 *     particulier -- un seul mecanisme au lieu de deux. Les cables
 *     d'une face sont ordonnes par la position du bout OPPOSE, ce qui
 *     leur evite de se croiser, et l'evasement est borne par la carte :
 *     un port est SUR l'equipement, pas a cote.
 *
 *  2. UNE SEULE PASTILLE, LA OU LES CABLES SE SEPARENT. Deux etiquettes
 *     par cable, posees a distance fixe de chaque carte, se rencontrent
 *     precisement la ou les cables se rejoignent. Une seule pastille par
 *     cable, nommant ses DEUX interfaces, posee au point du trace le
 *     plus LOIN de tous les autres cables et de toutes les etiquettes
 *     deja posees : le placement devient une consequence du dessin au
 *     lieu d'une constante.
 *
 *  3. LA PASTILLE SE COUCHE LE LONG DU CABLE. Sur un segment vertical
 *     elle pivote d'un quart de tour et se lit de haut en bas ; sur un
 *     segment horizontal elle reste a plat. Une etiquette posee en
 *     travers de son fil laisse encore le lecteur choisir a quel fil
 *     elle appartient ; posee DANS son axe, elle ne le laisse plus.
 *
 *  4. L'ORDRE DES DEUX NOMS VIENT DE LA POSITION DES EQUIPEMENTS, pas
 *     d'une convention. Sur une pastille a plat, le nom ecrit en
 *     premier est l'interface de l'equipement le plus a GAUCHE ; sur
 *     une pastille couchee, celle de l'equipement le plus HAUT. Le
 *     corollaire est ce qui se mesure : cabler A vers B ou B vers A
 *     donne la MEME etiquette, parce que le dessin ne depend pas de
 *     l'ordre dans lequel l'operateur a clique.
 *
 * Sonde ecrite AVANT le correctif.
 */
import { describe, it, expect } from 'vitest';
import {
  computeCableRoutes,
  distanceToPolyline,
  interfaceTagWidth,
  TAG_HEIGHT,
  NODE_HALF_WIDTH,
  type RoutedLink,
  type CableRoute,
} from '@/components/network/connection-line-logic';

const ROUTEUR = { x: 340, y: 120 };
const PC_GAUCHE = { x: 220, y: 430 };
const PC_MILIEU = { x: 400, y: 430 };
const PC_DROITE = { x: 580, y: 430 };

const ETOILE: RoutedLink[] = [
  {
    id: 'a', sourceDeviceId: 'R1', targetDeviceId: 'PC1',
    source: ROUTEUR, target: PC_GAUCHE,
    sourceInterface: 'GigabitEthernet0/0', targetInterface: 'eth0',
  },
  {
    id: 'b', sourceDeviceId: 'R1', targetDeviceId: 'PC2',
    source: ROUTEUR, target: PC_MILIEU,
    sourceInterface: 'GigabitEthernet0/1', targetInterface: 'eth0',
  },
  {
    id: 'c', sourceDeviceId: 'R1', targetDeviceId: 'PC3',
    source: ROUTEUR, target: PC_DROITE,
    sourceInterface: 'GigabitEthernet0/2', targetInterface: 'eth0',
  },
];

function routesOf(links: RoutedLink[]): CableRoute[] {
  const routes = computeCableRoutes(links);
  return links.map(link => routes.get(link.id)!);
}

function halfExtents(route: CableRoute): { x: number; y: number } {
  const along = interfaceTagWidth(route.labelText) / 2;
  const across = TAG_HEIGHT / 2;
  return route.labelVertical ? { x: across, y: along } : { x: along, y: across };
}

function boxesOverlap(a: CableRoute, b: CableRoute): boolean {
  const halfA = halfExtents(a);
  const halfB = halfExtents(b);
  return Math.abs(a.label.x - b.label.x) < halfA.x + halfB.x
    && Math.abs(a.label.y - b.label.y) < halfA.y + halfB.y;
}

describe('trois machines cote a cote sous un seul routeur', () => {
  it('les trois cables quittent le routeur par trois points DISTINCTS', () => {
    const sorties = routesOf(ETOILE).map(r => `${r.points[0].x},${r.points[0].y}`);
    expect(new Set(sorties).size).toBe(3);
  });

  it('et ces trois points restent SUR le bord de la carte', () => {
    for (const route of routesOf(ETOILE)) {
      expect(Math.abs(route.sourceLane)).toBeLessThanOrEqual(NODE_HALF_WIDTH);
    }
  });

  it('le cable de la machine la plus a gauche sort le plus a gauche', () => {
    const [a, b, c] = routesOf(ETOILE);
    expect(a.points[0].x).toBeLessThan(b.points[0].x);
    expect(b.points[0].x).toBeLessThan(c.points[0].x);
  });

  it('chaque cable porte UNE pastille qui nomme ses DEUX interfaces', () => {
    const [a, b, c] = routesOf(ETOILE);
    expect(a.labelText).toContain('Gi0/0');
    expect(a.labelText).toContain('eth0');
    expect(b.labelText).toContain('Gi0/1');
    expect(c.labelText).toContain('Gi0/2');
  });

  it('les trois pastilles ne se recouvrent pas', () => {
    const routes = routesOf(ETOILE);
    for (let i = 0; i < routes.length; i++) {
      for (let j = i + 1; j < routes.length; j++) {
        expect(boxesOverlap(routes[i], routes[j])).toBe(false);
      }
    }
  });

  it('chaque pastille est posee LOIN des autres cables', () => {
    const routes = routesOf(ETOILE);
    routes.forEach((route, index) => {
      routes.forEach((other, otherIndex) => {
        if (index === otherIndex) return;
        expect(distanceToPolyline(route.label, other.points))
          .toBeGreaterThanOrEqual(TAG_HEIGHT);
      });
    });
  });

  it('tout en restant posee sur SON propre cable', () => {
    for (const route of routesOf(ETOILE)) {
      expect(distanceToPolyline(route.label, route.points)).toBeLessThan(0.5);
    }
  });

  it('et jamais a cheval sur la carte : la pastille tient ENTIERE sur le fil', () => {
    for (const route of routesOf(ETOILE)) {
      const half = interfaceTagWidth(route.labelText) / 2;
      const depuisLaSortie = Math.hypot(
        route.label.x - route.points[0].x, route.label.y - route.points[0].y);
      const jusqueALArrivee = Math.hypot(
        route.label.x - route.points[route.points.length - 1].x,
        route.label.y - route.points[route.points.length - 1].y);
      expect(depuisLaSortie).toBeGreaterThan(half);
      expect(jusqueALArrivee).toBeGreaterThan(half);
    }
  });
});

describe('la pastille se couche le long de son cable', () => {
  const lien = (
    source: { x: number; y: number }, target: { x: number; y: number },
  ): RoutedLink => ({
    id: 'seul', sourceDeviceId: 'A', targetDeviceId: 'B', source, target,
    sourceInterface: 'GigabitEthernet0/0', targetInterface: 'eth0',
  });

  it('sur un cable qui descend, elle pivote d un quart de tour', () => {
    const [route] = routesOf([lien({ x: 200, y: 100 }, { x: 200, y: 500 })]);
    expect(route.labelVertical).toBe(true);
  });

  it('sur un cable qui court a plat, elle reste horizontale', () => {
    const [route] = routesOf([lien({ x: 100, y: 200 }, { x: 600, y: 200 })]);
    expect(route.labelVertical).toBe(false);
  });
});

describe('l ordre des deux noms vient de la position des equipements', () => {
  const lien = (
    id: string,
    source: { x: number; y: number }, target: { x: number; y: number },
  ): RoutedLink => ({
    id, sourceDeviceId: 'A', targetDeviceId: 'B', source, target,
    sourceInterface: 'GigabitEthernet0/0', targetInterface: 'eth0',
  });

  const lit = (route: CableRoute) =>
    route.labelText.indexOf('Gi0/0') < route.labelText.indexOf('eth0')
      ? 'Gi0/0 en premier' : 'eth0 en premier';

  it('a plat, l equipement le plus a GAUCHE est nomme en premier', () => {
    const [versLaDroite] = routesOf([lien('x', { x: 100, y: 200 }, { x: 600, y: 200 })]);
    expect(lit(versLaDroite)).toBe('Gi0/0 en premier');
    const [versLaGauche] = routesOf([lien('x', { x: 600, y: 200 }, { x: 100, y: 200 })]);
    expect(lit(versLaGauche)).toBe('eth0 en premier');
  });

  it('couchee, l equipement le plus HAUT est nomme en premier', () => {
    const [versLeBas] = routesOf([lien('x', { x: 200, y: 100 }, { x: 200, y: 600 })]);
    expect(lit(versLeBas)).toBe('Gi0/0 en premier');
    const [versLeHaut] = routesOf([lien('x', { x: 200, y: 600 }, { x: 200, y: 100 })]);
    expect(lit(versLeHaut)).toBe('eth0 en premier');
  });

  it('cabler A vers B ou B vers A donne la MEME etiquette', () => {
    const gauche = { x: 120, y: 240 };
    const droite = { x: 620, y: 240 };
    const [aVersB] = routesOf([{
      id: 'x', sourceDeviceId: 'A', targetDeviceId: 'B',
      source: gauche, target: droite,
      sourceInterface: 'GigabitEthernet0/0', targetInterface: 'eth0',
    }]);
    const [bVersA] = routesOf([{
      id: 'x', sourceDeviceId: 'B', targetDeviceId: 'A',
      source: droite, target: gauche,
      sourceInterface: 'eth0', targetInterface: 'GigabitEthernet0/0',
    }]);
    expect(bVersA.labelText).toBe(aVersB.labelText);
  });
});

describe('deux cables entre les memes equipements', () => {
  const PAIRE: RoutedLink[] = [
    {
      id: 'p1', sourceDeviceId: 'R1', targetDeviceId: 'SW1',
      source: { x: 120, y: 200 }, target: { x: 620, y: 200 },
      sourceInterface: 'GigabitEthernet0/0', targetInterface: 'FastEthernet0/1',
    },
    {
      id: 'p2', sourceDeviceId: 'R1', targetDeviceId: 'SW1',
      source: { x: 120, y: 200 }, target: { x: 620, y: 200 },
      sourceInterface: 'GigabitEthernet0/1', targetInterface: 'FastEthernet0/2',
    },
  ];

  it('gardent deux voies distinctes aux DEUX bouts', () => {
    const [a, b] = routesOf(PAIRE);
    expect(a.points[0].y).not.toBeCloseTo(b.points[0].y, 3);
    expect(a.points[a.points.length - 1].y)
      .not.toBeCloseTo(b.points[b.points.length - 1].y, 3);
  });

  it('sans se croiser : le meme ordre a la sortie et a l arrivee', () => {
    const [a, b] = routesOf(PAIRE);
    const sortie = Math.sign(a.points[0].y - b.points[0].y);
    const arrivee = Math.sign(
      a.points[a.points.length - 1].y - b.points[b.points.length - 1].y);
    expect(sortie).toBe(arrivee);
    expect(sortie).not.toBe(0);
  });

  it('et leurs deux pastilles ne se recouvrent pas non plus', () => {
    const [a, b] = routesOf(PAIRE);
    expect(boxesOverlap(a, b)).toBe(false);
  });
});

describe('la distance d un point a un trace', () => {
  const TRACE = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }];

  it('vaut zero sur le trace lui-meme', () => {
    expect(distanceToPolyline({ x: 50, y: 0 }, TRACE)).toBeCloseTo(0, 6);
    expect(distanceToPolyline({ x: 100, y: 60 }, TRACE)).toBeCloseTo(0, 6);
  });

  it('mesure la perpendiculaire quand le pied tombe dans le segment', () => {
    expect(distanceToPolyline({ x: 50, y: 30 }, TRACE)).toBeCloseTo(30, 6);
  });

  it('mesure la distance a l extremite quand le pied tombe dehors', () => {
    expect(distanceToPolyline({ x: -30, y: -40 }, TRACE)).toBeCloseTo(50, 6);
  });

  it('retient le segment le PLUS PROCHE, pas le premier', () => {
    expect(distanceToPolyline({ x: 90, y: 90 }, TRACE)).toBeCloseTo(10, 6);
  });
});
