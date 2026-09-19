/**
 * Une etiquette de port est une ETIQUETTE PINCEE SUR LE CABLE.
 *
 * Ce que la toile rendait, et le defaut qu'on ferme : le nom
 * d'interface flottait A COTE du cable (`LABEL_LIFT` le decalait
 * perpendiculairement), en blanc, a la meme couleur pour tous les
 * cables. Sur une toile ou quatre liens partent du meme equipement, on
 * lisait un nuage de `Gi0/1 Fa0/3 Gi0/2` sans savoir lequel appartient a
 * quel fil, et rien ne disait ou le cable ENTRE dans la carte.
 *
 * LE PRINCIPE RETENU, et il tient en trois gestes :
 *
 *  1. le point de sortie porte une PRISE -- un trait court en travers du
 *     cable, a l'endroit exact ou il quitte la carte. C'est ce qui dit
 *     « branche ICI » ;
 *  2. le nom de port est pose SUR le cable, pas a cote : la pastille est
 *     centree sur le trace, le cable y entre d'un cote et en ressort de
 *     l'autre. L'appartenance n'est plus a deviner, elle est
 *     geometrique ;
 *  3. la pastille est bordee de la COULEUR DU CABLE, et la couleur d'un
 *     cable dit deja son type et son etat. Quatre liens qui se croisent
 *     restent lisibles parce que chaque etiquette porte la teinte de son
 *     fil.
 *
 * Ce fichier ne teste que la GEOMETRIE, qui est pure. Le rendu SVG
 * l'utilise sans la recalculer.
 *
 * SECOND RELEVE, sur capture d'ecran Playwright d'un labo a deux cables
 * entre le meme routeur et le meme commutateur : les deux pastilles
 * `Gi0/0` et `Gi0/1` se CHEVAUCHENT. Deux nombres l'expliquent, et les
 * deux sont mesurables ici :
 *
 *  - les voies d'un faisceau sont ecartees de 13 px alors qu'une
 *    pastille en fait 14 de haut : posees chacune sur sa voie, elles se
 *    touchent ;
 *  - le decalage LE LONG du cable qui tentait de les separer vaut 21 px
 *    pour une pastille large de ~41 : il ne separe rien, il ne fait que
 *    detacher la pastille de sa propre prise.
 *
 * Ce qui est retenu : c'est la VOIE qui separe, pas un decalage. On
 * ecarte les voies assez pour qu'une pastille tienne sur chacune, on
 * borne l'evasement du faisceau pour qu'il reste accroche a la carte, et
 * on supprime le decalage le long du cable. Au-dela de cinq cables entre
 * deux memes equipements le faisceau se comprime pour rester accroche et
 * les pastilles se serrent : la pastille de rang `n/N` et le resume au
 * survol restent alors les deux seuls discriminants, et c'est dit.
 *
 * Sonde ecrite AVANT le correctif.
 */
import { describe, it, expect } from 'vitest';
import {
  computeEndpointAnchors,
  computeInterfaceLabelPositions,
  interfaceTagWidth,
  linkSummaryLabel,
  connectorSegment,
  computeOrthogonalPoints,
  bundleOffset,
  CONNECTOR_HALF_LENGTH,
  TAG_HEIGHT,
  NODE_HALF_HEIGHT,
} from '@/components/network/connection-line-logic';

const GAUCHE = { x: 100, y: 200 };
const DROITE = { x: 400, y: 200 };
const HAUT = { x: 200, y: 100 };
const BAS = { x: 200, y: 400 };

describe('la prise : ou le cable entre dans la carte', () => {
  it('l ancre est le point ou le trace quitte la carte', () => {
    const points = computeOrthogonalPoints(GAUCHE, DROITE);
    const ancres = computeEndpointAnchors(GAUCHE, DROITE);
    expect(ancres.source.point).toEqual(points[0]);
    expect(ancres.target.point).toEqual(points[points.length - 1]);
  });

  it('la direction pointe vers le cable, pas vers la carte', () => {
    const ancres = computeEndpointAnchors(GAUCHE, DROITE);
    expect(ancres.source.direction.x).toBeCloseTo(1, 5);
    expect(ancres.source.direction.y).toBeCloseTo(0, 5);
    expect(ancres.target.direction.x).toBeCloseTo(-1, 5);
    expect(ancres.target.direction.y).toBeCloseTo(0, 5);
  });

  it('elle pointe vers le BAS quand le cable descend', () => {
    const ancres = computeEndpointAnchors(HAUT, BAS);
    expect(ancres.source.direction.y).toBeCloseTo(1, 5);
    expect(ancres.source.direction.x).toBeCloseTo(0, 5);
  });

  it('la prise est TRAVERS le cable, et centree sur lui', () => {
    const ancre = computeEndpointAnchors(GAUCHE, DROITE).source;
    const prise = connectorSegment(ancre);
    expect(prise.a.x).toBeCloseTo(ancre.point.x, 5);
    expect(prise.b.x).toBeCloseTo(ancre.point.x, 5);
    expect(prise.a.y).toBeCloseTo(ancre.point.y - CONNECTOR_HALF_LENGTH, 5);
    expect(prise.b.y).toBeCloseTo(ancre.point.y + CONNECTOR_HALF_LENGTH, 5);
  });

  it('et elle tourne avec le cable : verticale, elle devient horizontale', () => {
    const ancre = computeEndpointAnchors(HAUT, BAS).source;
    const prise = connectorSegment(ancre);
    expect(prise.a.y).toBeCloseTo(ancre.point.y, 5);
    expect(prise.b.y).toBeCloseTo(ancre.point.y, 5);
    expect(Math.abs(prise.a.x - prise.b.x)).toBeCloseTo(CONNECTOR_HALF_LENGTH * 2, 5);
  });
});

describe('la pastille : posee SUR le cable', () => {
  it('elle est centree sur le trace, plus a cote', () => {
    const points = computeOrthogonalPoints(GAUCHE, DROITE);
    const positions = computeInterfaceLabelPositions(GAUCHE, DROITE);
    expect(positions.source.y).toBeCloseTo(points[0].y, 5);
    expect(positions.target.y).toBeCloseTo(points[points.length - 1].y, 5);
  });

  it('elle reste entre la carte et le milieu du cable', () => {
    const positions = computeInterfaceLabelPositions(GAUCHE, DROITE);
    expect(positions.source.x).toBeGreaterThan(GAUCHE.x);
    expect(positions.source.x).toBeLessThan(250);
    expect(positions.target.x).toBeGreaterThan(250);
    expect(positions.target.x).toBeLessThan(DROITE.x);
  });

  it('sur un cable vertical elle se centre aussi, en x', () => {
    const points = computeOrthogonalPoints(HAUT, BAS);
    const positions = computeInterfaceLabelPositions(HAUT, BAS);
    expect(positions.source.x).toBeCloseTo(points[0].x, 5);
    expect(positions.target.x).toBeCloseTo(points[points.length - 1].x, 5);
  });
});

describe('la largeur de la pastille suit son texte', () => {
  it('un nom plus long donne une pastille plus large', () => {
    expect(interfaceTagWidth('Gi0/10')).toBeGreaterThan(interfaceTagWidth('Fa0/1'));
  });

  it('un nom tres court garde une largeur minimale lisible', () => {
    expect(interfaceTagWidth('e0')).toBeGreaterThanOrEqual(22);
  });

  it('elle contient vraiment son texte', () => {
    const texte = 'GigabitEthernet0/0';
    expect(interfaceTagWidth(texte)).toBeGreaterThan(texte.length * 5);
  });
});

describe('le resume du lien, pour le survol', () => {
  it('nomme les DEUX bouts, abreges, dans l ordre source puis cible', () => {
    expect(linkSummaryLabel('GigabitEthernet0/1', 'FastEthernet0/3'))
      .toBe('Gi0/1 ⟷ Fa0/3');
  });

  it('laisse tel quel un nom qu il ne sait pas abreger', () => {
    expect(linkSummaryLabel('port1', 'lan2')).toBe('port1 ⟷ lan2');
  });
});

describe('un faisceau : une pastille par voie, et elles ne se touchent pas', () => {
  const voies = (size: number) =>
    Array.from({ length: size }, (_, index) => bundleOffset({ index, size }));

  it('deux cables entre les memes equipements laissent passer une pastille entiere', () => {
    const [a, b] = voies(2);
    expect(Math.abs(b - a)).toBeGreaterThanOrEqual(TAG_HEIGHT + 2);
  });

  it('jusqu a cinq cables, deux voies voisines restent assez ecartees', () => {
    for (let size = 2; size <= 5; size++) {
      const offsets = voies(size);
      for (let i = 1; i < offsets.length; i++) {
        expect(Math.abs(offsets[i] - offsets[i - 1])).toBeGreaterThanOrEqual(TAG_HEIGHT + 2);
      }
    }
  });

  it('un faisceau large se comprime plutot que de se detacher de la carte', () => {
    for (let size = 2; size <= 8; size++) {
      for (const offset of voies(size)) {
        expect(Math.abs(offset)).toBeLessThanOrEqual(NODE_HALF_HEIGHT + 6);
      }
    }
  });

  it('les pastilles d un faisceau sortent toutes a la MEME distance de la carte', () => {
    const gauche = { x: 100, y: 200 };
    const droite = { x: 500, y: 200 };
    const xs = [0, 1, 2].map(
      index => computeInterfaceLabelPositions(gauche, droite, { index, size: 3 }).source.x);
    expect(new Set(xs.map(x => x.toFixed(4))).size).toBe(1);
  });

  it('chaque pastille reste centree sur SA voie', () => {
    const gauche = { x: 100, y: 200 };
    const droite = { x: 500, y: 200 };
    for (const index of [0, 1, 2]) {
      const slot = { index, size: 3 };
      const points = computeOrthogonalPoints(gauche, droite, slot);
      const position = computeInterfaceLabelPositions(gauche, droite, slot);
      expect(position.source.y).toBeCloseTo(points[0].y, 5);
    }
  });

  it('et deux pastilles voisines ne se recouvrent donc jamais', () => {
    const gauche = { x: 100, y: 200 };
    const droite = { x: 500, y: 200 };
    const ys = [0, 1].map(
      index => computeInterfaceLabelPositions(gauche, droite, { index, size: 2 }).source.y);
    expect(Math.abs(ys[1] - ys[0])).toBeGreaterThanOrEqual(TAG_HEIGHT);
  });
});
