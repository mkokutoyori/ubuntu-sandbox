/**
 * La somme de controle UDP suit la RFC 768 a l'emission et la RFC 8200
 * a la reception — evaluation de la couche transport du BRD.
 *
 * CONTEXTE : la couche transport de la phase 4 a rassemble en un lieu
 * une somme qui vivait dans `tcp/types.ts`. Le rassemblement est juste,
 * et deux regles du protocole manquaient au corps rassemble. Elles sont
 * MESUREES ci-dessous, pas deduites de la lecture.
 *
 * (1) RFC 768, l'emission. « If the computed checksum is zero, it is
 *     transmitted as all ones (the equivalent in one's complement
 *     arithmetic). An all zero transmitted checksum value means that the
 *     transmitter generated no checksum. » Autrement dit 0x0000 et
 *     0xFFFF sont le meme nombre en complement a un, mais 0x0000 est
 *     RESERVE pour dire « je n'en ai pas calcule ». `computeUdpChecksum`
 *     rendait 0 tel quel.
 *     **Mesure** : la charge de deux octets (208, 215), entre les ports
 *     1234 et 5678, de 10.0.0.1 vers 10.0.0.2, produit exactement
 *     0x0000. Ce n'est donc pas un cas theorique — un datagramme qui
 *     PORTE une somme partait en annoncant qu'il n'en avait pas, et le
 *     recepteur sautait la verification. Toute corruption de ce
 *     datagramme devenait invisible.
 *
 * (2) RFC 8200 §8.1, la reception. En IPv4 la somme UDP est FACULTATIVE
 *     et un 0 recu veut dire « non calculee » ; en IPv6 elle est
 *     OBLIGATOIRE, et un recepteur DOIT jeter un datagramme UDP a somme
 *     nulle (les exceptions de la RFC 6935/6936 ne visent que des
 *     tunnels). `verifyUdpChecksum` rendait `true` pour une somme nulle
 *     quelle que soit la famille d'adresses.
 *     **Mesure** : `verifyUdpChecksum({... checksum: 0}, '2001:db8::1',
 *     '2001:db8::2')` rendait `true`.
 *
 * CE QUI N'EST PAS FERME ICI, et qui est mesure plutot que suppose :
 * `sendUdpDatagram6` pose `checksum: 0` en dur et `deliverUDP6` ne
 * verifie RIEN, pas plus que les quatre autres constructeurs de
 * datagrammes UDP sur IPv6 (le client DHCPv6 de `EndHost`, les trois
 * points de `IPv6DataPlane`). La somme UDP est donc, sur IPv6,
 * entierement absente dans les deux sens — l'inverse exact de ce que la
 * RFC 8200 exige, et l'inverse de ce que fait la moitie IPv4 du meme
 * fichier. Inscrit au `TODO.md` : fermer demande de calculer aux cinq
 * points d'emission AVANT de verifier a la reception, sans quoi tout le
 * trafic DHCPv6 tomberait.
 *
 * DISCRIMINATION (`git stash` sur `UdpChecksum.ts`) : 3 des 8 cas
 * tombent, et le troisieme est celui qui compte.
 *  - « la charge qui annulerait la somme rend 0xFFFF » : le defaut nu.
 *  - « une somme nulle recue sur IPv6 est refusee » : le second defaut.
 *  - « une corruption de cette meme charge est DETECTEE » : la
 *    CONSEQUENCE. Avant correctif elle passait inapercue, parce que la
 *    somme avait ete emise a 0, c'est-a-dire « je n'en ai pas calcule »,
 *    et le recepteur ne verifiait donc rien. C'est ce cas qui dit
 *    pourquoi la regle de la RFC existe.
 * Les 5 autres passent des deux cotes et le doivent : ce sont les
 * TEMOINS (charge ordinaire, somme juste sur chaque famille, somme nulle
 * licite en IPv4) et la distinction des deux pseudo-en-tetes. Sans eux,
 * rendre 0xFFFF pour TOUT, ou refuser TOUTE somme nulle, passerait.
 */

import { describe, it, expect } from 'vitest';
import {
  computeUdpChecksum, verifyUdpChecksum,
} from '@/network/layers/transport/UdpChecksum';

const V4 = ['10.0.0.1', '10.0.0.2'] as const;
const V6 = ['2001:db8::1', '2001:db8::2'] as const;

function datagramme(payload: unknown) {
  return { sourcePort: 1234, destinationPort: 5678, payload };
}

/** La charge dont la somme brute vaut 0x0000, trouvee par balayage. */
const CHARGE_A_SOMME_NULLE = String.fromCharCode(208) + String.fromCharCode(215);

describe('RFC 768 — une somme calculee a zero part en tout-un', () => {
  it('la charge qui annulerait la somme rend 0xFFFF, jamais 0', () => {
    expect(computeUdpChecksum(datagramme(CHARGE_A_SOMME_NULLE), ...V4))
      .toBe(0xffff);
  });

  it('et 0xFFFF se verifie, donc la protection n\'est pas perdue', () => {
    const somme = computeUdpChecksum(datagramme(CHARGE_A_SOMME_NULLE), ...V4);
    expect(verifyUdpChecksum(
      { ...datagramme(CHARGE_A_SOMME_NULLE), checksum: somme }, ...V4)).toBe(true);
  });

  it('une corruption de cette meme charge est DETECTEE', () => {
    const somme = computeUdpChecksum(datagramme(CHARGE_A_SOMME_NULLE), ...V4);
    const abimee = String.fromCharCode(209) + String.fromCharCode(215);
    expect(verifyUdpChecksum({ ...datagramme(abimee), checksum: somme }, ...V4))
      .toBe(false);
  });

  it('TEMOIN — une charge ordinaire garde sa somme', () => {
    const somme = computeUdpChecksum(datagramme('bonjour'), ...V4);
    expect(somme).not.toBe(0);
    expect(verifyUdpChecksum({ ...datagramme('bonjour'), checksum: somme }, ...V4))
      .toBe(true);
  });
});

describe('RFC 8200 §8.1 — en IPv6 la somme est OBLIGATOIRE', () => {
  it('une somme nulle recue sur IPv6 est refusee', () => {
    expect(verifyUdpChecksum({ ...datagramme('abc'), checksum: 0 }, ...V6))
      .toBe(false);
  });

  it('mais une somme JUSTE sur IPv6 est acceptee', () => {
    const somme = computeUdpChecksum(datagramme('abc'), ...V6);
    expect(verifyUdpChecksum({ ...datagramme('abc'), checksum: somme }, ...V6))
      .toBe(true);
  });

  it('TEMOIN IPv4 — la somme nulle y reste licite, RFC 768', () => {
    expect(verifyUdpChecksum({ ...datagramme('abc'), checksum: 0 }, ...V4))
      .toBe(true);
  });

  it('les deux familles ne calculent pas la meme somme', () => {
    expect(computeUdpChecksum(datagramme('abc'), ...V4))
      .not.toBe(computeUdpChecksum(datagramme('abc'), ...V6));
  });
});
