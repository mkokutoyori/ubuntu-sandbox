/**
 * PRD-NTP-Tutoriel.md §7 / lot N5 — le condensé d'authentification NTP.
 *
 * ── Le defaut, mesure ───────────────────────────────────────────────
 *
 * `checkAuthentication` ne regardait que le NUMERO de clé. Trois
 * laboratoires, un client et un serveur `ntp master 2` sur un vrai
 * cable :
 *
 * | Configuration          | Attendu | Mesure       |
 * |------------------------|---------|--------------|
 * | Memes cles             | synchro | synchro      |
 * | Cles DIFFERENTES       | REJET   | synchro      |
 * | Client SANS aucune cle | REJET   | synchro      |
 *
 * Le troisieme cas dit tout : il suffisait d'ecrire `ntp server X key 1`
 * — de NOMMER un numero — pour etre accepte. **Nommer une cle suffisait,
 * connaitre son secret n'etait pas requis.** C'est exactement
 * l'usurpation contre laquelle la commande existe.
 *
 * ── Ce que ce module fait, et pourquoi c'est reel ───────────────────
 *
 * NTP ne signe pas « la cle » ni « le paquet » au sens vague. RFC 5905
 * §7.3 le dit mot pour mot : le condensé est un
 * « 128-bit MD5 hash computed over the key followed by the NTP packet
 * header and extension fields (but not the Key Identifier or Message
 * Digest fields) ». La cle PRECEDE l'en-tete de 48 octets, et ni le
 * numero de cle ni le condensé lui-meme ne sont couverts :
 *
 * **Reference verifiee, et une erreur corrigee au passage** : la
 * premiere version de ce fichier citait RFC 1305 annexe C. C'est faux —
 * RFC 5905 precise que « the MAC computation used here differs from
 * those defined in [RFC1305] and [RFC4330] but is consistent with how
 * existing implementations generate a MAC ». C'est donc la construction
 * de RFC 5905 qui est implementee, celle des implementations reelles.
 *
 * ```
 *     MAC = MD5( cle ‖ en-tete_48_octets )
 * ```
 *
 * Ce fichier fabrique donc **un vrai en-tete de 48 octets** a partir des
 * champs du paquet, et le signe avec le `md5` du depot, qui est reel
 * (`src/crypto/hash/md5.ts`, celui que `openssl dgst -md5` emprunte).
 * Le condensé n'est pas une valeur plausible : il DEPEND de chaque
 * champ signe, ce qui est la seule propriete qui compte — changer un
 * horodatage, une strate ou la cle change le resultat.
 *
 * Les paquets voyagent desormais en octets (voir `wire.ts`) : le condensé
 * couvre les octets exacts recus, en-tete et champs d'extension, et non une
 * reserialisation des champs decodes. Il est donc comparable a celui d'un
 * vrai `chronyd` ou `ntpd` pour MD5 et SHA1, ce que le test d'oracle verifie.
 */

import { md5, sha1, sha256 } from '@/crypto';
import type { NtpPacket } from './types';
import { signedOctets } from './wire';

export const serialiserEnteteNtp = signedOctets;

/**
 * Les octets d'une cle, telle que l'operateur l'a tapee.
 *
 * Le prefixe `HEX:` est celui du fichier de cles de chrony, et il ne
 * decore pas : une cle produite par `chronyc keygen` est une suite
 * d'octets ALEATOIRES, dont beaucoup ne sont pas des caracteres. La lire
 * comme du texte donnerait un condensé calcule sur les lettres `4`, `1`,
 * `3`… au lieu des octets qu'elles notent, donc deux machines portant la
 * meme cle ne s'authentifieraient pas.
 */
function cleEnOctets(cle: string): Uint8Array {
  if (/^HEX:[0-9a-fA-F]*$/.test(cle) && (cle.length - 4) % 2 === 0) {
    const hexa = cle.slice(4);
    const octets = new Uint8Array(hexa.length / 2);
    for (let i = 0; i < octets.length; i++) octets[i] = parseInt(hexa.substr(i * 2, 2), 16);
    return octets;
  }
  const octets = new Uint8Array(cle.length);
  for (let i = 0; i < cle.length; i++) octets[i] = cle.charCodeAt(i) & 0xff;
  return octets;
}

/**
 * Les fonctions de condensé qu'une cle peut nommer.
 *
 * MD5 est celle d'IOS et de VRP, qui n'en proposent pas d'autre pour
 * NTP. SHA1 est indispensable cote Linux pour une raison concrete :
 * **`chronyc keygen` produit une cle SHA1 par defaut**, donc s'en tenir
 * a MD5 rendrait inutilisable la cle que la commande de generation vient
 * elle-meme d'ecrire.
 *
 * AES128 et AES256, que le fichier de cles de chrony accepte aussi, ne
 * sont PAS ici : ce ne sont pas des condensés mais des CMAC (RFC 8573),
 * une construction differente que ce depot n'a pas. Les accepter en les
 * calculant comme un condensé donnerait une valeur qu'aucune vraie
 * machine ne reconnaitrait.
 */
export const CONDENSES_NTP = ['MD5', 'SHA1', 'SHA256'] as const;
export type CondenseNtp = (typeof CONDENSES_NTP)[number];

export function estCondenseNtp(mot: string): mot is CondenseNtp {
  return (CONDENSES_NTP as readonly string[]).includes(mot.toUpperCase());
}

/**
 * `CONDENSE(cle ‖ en-tete)`, en hexadecimal — celui de RFC 5905 §7.3.
 *
 * La cle PRECEDE l'en-tete, elle ne le suit pas : c'est la construction
 * de NTP, distincte de HMAC, et l'inverser donnerait un condensé qui ne
 * correspondrait a rien.
 */
export function calculerMacNtp(cle: string, pkt: NtpPacket, algo: string = 'MD5'): string {
  const entete = pkt.signedBytes ?? signedOctets(pkt);
  const cleOctets = cleEnOctets(cle);
  const entree = new Uint8Array(cleOctets.length + entete.length);
  entree.set(cleOctets, 0);
  entree.set(entete, cleOctets.length);
  const nom = algo.toUpperCase();
  const brut = nom === 'SHA256' ? sha256(entree) : nom === 'SHA1' ? sha1(entree) : md5(entree);
  return [...brut].map((o) => o.toString(16).padStart(2, '0')).join('');
}

/**
 * Verifier le condensé porte par un paquet.
 *
 * La comparaison est faite sur la CHAINE complete plutot que champ par
 * champ, et elle est volontairement simple : ce simulateur n'est pas une
 * bibliotheque de securite et ne pretend pas resister a une attaque
 * temporelle — la convention du depot pour toute sa cryptographie.
 */
export function verifierMacNtp(
  cle: string, pkt: NtpPacket, mac: string | undefined, algo: string = 'MD5',
): boolean {
  if (!mac) return false;
  return calculerMacNtp(cle, pkt, algo) === mac;
}
