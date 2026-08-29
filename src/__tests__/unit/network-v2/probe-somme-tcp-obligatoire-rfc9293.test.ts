/**
 * La somme de controle TCP n'est JAMAIS facultative — et c'est la regle
 * INVERSE de celle d'UDP, ce qui est tout l'interet de ce lot.
 *
 * CONTEXTE. Le lot precedent a applique a UDP la regle de la RFC 768 :
 * une somme calculee a zero part en 0xFFFF, parce que 0x0000 est RESERVE
 * pour dire « je n'ai pas calcule de somme ». La tentation etait
 * d'appliquer la meme chose a TCP. Ce serait FAUX, et la RFC 9293 le dit
 * en une phrase : « The TCP checksum is never optional. The sender
 * generates it and the receiver checks it. » TCP n'a pas de sentinelle
 * d'absence — un zero calcule est un zero legitime, qui se transmet tel
 * quel et se verifie comme n'importe quelle autre valeur.
 *
 * LE DEFAUT MESURE etait donc a l'autre bout : `verifyTcpChecksum`
 * sortait par `if (seg.checksum === 0) return true`, c'est-a-dire
 * qu'elle traitait zero comme « non calculee » — la convention d'UDP,
 * importee dans un protocole qui ne l'a pas. Consequence : tout segment
 * dont le champ de somme vaut zero traversait sans etre verifie, que ce
 * zero vienne d'une corruption, d'une troncature ou d'un injecteur.
 * Le commentaire invoquait le « checksum offload », qui est une raison
 * reelle pour une CARTE de ne pas calculer a l'emission, mais pas une
 * raison pour une PILE de ne pas verifier a la reception.
 *
 * PORTEE MESUREE AVANT DE TOUCHER : les seuls constructeurs de segments
 * du depot sont les deux de `TcpStack` (lignes 1274 et 1325), et tous
 * deux tamponnent une vraie somme a la ligne suivante. Le `checksum: 0`
 * n'y est qu'un initialisateur. Retirer le raccourci ne pouvait donc
 * casser aucun emetteur legitime, ce que les 243 fichiers / 3712 cas des
 * suites TCP, HTTP, SSH, FTP, telnet et NAT confirment.
 *
 * DISCRIMINATION (`git stash` sur `tcp/types.ts`) : UN seul cas des 6
 * tombe — « un segment dont la somme a ete mise a ZERO est refuse » — et
 * c'est exact plutot que maigre : le defaut tenait en une ligne de sortie
 * anticipee, donc seul le cas qui observe un REFUS peut tomber.
 *
 * Les 5 autres se repartissent en deux familles, et la seconde est la
 * raison d'etre de ce fichier :
 *  - les TEMOINS (somme juste acceptee, corruption detectee) gardent que
 *    le correctif ne refuse pas tout.
 *  - « TCP peut legitimement calculer une somme nulle, et elle se
 *    verifie » passe des deux cotes POUR DES RAISONS OPPOSEES : avant,
 *    par la sortie anticipee ; apres, parce que 0 === 0. C'est lui qui
 *    empeche la faute symetrique — appliquer a TCP la regle 0 -> 0xFFFF
 *    d'UDP ferait echouer ce cas, et le correctif serait alors pire que
 *    le defaut, puisqu'il rejetterait un segment parfaitement valide.
 */

import { describe, it, expect } from 'vitest';
import {
  computeTcpChecksum, verifyTcpChecksum, type TcpSegment,
} from '@/network/tcp/types';
import { computeUdpChecksum } from '@/network/layers/transport/UdpChecksum';

const SRC = '10.0.0.1';
const DST = '10.0.0.2';

function segment(payload: string, checksum = 0): TcpSegment {
  return {
    sourcePort: 1234, destinationPort: 80,
    sequence: 1000, acknowledgement: 0,
    dataOffset: 5,
    flags: { fin: false, syn: true, rst: false, psh: false,
      ack: false, urg: false, ece: false, cwr: false },
    window: 65535, checksum, urgentPointer: 0, payload,
  } as TcpSegment;
}

/** Cherche une charge dont la somme TCP vaut reellement 0x0000. */
function chargeASommeNulle(): string | null {
  for (let a = 0; a < 256; a++) {
    for (let b = 0; b < 256; b++) {
      const charge = String.fromCharCode(a) + String.fromCharCode(b);
      if (computeTcpChecksum(segment(charge), SRC, DST) === 0) return charge;
    }
  }
  return null;
}

describe('RFC 9293 — la somme TCP se verifie toujours', () => {
  it('un segment dont la somme a ete mise a ZERO est refuse', () => {
    const bon = segment('bonjour');
    const somme = computeTcpChecksum(bon, SRC, DST);
    expect(somme).not.toBe(0);
    expect(verifyTcpChecksum(segment('bonjour', 0), SRC, DST)).toBe(false);
  });

  it('une corruption de la charge est detectee', () => {
    const somme = computeTcpChecksum(segment('bonjour'), SRC, DST);
    expect(verifyTcpChecksum(segment('bonjovr', somme), SRC, DST)).toBe(false);
  });

  it('TEMOIN — une somme JUSTE est acceptee', () => {
    const somme = computeTcpChecksum(segment('bonjour'), SRC, DST);
    expect(verifyTcpChecksum(segment('bonjour', somme), SRC, DST)).toBe(true);
  });
});

describe('et la regle d\'UDP ne DOIT PAS y etre importee', () => {
  it('TCP peut legitimement calculer une somme nulle, et elle se verifie', () => {
    const charge = chargeASommeNulle();
    expect(charge).not.toBeNull();
    if (charge === null) return;
    expect(computeTcpChecksum(segment(charge), SRC, DST)).toBe(0);
    expect(verifyTcpChecksum(segment(charge, 0), SRC, DST)).toBe(true);
  });

  it('la ou UDP, lui, ne rend JAMAIS zero', () => {
    const charge = String.fromCharCode(208) + String.fromCharCode(215);
    expect(computeUdpChecksum(
      { sourcePort: 1234, destinationPort: 5678, payload: charge }, SRC, DST))
      .toBe(0xffff);
  });

  it('les deux protocoles ne partagent donc pas la meme sentinelle', () => {
    const charge = chargeASommeNulle();
    if (charge === null) return;
    const tcp = computeTcpChecksum(segment(charge), SRC, DST);
    const udp = computeUdpChecksum(
      { sourcePort: 1234, destinationPort: 5678, payload: charge }, SRC, DST);
    expect(tcp).toBe(0);
    expect(udp).not.toBe(0);
  });
});
