/**
 * PRD-NTP-Tutoriel.md §12 / lot N10 — `/etc/chrony/chrony.keys`, lu.
 *
 * ── Le defaut ───────────────────────────────────────────────────────
 *
 * `keyfile` etait analyse, range dans `ChronyConf.keyfile`, et **lu par
 * personne** — l'en-tete de `ChronyConfig.ts` allait jusqu'a le ranger
 * parmi les directives « LUES et agissantes », ce qui etait faux. La
 * consequence n'est pas cosmetique : `server 10.0.0.1 key 1` transmettait
 * bien le numero de cle a l'agent, mais **aucun secret n'existait
 * derriere ce numero**, donc le paquet partait avec un identifiant de
 * cle et sans condensé — la forme exacte qu'un serveur rejette. Une
 * machine Linux ne pouvait donc PAS authentifier NTP, alors que Cisco et
 * Huawei le font depuis le lot N5, et que le fichier que Debian installe
 * nomme lui-meme ce fichier de cles.
 *
 * ── Le format, verifie sur le fichier d'exemple du projet ───────────
 *
 * `chrony.keys.example`, livre avec chrony :
 *
 * ```
 * #1 MD5 AVeryLongAndRandomPassword
 * #2 MD5 HEX:12114855C7931009B4049EF3EFC48A139C3F989F
 * #3 SHA1 HEX:B2159C05D6A219673A3B7E896B6DE07F6A440995
 * #4 AES128 HEX:2DA837C4B6573748CA692B8C828E4891
 * #5 AES256 HEX:2666B8099BFF2D5BA20876121788ED24D2BE59111B8FFB562F0F56AE6EC7246E
 * ```
 *
 * Donc : un numero, une fonction, une cle — en clair ou en `HEX:`. La
 * forme historique a deux champs (`1 monsecret`, sans fonction) est
 * acceptee aussi, MD5 etant alors sous-entendu ; c'est celle qu'on
 * rencontre dans les fichiers anciens et dans beaucoup de tutoriels.
 *
 * ── Ce qui est refuse, et pourquoi c'est mieux que de l'accepter ────
 *
 * `AES128` et `AES256` sont de VRAIES entrees de ce fichier, et elles
 * sont refusees ici en NOMMANT la brique absente : ce ne sont pas des
 * condensés mais des CMAC (RFC 8573), une construction que ce depot n'a
 * pas. Les accepter en les calculant comme un condensé produirait une
 * valeur qu'aucune vraie machine ne reconnaitrait — un laboratoire
 * « qui marche » ici et nulle part ailleurs.
 */

import { estCondenseNtp } from '../../../ntp/auth';

/** Le chemin que le `chrony.conf` de Debian nomme. */
export const CHRONY_KEYS_PATH = '/etc/chrony/chrony.keys';

/**
 * Le fichier que le paquet Debian depose : des commentaires, et aucune
 * cle. C'est important qu'il soit VIDE de cles — chrony le dit
 * lui-meme, « Don't use the example keys! » — donc l'y mettre des cles
 * actives ferait de chaque machine de ce simulateur une machine dont le
 * secret est public.
 */
export const CHRONY_KEYS_DEBIAN = `# This is an example chrony keys file.  It enables authentication of NTP
# packets with symmetric keys when its location is specified by the keyfile
# directive in chrony.conf(5).  It should be readable only by root and the
# user under which chronyd is running.
#
# Don't use the example keys!  It's recommended to generate random keys using
# the chronyc keygen command.

# Examples of valid keys:

#1 MD5 AVeryLongAndRandomPassword
#2 MD5 HEX:12114855C7931009B4049EF3EFC48A139C3F989F
#3 SHA1 HEX:B2159C05D6A219673A3B7E896B6DE07F6A440995
`;

export interface ChronyKey {
  readonly id: number;
  /** `MD5` ou `SHA1` — la fonction reellement calculable ici. */
  readonly algo: string;
  /** La cle telle qu'ecrite, prefixe `HEX:` compris. */
  readonly cle: string;
}

export interface ChronyKeysLecture {
  readonly cles: readonly ChronyKey[];
  /** Les lignes refusees, avec la raison — chronyd les signale aussi. */
  readonly refusees: readonly { ligne: number; texte: string; raison: string }[];
}

const VIDE: ChronyKeysLecture = { cles: [], refusees: [] };

/**
 * Analyse le texte d'un `chrony.keys`.
 *
 * Une ligne fautive ne fait pas tomber le reste du fichier : c'est la
 * meme discipline que l'analyseur de `/etc/passwd` de ce depot, et pour
 * la meme raison — une faute de frappe ne doit pas priver la machine de
 * toutes ses cles.
 */
export function parseChronyKeys(texte: string): ChronyKeysLecture {
  const cles: ChronyKey[] = [];
  const refusees: { ligne: number; texte: string; raison: string }[] = [];
  const vus = new Set<number>();
  const lignes = texte.split('\n');
  for (let i = 0; i < lignes.length; i++) {
    const nue = lignes[i].replace(/[#!].*$/, '').trim();
    if (!nue) continue;
    const mots = nue.split(/\s+/);
    const id = /^\d+$/.test(mots[0]) ? parseInt(mots[0], 10) : NaN;
    // Le zero est reserve au crypto-NAK par RFC 5905, qui autorise
    // « 65 535 cles a l'exclusion de zero » : une cle numero zero rendrait
    // un refus indiscernable d'une authentification.
    if (isNaN(id) || id < 1 || id > 0xffffffff) {
      refusees.push({ ligne: i + 1, texte: nue, raison: 'invalid key ID' });
      continue;
    }
    let algo = 'MD5';
    let cle: string;
    if (mots.length >= 3) { algo = mots[1].toUpperCase(); cle = mots.slice(2).join(' '); }
    else if (mots.length === 2) { cle = mots[1]; }
    else { refusees.push({ ligne: i + 1, texte: nue, raison: 'missing key' }); continue; }
    if (!estCondenseNtp(algo)) {
      refusees.push({
        ligne: i + 1, texte: nue,
        raison: `unsupported hash function ${algo}`,
      });
      continue;
    }
    if (/^HEX:/i.test(cle) && !/^HEX:([0-9a-fA-F]{2})+$/.test(cle)) {
      refusees.push({ ligne: i + 1, texte: nue, raison: 'invalid hex key' });
      continue;
    }
    // Un numero repete : la PREMIERE ligne gagne, comme partout ou ce
    // depot lit un fichier de comptes — sans quoi il suffirait d'ajouter
    // une ligne a la fin pour detourner une cle existante.
    if (vus.has(id)) {
      refusees.push({ ligne: i + 1, texte: nue, raison: `duplicate key ID ${id}` });
      continue;
    }
    vus.add(id);
    cles.push({ id, algo: algo.toUpperCase(), cle: /^HEX:/i.test(cle) ? `HEX:${cle.slice(4).toUpperCase()}` : cle });
  }
  return { ...VIDE, cles, refusees };
}

/**
 * `chronyc keygen [id [type [bits]]]` : fabriquer une ligne de ce fichier.
 *
 * Les defauts sont ceux de la vraie commande — numero 1, SHA1, 160 bits
 * — et la sortie est une LIGNE PRETE a coller dans le fichier de cles,
 * ce que la documentation decrit (« printed to standard output for
 * secure transfer to configuration files »). La rendre autrement
 * obligerait l'operateur a la reformater, ce qui est precisement ce que
 * la commande evite.
 *
 * L'alea vient de `Math.random`, comme partout dans ce simulateur : ce
 * n'est pas une source cryptographique et le fichier le dit plutot que
 * de le laisser croire.
 */
export function genererCleChrony(
  id = 1, type = 'SHA1', bits = 160,
): { ok: true; ligne: string } | { ok: false; erreur: string } {
  if (!Number.isInteger(id) || id < 1 || id > 0xffffffff) {
    return { ok: false, erreur: `Invalid key ID ${id}` };
  }
  if (!estCondenseNtp(type)) {
    return { ok: false, erreur: `Unknown hash function ${type}` };
  }
  // La vraie commande borne la longueur a [80, 4096] bits.
  if (!Number.isInteger(bits) || bits < 80 || bits > 4096) {
    return { ok: false, erreur: `Invalid key length ${bits}` };
  }
  const octets = Math.ceil(bits / 8);
  let hexa = '';
  for (let i = 0; i < octets; i++) {
    hexa += Math.floor(Math.random() * 256).toString(16).padStart(2, '0').toUpperCase();
  }
  return { ok: true, ligne: `${id} ${type.toUpperCase()} HEX:${hexa}` };
}
