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
 * ── Ce qui est reel et ce qui ne l'est pas, tenus separes ───────────
 *
 * REEL : la disposition des 48 octets, l'ordre gros-boutien, le format
 * a virgule fixe 16.16 du delai et de la dispersion, le format 32.32 des
 * horodatages depuis le 1er janvier 1900, et le condensé lui-meme.
 *
 * PAS REEL, et dit ici plutot qu'ailleurs : le reste du simulateur ne
 * serialise PAS les paquets NTP en octets — ils voyagent comme objets.
 * Cet en-tete est donc fabrique au moment de signer et de verifier, aux
 * deux bouts, a partir des memes champs. La consequence est qu'un
 * condensé calcule ici n'est pas comparable a celui d'un vrai `ntpd` sur
 * un vrai reseau ; il est en revanche exact ENTRE deux machines de ce
 * simulateur, ce qui est ce qu'un laboratoire verifie.
 *
 * La resolution des horodatages est la milliseconde, celle que porte
 * `NtpPacket` : les 32 bits de fraction sont donc remplis depuis une
 * milliseconde, pas depuis une picoseconde. Signer une precision que le
 * paquet ne porte pas n'ajouterait rien.
 */

import { md5, sha1 } from '@/crypto';
import type { NtpPacket, NtpMode } from './types';

/** Le decalage entre l'epoque NTP (1900) et l'epoque Unix (1970), en secondes. */
const EPOQUE_NTP_SEC = 2208988800;

/** Les modes NTP, dans la numerotation du fil (RFC 5905 §7.3). */
const NUM_MODE: Record<NtpMode, number> = {
  'symmetric-active': 1,
  'symmetric-passive': 2,
  client: 3,
  server: 4,
};

/**
 * Un identifiant de reference tient sur QUATRE octets.
 *
 * Une adresse IPv4 y entre telle quelle ; un code de strate 1 comme
 * `LOCL` ou `.INIT.` y entre en ASCII, complete de zeros — c'est ce que
 * fait un vrai serveur, et c'est pourquoi ces codes font quatre lettres.
 */
function refIdentifierEnOctets(ref: string, sortie: DataView, position: number): void {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ref);
  if (v4) {
    for (let i = 0; i < 4; i++) sortie.setUint8(position + i, parseInt(v4[i + 1], 10) & 0xff);
    return;
  }
  const propre = ref.replace(/^\.|\.$/g, '');
  for (let i = 0; i < 4; i++) {
    sortie.setUint8(position + i, i < propre.length ? propre.charCodeAt(i) & 0xff : 0);
  }
}

/**
 * Un horodatage NTP : 32 bits de secondes depuis 1900, puis 32 bits de
 * fraction. Une valeur nulle reste nulle — c'est ainsi qu'un paquet dit
 * « ce champ n'est pas rempli », et l'ecrire comme 1900 serait une date.
 */
function horodatageEnOctets(ms: number, sortie: DataView, position: number): void {
  if (!ms) { sortie.setUint32(position, 0); sortie.setUint32(position + 4, 0); return; }
  const sec = Math.floor(ms / 1000) + EPOQUE_NTP_SEC;
  const fraction = Math.floor(((ms % 1000) / 1000) * 0x100000000);
  sortie.setUint32(position, sec >>> 0);
  sortie.setUint32(position + 4, fraction >>> 0);
}

/** Une duree en millisecondes vers le format a virgule fixe 16.16 de NTP. */
function dureeVirguleFixe(ms: number): number {
  return Math.round((ms / 1000) * 0x10000) & 0xffffffff;
}

/**
 * Les 48 octets d'en-tete que NTP signe.
 *
 * L'identifiant de cle et le condensé n'en font PAS partie : ils sont
 * ce qui suit, et un condensé qui se couvrirait lui-meme n'aurait aucun
 * sens.
 */
export function serialiserEnteteNtp(pkt: NtpPacket): Uint8Array {
  const octets = new Uint8Array(48);
  const vue = new DataView(octets.buffer);
  vue.setUint8(0, ((pkt.leapIndicator & 0x3) << 6) | ((pkt.version & 0x7) << 3) | (NUM_MODE[pkt.mode] & 0x7));
  vue.setUint8(1, pkt.stratum & 0xff);
  vue.setUint8(2, pkt.poll & 0xff);
  // La precision est un exposant SIGNE : `-20` s'ecrit sur un octet en
  // complement a deux, et le poser non signe changerait le condensé.
  vue.setInt8(3, pkt.precision);
  vue.setUint32(4, dureeVirguleFixe(pkt.rootDelay) >>> 0);
  vue.setUint32(8, dureeVirguleFixe(pkt.rootDispersion) >>> 0);
  refIdentifierEnOctets(pkt.refIdentifier ?? '', vue, 12);
  horodatageEnOctets(pkt.refTimestampMs, vue, 16);
  horodatageEnOctets(pkt.origTimestampMs, vue, 24);
  horodatageEnOctets(pkt.rxTimestampMs, vue, 32);
  horodatageEnOctets(pkt.txTimestampMs, vue, 40);
  return octets;
}

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
export const CONDENSES_NTP = ['MD5', 'SHA1'] as const;
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
  const entete = serialiserEnteteNtp(pkt);
  const cleOctets = cleEnOctets(cle);
  const entree = new Uint8Array(cleOctets.length + entete.length);
  entree.set(cleOctets, 0);
  entree.set(entete, cleOctets.length);
  const brut = algo.toUpperCase() === 'SHA1' ? sha1(entree) : md5(entree);
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
