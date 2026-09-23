/**
 * UN CABLE SORT PAR SON PROPRE PORT, ET CHAQUE BOUT PORTE SON NOM.
 *
 * LE DEFAUT D'ORIGINE, releve sur capture Playwright : un routeur, trois
 * machines posees cote a cote dessous, chacune cablee au routeur. Les
 * trois cables quittaient le routeur par le MEME point -- l'ancrage se
 * faisait au centre du bord de la carte sans regarder qui d'autre
 * sortait par la -- et se superposaient sur toute la descente. Les trois
 * etiquettes tombaient au pixel pres, la derniere rendue masquait les
 * deux autres, et le lecteur voyait UN cable etiquete `Gi0/2`. La toile
 * ne se contentait pas d'etre chargee, elle mentait.
 *
 * CE QUI EST RETENU :
 *
 *  1. L'EVENTAIL PAR FACE. Ce qui doit etre ecarte, ce sont les cables
 *     qui quittent le MEME equipement par la MEME face, quelle que soit
 *     leur destination. Le faisceau meme-paire en devient un cas
 *     particulier -- un seul mecanisme au lieu de deux. Les cables d'une
 *     face sont ordonnes par la position du bout OPPOSE, ce qui leur
 *     evite de se croiser, et l'ecart se resserre quand la face se
 *     remplit pour que l'evasement reste borne : un port est SUR
 *     l'equipement, pas a cote.
 *
 *  2. DEUX PASTILLES PAR CABLE, CHACUNE AU PLUS PRES DE SON INTERFACE.
 *     Une pastille nomme UN port, pas un lien : elle n'a donc aucun
 *     ordre de lecture a convenir, elle designe le bout qu'elle touche.
 *     Ce qui se mesure est la proximite -- chaque pastille est plus
 *     proche de SON bout que de l'autre -- et le fait qu'elle ne
 *     s'eloigne pas plus que necessaire.
 *
 *  3. UNE PASTILLE SE COUCHE LE LONG DU FIL, jamais en travers. Elle se
 *     pose la ou un segment A LA PLACE de la porter et prend l'axe de CE
 *     segment ; quand aucun segment ne le peut, elle prend l'axe du plus
 *     long et deborde dans l'axe du cable.
 *
 *  4. ELLE NE CACHE RIEN. Les cartes, les etiquettes de nom qui pendent
 *     dessous, les autres cables et les pastilles deja posees sont des
 *     OBSTACLES : la position retenue est la plus proche de son
 *     interface PARMI CELLES QUI DEGAGENT. Le rendu complete la regle en
 *     posant les pastilles dans une couche au-dessus des equipements --
 *     `canvas-cable-labels.spec.ts` le mesure dans le DOM.
 *
 *  5. UNE PASTILLE GARDE SA TAILLE A L'ECRAN, quel que soit le zoom.
 *     Tout est dans un `scale(zoom)`, donc a la moitie du zoom le texte
 *     de neuf pixels en rendait quatre et demi : sur capture, `Gi0/0`
 *     devient une tache rouge quand le nom de l'equipement, lui, reste
 *     lisible. L'information disparait exactement quand la topologie
 *     devient assez grande pour qu'on en ait besoin.
 *
 *     Contre-echeller la pastille au rendu ne suffit pas : le placement
 *     raisonne en unites de TOILE, et une pastille rendue deux fois plus
 *     grande recouvrirait ce que le placement croyait degage. Le zoom
 *     entre donc dans le CALCUL -- la longueur de la pastille sur la
 *     toile vaut son texte divise par le zoom -- et la garantie « elle
 *     ne cache rien » tient alors a tous les zooms. Serrer le zoom
 *     retrecit la pastille sur la toile, donc la rapproche de son port.
 *
 *     En dessous d'un plancher, meme contre-echellees les pastilles ne
 *     tiennent plus : la toile montre alors la FORME du reseau et se
 *     tait sur les noms de port, plutot que d'afficher un encombrement
 *     illisible. Le plancher n'est pas deduit, il est MESURE sur le labo
 *     temoin de ce fichier -- trois machines sous un routeur, six
 *     pastilles : 1 recouvrement a 0,5 et 0,6, aucun a partir de 0,7.
 *     Un labo plus dense se tairait plus tot ; c'est une limite du
 *     reglage, pas une garantie universelle.
 *
 *  6. LE COUDE SE PLACE SELON CE QUE CHAQUE BRANCHE DOIT PORTER. Il
 *     etait fige a MI-CHEMIN entre les deux cartes, sans rien savoir des
 *     pastilles. Releve : un pare-feu en (340,90) cable a un routeur en
 *     (180,270) donne un trace dont la premiere branche fait soixante
 *     pixels ; l'etiquette de nom du pare-feu, qui pend sous sa carte,
 *     en bloque quarante et un ; il reste dix-neuf pixels pour une
 *     pastille qui en fait quarante et un. `port1` etait donc repoussee
 *     sur le corridor, a 64 pixels sur 280, loin du port qu'elle nomme.
 *
 *     Le coude connait desormais le BESOIN de chaque bout -- la marge
 *     de bout, la longueur de la pastille, et ce que l'etiquette de nom
 *     bloque quand le cable sort par le BAS. Quand la course suffit, le
 *     surplus est partage egalement et le coude retombe au milieu pour
 *     un cable symetrique ; quand elle ne suffit pas, il partage AU
 *     PRORATA des deux besoins plutot que de servir un bout au hasard.
 *     Il reste toujours entre les deux cartes : un cable ne revient
 *     jamais sur ses pas.
 *
 *  7. UNE PASTILLE QUI DEGAGE ENCORE NE BOUGE PAS. Le placement etait
 *     rejoue entierement a chaque image ; pendant un glisser, une
 *     position marginalement meilleure faisait TELEPORTER l'etiquette.
 *
 *     Releve en rejouant trois glissers pas a pas, un pixel a la fois,
 *     sur le labo temoin : un glisser HORIZONTAL du routeur ne bouge
 *     presque rien (3 pas sur 120 deplacent une pastille de plus de
 *     deux pixels, au pire 13) et un glisser qui fait BASCULER la face
 *     de sortie pas davantage (au pire 4 pixels, soit le pas lui-meme).
 *     Le defaut est le glisser VERTICAL, qui raccourcit la course et
 *     fait sauter les pastilles d'une branche a l'autre : 13 pas sur
 *     120 au-dela de deux pixels, 5 au-dela de huit, et DEUX
 *     TELEPORTATIONS au-dela de vingt-cinq, la pire de 92 pixels.
 *
 *     La position retenue est donc memorisee comme une DISTANCE LE LONG
 *     DU FIL depuis son propre bout -- pas comme un point, qui ne veut
 *     plus rien dire une fois le cable redessine. A l'image suivante,
 *     si cette meme distance tient toujours dans un segment et degage
 *     toujours tout, elle est CONSERVEE ; sinon seulement, on replace.
 *     Le resultat depend donc de l'historique, et c'est assume : sans
 *     memoire il reste exactement le placement direct, ce qu'un cas
 *     temoin verifie.
 *
 *     PREMISSE FAUSSE, CORRIGEE ICI. Un premier jet de cette sonde
 *     exigeait qu'AUCUN pas d'un glisser vertical ne deplace une
 *     pastille de plus de huit pixels. La mesure a montre que les
 *     quatre grands deplacements tombent tous au MEME pas, a distance
 *     memorisee INCHANGEE : ce n'est pas l'etiquette qui saute, c'est le
 *     CABLE qui change de face quand la dominance passe les 45 degres,
 *     et l'etiquette suit son fil. Exiger zero grand deplacement aurait
 *     fige un dessin faux. Ce qui est exige est donc : au plus UN pas de
 *     discontinuite sur tout un glisser.
 *
 *  8. LE CABLE NE BASCULE PAS DE FACE POUR UN TREMBLEMENT. La face de
 *     sortie se deduisait de `|dx| >= |dy|`, sans marge : une main qui
 *     tremble autour de la diagonale faisait basculer tout le cable a
 *     chaque pixel. Releve : soixante pas d'un tremblement de six
 *     pixels autour de la ligne des 45 degres donnent QUARANTE-SEPT
 *     basculements, l'etiquette se deplacant jusqu'a 115 pixels par
 *     pas. L'axe est desormais CONSERVE tant que l'autre ne domine pas
 *     d'une marge franche ; sans memoire, il reste exactement la
 *     dominance simple.
 *
 * Sonde ecrite AVANT le correctif.
 */
import { describe, it, expect } from 'vitest';
import {
  computeCableRoutes,
  distanceToPolyline,
  interfaceTagWidth,
  pointAlongPolyline,
  TAG_HEIGHT,
  NODE_HALF_WIDTH,
  NODE_HALF_HEIGHT,
  NODE_CENTER_OFFSET_Y,
  DEVICE_BADGE_BOTTOM,
  LABEL_MIN_ZOOM,
  shouldShowPortLabels,
  endLabelNeed,
  runIsHorizontal,
  type RoutedLink,
  type CableRoute,
  type LabelPlacement,
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

function centresOf(links: RoutedLink[]): { x: number; y: number }[] {
  const seen = new Map<string, { x: number; y: number }>();
  for (const link of links) {
    seen.set(link.sourceDeviceId, link.source);
    seen.set(link.targetDeviceId, link.target);
  }
  return [...seen.values()];
}

function routesOf(
  links: RoutedLink[], devices = centresOf(links), zoom = 1,
): CableRoute[] {
  const routes = computeCableRoutes(links, devices, zoom);
  return links.map(link => routes.get(link.id)!);
}

function everyLabel(routes: CableRoute[]): LabelPlacement[] {
  return routes.flatMap(route => [route.sourceLabel, route.targetLabel]);
}

function halfExtents(label: LabelPlacement, zoom = 1): { x: number; y: number } {
  const along = label.halfLength;
  const across = TAG_HEIGHT / (2 * zoom);
  return label.vertical ? { x: across, y: along } : { x: along, y: across };
}

function overlap(a: LabelPlacement, b: LabelPlacement, zoom = 1): boolean {
  const halfA = halfExtents(a, zoom);
  const halfB = halfExtents(b, zoom);
  return Math.abs(a.at.x - b.at.x) < halfA.x + halfB.x
    && Math.abs(a.at.y - b.at.y) < halfA.y + halfB.y;
}

const distance = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y);

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

  it('chaque bout porte le nom de SON interface, abrege', () => {
    const [a, b, c] = routesOf(ETOILE);
    expect(a.sourceLabel.text).toBe('Gi0/0');
    expect(a.targetLabel.text).toBe('eth0');
    expect(b.sourceLabel.text).toBe('Gi0/1');
    expect(c.sourceLabel.text).toBe('Gi0/2');
  });

  it('les six pastilles ne se recouvrent pas', () => {
    const labels = everyLabel(routesOf(ETOILE));
    for (let i = 0; i < labels.length; i++) {
      for (let j = i + 1; j < labels.length; j++) {
        expect(overlap(labels[i], labels[j]), `${i} et ${j}`).toBe(false);
      }
    }
  });

  it('chaque pastille reste posee sur SON propre cable', () => {
    for (const route of routesOf(ETOILE)) {
      expect(distanceToPolyline(route.sourceLabel.at, route.points)).toBeLessThan(0.5);
      expect(distanceToPolyline(route.targetLabel.at, route.points)).toBeLessThan(0.5);
    }
  });
});

describe('chaque pastille se tient au plus pres de SON interface', () => {
  it('la pastille de sortie est plus pres de la sortie que de l arrivee', () => {
    for (const route of routesOf(ETOILE)) {
      const depart = route.points[0];
      const arrivee = route.points[route.points.length - 1];
      expect(distance(route.sourceLabel.at, depart))
        .toBeLessThan(distance(route.sourceLabel.at, arrivee));
    }
  });

  it('et la pastille d arrivee, plus pres de l arrivee', () => {
    for (const route of routesOf(ETOILE)) {
      const depart = route.points[0];
      const arrivee = route.points[route.points.length - 1];
      expect(distance(route.targetLabel.at, arrivee))
        .toBeLessThan(distance(route.targetLabel.at, depart));
    }
  });

  it('elle ne s eloigne pas plus que necessaire du bord de la carte', () => {
    for (const route of routesOf(ETOILE)) {
      const demi = interfaceTagWidth(route.sourceLabel.text) / 2;
      expect(distance(route.sourceLabel.at, route.points[0]))
        .toBeLessThan(demi + NODE_HALF_WIDTH * 2);
    }
  });
});

describe('une pastille se couche le long de son cable', () => {
  const lien = (
    source: { x: number; y: number }, target: { x: number; y: number },
  ): RoutedLink => ({
    id: 'seul', sourceDeviceId: 'A', targetDeviceId: 'B', source, target,
    sourceInterface: 'GigabitEthernet0/0', targetInterface: 'eth0',
  });

  it('sur un cable qui descend, les deux pastilles pivotent', () => {
    const [route] = routesOf([lien({ x: 200, y: 100 }, { x: 200, y: 600 })]);
    expect(route.sourceLabel.vertical).toBe(true);
    expect(route.targetLabel.vertical).toBe(true);
  });

  it('sur un cable qui court a plat, elles restent horizontales', () => {
    const [route] = routesOf([lien({ x: 100, y: 200 }, { x: 700, y: 200 })]);
    expect(route.sourceLabel.vertical).toBe(false);
    expect(route.targetLabel.vertical).toBe(false);
  });

  it('un cable coude couche chaque pastille selon SON bout', () => {
    const [route] = routesOf([lien({ x: 100, y: 200 }, { x: 700, y: 560 })]);
    const last = route.points.length - 1;
    const axeDuBout = (label: LabelPlacement, from: number, to: number) => {
      const a = route.points[from];
      const b = route.points[to];
      return (Math.abs(b.y - a.y) > Math.abs(b.x - a.x)) === label.vertical;
    };
    expect(axeDuBout(route.sourceLabel, 0, 1)).toBe(true);
    expect(axeDuBout(route.targetLabel, last, last - 1)).toBe(true);
  });

  it('meme sur un cable trop court, elle ne se met pas EN TRAVERS', () => {
    const RAPPROCHES: RoutedLink[] = [
      {
        id: 'court', sourceDeviceId: 'R1', targetDeviceId: 'PC1',
        source: { x: 150, y: 150 }, target: { x: 245, y: 150 },
        sourceInterface: 'GigabitEthernet0/0', targetInterface: 'eth0',
      },
      {
        id: 'long', sourceDeviceId: 'R1', targetDeviceId: 'SW1',
        source: { x: 150, y: 150 }, target: { x: 420, y: 200 },
        sourceInterface: 'GigabitEthernet0/2', targetInterface: 'FastEthernet0/1',
      },
    ];
    const [court] = routesOf(RAPPROCHES);
    expect(court.sourceLabel.vertical).toBe(false);
    expect(court.targetLabel.vertical).toBe(false);
  });
});

describe('une pastille ne cache rien', () => {
  const COUDE: RoutedLink[] = [{
    id: 'coude', sourceDeviceId: 'A', targetDeviceId: 'C',
    source: { x: 100, y: 200 }, target: { x: 700, y: 400 },
    sourceInterface: 'GigabitEthernet0/0', targetInterface: 'eth0',
  }];

  const dansLaBoite = (at: { x: number; y: number }, centre: { x: number; y: number }) => {
    const carte = { x: centre.x, y: centre.y + NODE_CENTER_OFFSET_Y };
    return Math.abs(at.x - carte.x) < NODE_HALF_WIDTH
      && at.y > carte.y - NODE_HALF_HEIGHT
      && at.y < carte.y + DEVICE_BADGE_BOTTOM;
  };

  it('un cable qui passe sous un equipement tiers n y pose pas de pastille', () => {
    const geneur = { x: 400, y: 300 };
    const [route] = routesOf(COUDE, [{ x: 100, y: 200 }, geneur, { x: 700, y: 400 }]);
    expect(dansLaBoite(route.sourceLabel.at, geneur)).toBe(false);
    expect(dansLaBoite(route.targetLabel.at, geneur)).toBe(false);
  });

  it('ni sous l etiquette de nom, qui pend SOUS la carte', () => {
    const geneur = { x: 400, y: 258 };
    const [route] = routesOf(COUDE, [{ x: 100, y: 200 }, geneur, { x: 700, y: 400 }]);
    expect(dansLaBoite(route.sourceLabel.at, geneur)).toBe(false);
    expect(dansLaBoite(route.targetLabel.at, geneur)).toBe(false);
  });

  it('mais elles restent posees sur leur cable', () => {
    const geneur = { x: 400, y: 300 };
    const [route] = routesOf(COUDE, [{ x: 100, y: 200 }, geneur, { x: 700, y: 400 }]);
    expect(distanceToPolyline(route.sourceLabel.at, route.points)).toBeLessThan(0.5);
    expect(distanceToPolyline(route.targetLabel.at, route.points)).toBeLessThan(0.5);
  });

  it('et les deux pastilles d un meme cable ne se rencontrent jamais', () => {
    const [route] = routesOf(COUDE);
    expect(overlap(route.sourceLabel, route.targetLabel)).toBe(false);
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

  it('et leurs quatre pastilles ne se recouvrent pas', () => {
    const labels = everyLabel(routesOf(PAIRE));
    for (let i = 0; i < labels.length; i++) {
      for (let j = i + 1; j < labels.length; j++) {
        expect(overlap(labels[i], labels[j]), `${i} et ${j}`).toBe(false);
      }
    }
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

  it('et un point pris sur le trace y reste', () => {
    expect(distanceToPolyline(pointAlongPolyline(TRACE, 0.5), TRACE)).toBeCloseTo(0, 6);
  });
});

describe('une pastille garde sa taille a l ecran, quel que soit le zoom', () => {
  it('a zoom 1, sa longueur sur la toile est celle de son texte', () => {
    const [route] = routesOf(ETOILE);
    expect(route.sourceLabel.halfLength)
      .toBeCloseTo(interfaceTagWidth(route.sourceLabel.text) / 2, 5);
  });

  it('a zoom 2, elle occupe deux fois moins de place sur la toile', () => {
    const [serre] = routesOf(ETOILE, centresOf(ETOILE), 2);
    const [normal] = routesOf(ETOILE);
    expect(serre.sourceLabel.halfLength).toBeCloseTo(normal.sourceLabel.halfLength / 2, 5);
  });

  it('et a zoom 0.5, deux fois plus', () => {
    const [large] = routesOf(ETOILE, centresOf(ETOILE), 0.5);
    const [normal] = routesOf(ETOILE);
    expect(large.sourceLabel.halfLength).toBeCloseTo(normal.sourceLabel.halfLength * 2, 5);
  });

  it('plus serree, elle se tient plus pres de son port', () => {
    const [serre] = routesOf(ETOILE, centresOf(ETOILE), 2);
    const [normal] = routesOf(ETOILE);
    expect(distance(serre.sourceLabel.at, serre.points[0]))
      .toBeLessThanOrEqual(distance(normal.sourceLabel.at, normal.points[0]));
  });

  it('et la garantie de ne rien cacher tient DES le plancher', () => {
    for (const zoom of [LABEL_MIN_ZOOM, 1, 2]) {
      const routes = routesOf(ETOILE, centresOf(ETOILE), zoom);
      const labels = everyLabel(routes);
      for (let i = 0; i < labels.length; i++) {
        for (let j = i + 1; j < labels.length; j++) {
          expect(overlap(labels[i], labels[j], zoom), `zoom ${zoom}, ${i} et ${j}`)
            .toBe(false);
        }
      }
    }
  });

  it('sous le plancher, la toile se tait sur les noms de port', () => {
    expect(shouldShowPortLabels(1)).toBe(true);
    expect(shouldShowPortLabels(LABEL_MIN_ZOOM)).toBe(true);
    expect(shouldShowPortLabels(LABEL_MIN_ZOOM - 0.01)).toBe(false);
    expect(shouldShowPortLabels(0.25)).toBe(false);
  });
});

describe('le coude se place selon ce que chaque branche doit porter', () => {
  const lien = (
    source: { x: number; y: number }, target: { x: number; y: number },
  ): RoutedLink => ({
    id: 'seul', sourceDeviceId: 'FW', targetDeviceId: 'R1', source, target,
    sourceInterface: 'port1', targetInterface: 'GigabitEthernet0/0',
  });

  const legs = (route: CableRoute) => {
    const length = (a: number, b: number) =>
      Math.hypot(route.points[b].x - route.points[a].x, route.points[b].y - route.points[a].y);
    return { first: length(0, 1), last: length(route.points.length - 2, route.points.length - 1) };
  };

  it('quand la course suffit, chaque branche recoit son besoin', () => {
    const route = routesOf([lien({ x: 340, y: 90 }, { x: 180, y: 400 })])[0];
    expect(legs(route).first)
      .toBeGreaterThanOrEqual(endLabelNeed(route.sourceLabel.halfLength, 'bottom'));
    expect(legs(route).last)
      .toBeGreaterThanOrEqual(endLabelNeed(route.targetLabel.halfLength, 'top'));
  });

  it('la pastille se pose alors sur SA branche, pas sur le corridor', () => {
    const route = routesOf([lien({ x: 340, y: 90 }, { x: 180, y: 400 })])[0];
    expect(distanceToPolyline(route.sourceLabel.at, [route.points[0], route.points[1]]))
      .toBeLessThan(0.5);
  });

  it('sur une course courte, la pastille de sortie tient sur SA branche', () => {
    const route = routesOf([lien({ x: 340, y: 90 }, { x: 180, y: 270 })])[0];
    expect(distanceToPolyline(route.sourceLabel.at, [route.points[0], route.points[1]]))
      .toBeLessThan(0.5);
  });

  it('quand elle ne suffit pas, le coude partage AU PRORATA des besoins', () => {
    const route = routesOf([lien({ x: 340, y: 90 }, { x: 180, y: 270 })])[0];
    const { first, last } = legs(route);
    const besoinSortie = endLabelNeed(route.sourceLabel.halfLength, 'bottom');
    const besoinArrivee = endLabelNeed(route.targetLabel.halfLength, 'top');
    expect(first / (first + last))
      .toBeCloseTo(besoinSortie / (besoinSortie + besoinArrivee), 2);
  });

  it('un cable symetrique garde son coude au MILIEU', () => {
    const route = routesOf([{
      id: 'seul', sourceDeviceId: 'A', targetDeviceId: 'B',
      source: { x: 200, y: 100 }, target: { x: 500, y: 400 },
      sourceInterface: 'eth0', targetInterface: 'eth0',
    }])[0];
    const { first, last } = legs(route);
    expect(first).toBeCloseTo(last, 5);
  });

  it('et il reste TOUJOURS entre les deux cartes', () => {
    for (const cible of [{ x: 180, y: 190 }, { x: 180, y: 400 }, { x: 900, y: 95 }]) {
      const route = routesOf([lien({ x: 340, y: 90 }, cible)])[0];
      const [depart, , , arrivee] = route.points;
      const borne = (valeur: number, a: number, b: number) =>
        valeur >= Math.min(a, b) - 0.001 && valeur <= Math.max(a, b) + 0.001;
      expect(borne(route.points[1].x, depart.x, arrivee.x)).toBe(true);
      expect(borne(route.points[1].y, depart.y, arrivee.y)).toBe(true);
    }
  });
});

describe('une pastille qui degage encore ne bouge pas', () => {
  const star = (rx: number, ry: number) => {
    const routeur = { x: rx, y: ry };
    const machines = [220, 400, 580].map(x => ({ x, y: 430 }));
    return {
      links: machines.map((machine, i) => ({
        id: `c${i}`, sourceDeviceId: 'R1', targetDeviceId: `PC${i}`,
        source: routeur, target: machine,
        sourceInterface: `GigabitEthernet0/${i}`, targetInterface: 'eth0',
      })) as RoutedLink[],
      devices: [routeur, ...machines],
    };
  };

  const worstStep = (positions: Array<{ x: number; y: number }>) => {
    let previous: Map<string, CableRoute> | undefined;
    let seen: Record<string, { x: number; y: number }> | null = null;
    let worst = 0;
    for (const at of positions) {
      const { links, devices } = star(at.x, at.y);
      const routes = computeCableRoutes(links, devices, 1, previous);
      const now: Record<string, { x: number; y: number }> = {};
      for (const [id, route] of routes) {
        now[`${id}:s`] = route.sourceLabel.at;
        now[`${id}:t`] = route.targetLabel.at;
      }
      if (seen) {
        for (const key of Object.keys(now)) {
          worst = Math.max(worst, Math.hypot(
            now[key].x - seen[key].x, now[key].y - seen[key].y));
        }
      }
      seen = now;
      previous = routes;
    }
    return worst;
  };

  const noisySteps = (positions: Array<{ x: number; y: number }>) => {
    let previous: Map<string, CableRoute> | undefined;
    let seen: Record<string, { x: number; y: number }> | null = null;
    let noisy = 0;
    for (const at of positions) {
      const { links, devices } = star(at.x, at.y);
      const routes = computeCableRoutes(links, devices, 1, previous);
      const now: Record<string, { x: number; y: number }> = {};
      for (const [id, route] of routes) {
        now[`${id}:s`] = route.sourceLabel.at;
        now[`${id}:t`] = route.targetLabel.at;
      }
      if (seen) {
        const moved = Object.keys(now).some(key => Math.hypot(
          now[key].x - seen![key].x, now[key].y - seen![key].y) > 8);
        if (moved) noisy++;
      }
      seen = now;
      previous = routes;
    }
    return noisy;
  };

  it('un glisser vertical ne connait qu UN pas de discontinuite', () => {
    expect(noisySteps(Array.from({ length: 121 }, (_, i) => ({ x: 340, y: 120 + i }))))
      .toBeLessThanOrEqual(1);
  });

  it('ni un glisser horizontal, qui etait deja calme', () => {
    expect(worstStep(Array.from({ length: 121 }, (_, i) => ({ x: 280 + i, y: 120 }))))
      .toBeLessThan(8);
  });

  it('a entree identique, la memoire ne deplace rien', () => {
    const { links, devices } = star(340, 120);
    const first = computeCableRoutes(links, devices);
    const second = computeCableRoutes(links, devices, 1, first);
    for (const [id, route] of first) {
      expect(second.get(id)!.sourceLabel.at).toEqual(route.sourceLabel.at);
      expect(second.get(id)!.targetLabel.at).toEqual(route.targetLabel.at);
    }
  });

  it('mais une position qui ne degage plus est abandonnee', () => {
    const loin = star(340, 120);
    const memoire = computeCableRoutes(loin.links, loin.devices);
    const pres = star(340, 300);
    const apres = computeCableRoutes(pres.links, pres.devices, 1, memoire);
    for (const route of apres.values()) {
      expect(distanceToPolyline(route.sourceLabel.at, route.points)).toBeLessThan(0.5);
      expect(distanceToPolyline(route.targetLabel.at, route.points)).toBeLessThan(0.5);
    }
  });

  it('et sans memoire, le resultat reste le placement direct', () => {
    const { links, devices } = star(340, 120);
    const direct = computeCableRoutes(links, devices);
    const encore = computeCableRoutes(links, devices);
    for (const [id, route] of direct) {
      expect(encore.get(id)!.sourceLabel.at).toEqual(route.sourceLabel.at);
    }
  });
});

describe('le cable ne bascule pas de face pour un tremblement', () => {
  const lab = (at: { x: number; y: number }) => ({
    links: [{
      id: 'x', sourceDeviceId: 'A', targetDeviceId: 'B',
      source: at, target: { x: 580, y: 430 },
      sourceInterface: 'GigabitEthernet0/0', targetInterface: 'eth0',
    }] as RoutedLink[],
    devices: [at, { x: 580, y: 430 }],
  });

  const drawnHorizontal = (route: CableRoute) =>
    Math.abs(route.points[1].x - route.points[0].x)
      > Math.abs(route.points[1].y - route.points[0].y);

  const flipsAlong = (path: Array<{ x: number; y: number }>) => {
    let previous: Map<string, CableRoute> | undefined;
    let last: boolean | null = null;
    let flips = 0;
    for (const at of path) {
      const { links, devices } = lab(at);
      const routes = computeCableRoutes(links, devices, 1, previous);
      const horizontal = drawnHorizontal(routes.get('x')!);
      if (last !== null && horizontal !== last) flips++;
      last = horizontal;
      previous = routes;
    }
    return flips;
  };

  it('une main qui tremble autour des 45 degres ne le fait plus basculer', () => {
    const tremblement = Array.from({ length: 60 }, (_, i) => ({
      x: 340, y: 186 + (i % 2 === 0 ? 0 : 6),
    }));
    expect(flipsAlong(tremblement)).toBeLessThanOrEqual(1);
  });

  it('mais un glisser franc au-dela de la marge le fait bien basculer', () => {
    const franc = Array.from({ length: 160 }, (_, i) => ({ x: 340, y: 120 + i }));
    expect(flipsAlong(franc)).toBe(1);
  });

  it('l axe retenu est bien celui que le cable DESSINE', () => {
    for (const y of [140, 186, 192, 300]) {
      const { links, devices } = lab({ x: 340, y });
      const route = computeCableRoutes(links, devices).get('x')!;
      expect(route.horizontal).toBe(drawnHorizontal(route));
    }
  });

  it('et sans memoire, l axe reste la dominance simple', () => {
    expect(runIsHorizontal({ x: 0, y: 0 }, { x: 100, y: 40 })).toBe(true);
    expect(runIsHorizontal({ x: 0, y: 0 }, { x: 40, y: 100 })).toBe(false);
    expect(runIsHorizontal({ x: 0, y: 0 }, { x: 100, y: 100 })).toBe(true);
  });
});
