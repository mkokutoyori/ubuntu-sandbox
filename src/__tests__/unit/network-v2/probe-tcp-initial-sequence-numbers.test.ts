/**
 * Le numero de sequence initial suit l'horloge de 4 microsecondes et une
 * fonction a cle des quatre elements de la connexion.
 *
 * Mesure de depart (9883a6d5b) : `nextIsn()` rendait `Date.now() XOR
 * Math.random()` — du hasard, sans horloge. Deux ouvertures du MEME
 * quadruplet a une seconde d'ecart differaient de 376 355 906 (ouverture
 * active) et 1 408 559 482 (ouverture passive) au lieu des 250 000 pas de
 * quatre microsecondes qu'une seconde represente : une reincarnation de la
 * connexion pouvait donc reprendre en arriere du numero de la precedente,
 * ce que l'horloge existe pour interdire.
 *
 * Autorite : RFC 9293 §3.4.1 (« A TCP implementation MUST use the above
 * type of clock for clock-driven selection of initial sequence numbers
 * (MUST-8), and SHOULD generate its initial sequence numbers with the
 * expression ISN = M + F(localip, localport, remoteip, remoteport,
 * secretkey) ... F() MUST NOT be computable from the outside (MUST-9) »),
 * et RFC 6528 §3 (meme expression ; « the secret key should be of a
 * reasonable length. Key lengths of 128 bits should be adequate »).
 *
 * Ce qui est construit : `IsnGenerator`. M est l'horloge de la machine
 * (`scheduler.now()`, une milliseconde valant 250 pas) ; F est un HMAC-SHA256
 * (`src/crypto/mac`, deja la, et verifie contre les vecteurs publies) de
 * `localip|localport|remoteip|remoteport` sous une cle de 128 bits tiree une
 * fois a la creation de la pile — le cas « amorcage du systeme » de la RFC
 * 6528 ; la cle n'est jamais renouvelee, ce qui ecarte le risque que la RFC
 * decrit pour un changement de cle (un ISN qui reculerait pour une
 * connexion reincarnee). Les sondes SYN que forge un balayeur gardent un
 * numero aleatoire (`randomSequenceNumber`) : ce n'est pas un ISN.
 *
 * Discrimination (fichier copie sur 9883a6d5b) : DEUX cas sur cinq tombent,
 * les deux mesures d'horloge. Les TROIS autres passent des deux cotes : le
 * TEMOIN (le SYN porte bien un numero) et deux cas STRUCTURELS — deux
 * quadruplets au meme instant, deux machines sur le meme quadruplet — qu'un
 * tirage aleatoire satisfait aussi ; ils ne prouvent pas la cle, ils
 * gardent que le generateur n'est pas devenu constant.
 */
import { describe, it, expect } from 'vitest';
import {
  scriptedPeer, PEER_ADDRESS, PEER_ISN, type ScriptedPeer,
} from '../../support/tcpScriptedPeer';
import { PortNumber } from '@/network/core/ports/PortNumber';

const FOUR_MICROSECOND_TICKS_PER_SECOND = 250_000;

function activeIsn(peer: ScriptedPeer, remotePort = peer.ports.peer): number {
  const socket = peer.dut.getTcpStack().connect(
    PEER_ADDRESS, remotePort, { localPort: PortNumber.of(50_000) })!;
  const isn = peer.last()!.sequence;
  socket.abort();
  peer.clear();
  return isn;
}

function passiveIsn(peer: ScriptedPeer): number {
  peer.send({ flags: 'S', sequence: PEER_ISN });
  const isn = peer.last()!.sequence;
  peer.send({ flags: 'R', sequence: PEER_ISN + 1 });
  peer.clear();
  return isn;
}

describe('the initial sequence number follows RFC 9293 §3.4.1 and RFC 6528 §3', () => {
  it('WITNESS: an active open puts its ISN on the wire in the SYN', () => {
    const peer = scriptedPeer();
    peer.dut.getTcpStack().connect(PEER_ADDRESS, peer.ports.peer);
    expect(peer.replies.length).toBe(1);
    expect(peer.last()!.flags.syn).toBe(true);
  });

  it('the same four-tuple one second later starts exactly 250 000 four-microsecond ticks further on (active open)', () => {
    const peer = scriptedPeer();
    const first = activeIsn(peer);
    peer.advance(1_000);
    const second = activeIsn(peer);
    expect(((second - first) >>> 0)).toBe(FOUR_MICROSECOND_TICKS_PER_SECOND);
  });

  it('the same four-tuple one second later starts exactly 250 000 ticks further on (passive open)', () => {
    const peer = scriptedPeer();
    peer.dut.getTcpStack().listen(peer.ports.dut, { onAccept: () => undefined });
    const first = passiveIsn(peer);
    peer.advance(1_000);
    const second = passiveIsn(peer);
    expect(((second - first) >>> 0)).toBe(FOUR_MICROSECOND_TICKS_PER_SECOND);
  });

  it('STRUCTURAL: two four-tuples opened at the same instant do not share an ISN', () => {
    const peer = scriptedPeer();
    const first = activeIsn(peer, 40_000);
    const second = activeIsn(peer, 40_001);
    expect(second).not.toBe(first);
  });

  it('STRUCTURAL: the function of the four-tuple is keyed — two machines disagree on the same tuple', () => {
    const first = activeIsn(scriptedPeer());
    const second = activeIsn(scriptedPeer());
    expect(second).not.toBe(first);
  });
});
