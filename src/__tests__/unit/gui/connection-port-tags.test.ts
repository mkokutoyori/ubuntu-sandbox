/**
 * LA PRISE ET LA PASTILLE : les deux primitives de dessin d'un cable.
 *
 * Ce que la toile rendait avant, et le defaut qu'on a ferme : le nom
 * d'interface flottait A COTE du cable, en blanc, de la meme couleur
 * pour tous les liens, et rien ne disait ou le cable ENTRE dans la
 * carte.
 *
 * Il reste ici les deux primitives, qui sont de la geometrie et de la
 * typographie pures :
 *
 *  - LA PRISE : le point de sortie porte un trait court EN TRAVERS du
 *    cable, a l'endroit exact ou il quitte la carte. C'est ce qui dit
 *    « branche ICI ». Il tourne avec le cable ;
 *  - LA PASTILLE : sa largeur suit son texte, et son texte nomme les
 *    DEUX bouts du lien, abreges.
 *
 * OU la pastille se pose, c'est `cable-routing.test.ts` qui le tient :
 * ce n'est plus une distance fixe depuis la carte mais une consequence
 * du dessin de tous les cables ensemble.
 *
 * Sonde ecrite AVANT le correctif : 12 cas sur 13 tombaient.
 */
import { describe, it, expect } from 'vitest';
import {
  computeEndpointAnchors,
  interfaceTagWidth,
  linkSummaryLabel,
  connectorSegment,
  computeOrthogonalPoints,
  CONNECTOR_HALF_LENGTH,
} from '@/components/network/connection-line-logic';

const GAUCHE = { x: 100, y: 200 };
const DROITE = { x: 400, y: 200 };
const HAUT = { x: 200, y: 100 };
const BAS = { x: 200, y: 400 };

const anchorsOf = (from: { x: number; y: number }, to: { x: number; y: number }) =>
  computeEndpointAnchors(computeOrthogonalPoints(from, to));

describe('la prise : ou le cable entre dans la carte', () => {
  it('l ancre est le point ou le trace quitte la carte', () => {
    const points = computeOrthogonalPoints(GAUCHE, DROITE);
    const ancres = computeEndpointAnchors(points);
    expect(ancres.source.point).toEqual(points[0]);
    expect(ancres.target.point).toEqual(points[points.length - 1]);
  });

  it('la direction pointe vers le cable, pas vers la carte', () => {
    const ancres = anchorsOf(GAUCHE, DROITE);
    expect(ancres.source.direction.x).toBeCloseTo(1, 5);
    expect(ancres.source.direction.y).toBeCloseTo(0, 5);
    expect(ancres.target.direction.x).toBeCloseTo(-1, 5);
    expect(ancres.target.direction.y).toBeCloseTo(0, 5);
  });

  it('elle pointe vers le BAS quand le cable descend', () => {
    const ancres = anchorsOf(HAUT, BAS);
    expect(ancres.source.direction.y).toBeCloseTo(1, 5);
    expect(ancres.source.direction.x).toBeCloseTo(0, 5);
  });

  it('la prise est TRAVERS le cable, et centree sur lui', () => {
    const ancre = anchorsOf(GAUCHE, DROITE).source;
    const prise = connectorSegment(ancre);
    expect(prise.a.x).toBeCloseTo(ancre.point.x, 5);
    expect(prise.b.x).toBeCloseTo(ancre.point.x, 5);
    expect(prise.a.y).toBeCloseTo(ancre.point.y - CONNECTOR_HALF_LENGTH, 5);
    expect(prise.b.y).toBeCloseTo(ancre.point.y + CONNECTOR_HALF_LENGTH, 5);
  });

  it('et elle tourne avec le cable : verticale, elle devient horizontale', () => {
    const ancre = anchorsOf(HAUT, BAS).source;
    const prise = connectorSegment(ancre);
    expect(prise.a.y).toBeCloseTo(ancre.point.y, 5);
    expect(prise.b.y).toBeCloseTo(ancre.point.y, 5);
    expect(Math.abs(prise.a.x - prise.b.x)).toBeCloseTo(CONNECTOR_HALF_LENGTH * 2, 5);
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

  it('et une pastille qui nomme les deux bouts est plus large qu un seul', () => {
    expect(interfaceTagWidth(linkSummaryLabel('GigabitEthernet0/1', 'eth0')))
      .toBeGreaterThan(interfaceTagWidth('Gi0/1'));
  });
});

describe('le texte de la pastille nomme les deux bouts', () => {
  it('abrege chacun d eux, dans l ordre donne', () => {
    expect(linkSummaryLabel('GigabitEthernet0/1', 'FastEthernet0/3'))
      .toBe('Gi0/1 ⟷ Fa0/3');
  });

  it('laisse tel quel un nom qu il ne sait pas abreger', () => {
    expect(linkSummaryLabel('port1', 'lan2')).toBe('port1 ⟷ lan2');
  });
});
