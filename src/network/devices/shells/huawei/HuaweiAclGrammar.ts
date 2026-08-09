/**
 * PRD-CLI-Fidelite-VRP.md §17 / lot V8 — la grammaire de `acl`, une
 * seule fois pour les deux plateformes.
 *
 * Il y en avait DEUX, et elles ne disaient pas la meme chose. Le routeur
 * bornait le numero (2000-3999) et connaissait `acl name X advance` ; le
 * switch ne bornait rien et lisait le mot de type comme un NUMERO, si
 * bien que sur le meme reseau :
 *
 *   [routeur] acl 42                -> Error: ACL number must be 2000-…
 *   [switch]  acl 42                -> [SW-acl-basic-42]
 *   [switch]  acl abc               -> [SW-acl-basic-NaN]      (une vue nommee NaN)
 *   [switch]  acl name TEST advance -> [SW-acl-basic-TEST]     (jamais advanced)
 *   [switch]  acl ipv6 name V6      -> [SW-acl-basic-NaN]
 *
 * La grammaire est ici ; chaque plateforme garde SON magasin, qui est
 * legitimement different (le moteur d'ACL du routeur, la table du
 * switch). Ce qui ne doit pas differer est ce qui est accepte.
 */

import type { ErreurGrammaireVrp } from '../cli-utils';

export type AclType = 'basic' | 'advanced';

export type AclCommande =
  | { kind: 'numero'; numero: number; type: AclType }
  | { kind: 'nom'; nom: string; type: AclType; ipv6: boolean; numero?: number };

export type AclAnalyse =
  | { statut: 'ok'; cmd: AclCommande }
  | { statut: 'refus'; err: ErreurGrammaireVrp };

/** Les bornes que ce simulateur sait tenir. */
export const ACL_BASIC = [2000, 2999] as const;
export const ACL_ADVANCED = [3000, 3999] as const;

/**
 * VRP connait aussi les ACL L2 (4000-4999) et utilisateur (5000-5999),
 * que rien ici ne sait evaluer. Les refuser en nommant la borne tenue
 * est plus honnete que d'ouvrir une vue dont aucune regle ne servira.
 */
const HORS_BORNES =
  'Error: ACL number must be 2000-2999 (basic) or 3000-3999 (advanced).';

const TYPES_NOMMES: Readonly<Record<string, AclType>> = {
  basic: 'basic',
  // VRP ecrit `advance` ; `advanced` est tolere de longue date par ce
  // simulateur et le rester ne coute rien.
  advance: 'advanced',
  advanced: 'advanced',
};

function typeDuNumero(n: number): AclType | null {
  if (n >= ACL_BASIC[0] && n <= ACL_BASIC[1]) return 'basic';
  if (n >= ACL_ADVANCED[0] && n <= ACL_ADVANCED[1]) return 'advanced';
  return null;
}

/**
 * `acl [ number ] <n>` | `acl name <nom> [ basic | advance | <n> ]` |
 * `acl ipv6 name <nom>`.
 */
export function analyserAcl(args: readonly string[]): AclAnalyse {
  const mots = args.filter((a) => a.length > 0);
  if (mots.length === 0) return { statut: 'refus', err: { kind: 'incomplete' } };

  const tete = mots[0].toLowerCase();

  if (tete === 'ipv6') {
    if (mots.length < 2) return { statut: 'refus', err: { kind: 'incomplete' } };
    if (mots[1].toLowerCase() !== 'name') {
      return { statut: 'refus', err: { kind: 'wrong', token: mots[1] } };
    }
    if (mots.length < 3) return { statut: 'refus', err: { kind: 'incomplete' } };
    if (mots.length > 3) return { statut: 'refus', err: { kind: 'too-many', token: mots[3] } };
    return { statut: 'ok', cmd: { kind: 'nom', nom: mots[2], type: 'advanced', ipv6: true } };
  }

  if (tete === 'name') {
    if (mots.length < 2) return { statut: 'refus', err: { kind: 'incomplete' } };
    const nom = mots[1];
    if (mots.length === 2) {
      return { statut: 'ok', cmd: { kind: 'nom', nom, type: 'basic', ipv6: false } };
    }
    // `acl name <nom> <numero>` lie un nom a un numero, et c'est bien une
    // forme de VRP : c'etait la seule que le switch avait et que le
    // routeur refusait. Le numero decide alors du type, comme partout
    // ailleurs.
    const suite = mots[2];
    let type: AclType | null = null;
    let numero: number | undefined;
    if (/^\d+$/.test(suite)) {
      numero = parseInt(suite, 10);
      type = typeDuNumero(numero);
      if (!type) return { statut: 'refus', err: { kind: 'propre', message: HORS_BORNES } };
    } else {
      type = TYPES_NOMMES[suite.toLowerCase()] ?? null;
      if (!type) return { statut: 'refus', err: { kind: 'wrong', token: suite } };
    }
    if (mots.length > 3) return { statut: 'refus', err: { kind: 'too-many', token: mots[3] } };
    return { statut: 'ok', cmd: { kind: 'nom', nom, type, ipv6: false, numero } };
  }

  const avecNumber = tete === 'number';
  const jeton = avecNumber ? mots[1] : mots[0];
  if (jeton === undefined) return { statut: 'refus', err: { kind: 'incomplete' } };
  if (!/^\d+$/.test(jeton)) return { statut: 'refus', err: { kind: 'wrong', token: jeton } };

  const numero = parseInt(jeton, 10);
  const type = typeDuNumero(numero);
  if (!type) return { statut: 'refus', err: { kind: 'propre', message: HORS_BORNES } };

  const attendus = avecNumber ? 2 : 1;
  if (mots.length > attendus) {
    return { statut: 'refus', err: { kind: 'too-many', token: mots[attendus] } };
  }
  return { statut: 'ok', cmd: { kind: 'numero', numero, type } };
}
