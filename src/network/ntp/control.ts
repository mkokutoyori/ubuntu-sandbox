/**
 * PRD-NTP-Tutoriel.md §13 / lot N11 — les messages de controle, mode 6.
 *
 * ── Le defaut ───────────────────────────────────────────────────────
 *
 * `ntp access-group query-only` etait accepte, range, evalue — et
 * **structurellement inerte** : `verdictAccesNtp` connait l'action
 * `control-query` depuis le lot N6, et rien dans tout le depot n'emettait
 * ni ne recevait la moindre requete de controle. Le seul effet observable
 * de `query-only` etait donc de REFUSER le temps, jamais d'autoriser ce
 * qu'il autorise. De meme `no ntp allow mode control` — la commande qui
 * ferme la porte de `monlist` et de CVE-2013-5211 — etait rangee et lue
 * par personne : une machine durcie et une machine ouverte se
 * comportaient exactement pareil.
 *
 * ── Ce que le mode 6 est vraiment ───────────────────────────────────
 *
 * RFC 9327 (novembre 2022, qui remplace l'annexe B de RFC 1305) : un
 * message de controle est un paquet NTP de **mode 6** sur le meme port
 * UDP/123, avec son propre en-tete de douze octets :
 *
 * ```
 *  0                   1                   2                   3
 *  0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
 * +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 * |LI | VN  |Mode |R|E|M| OpCode  |       Sequence Number         |
 * +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 * |            Status             |       Association ID          |
 * +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 * |            Offset             |            Count              |
 * +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 * ```
 *
 * Les trois bits qui suivent le mode ne sont PAS decoratifs et sont la
 * raison pour laquelle un booleen n'aurait pas suffi : **R** distingue
 * une requete d'une reponse (les deux ont le meme opcode, donc sans lui
 * une machine repondrait a ses propres reponses), **E** dit que la
 * reponse est une erreur — et c'est ce qui permet de refuser un opcode
 * en le NOMMANT au lieu de se taire —, **M** annonce une suite.
 *
 * ── Ce qui est implemente, et ce qui est refuse en le nommant ───────
 *
 * Deux opcodes sur treize, et ce sont ceux que `ntpq` emploie pour tout
 * ce qu'un cours de NTP fait faire : **1 (read status)**, qui rend la
 * liste des associations, et **2 (read variables)**, qui rend les
 * variables systeme (association 0) ou celles d'un pair.
 *
 * Les onze autres sont REFUSES avec le bit d'erreur et le code de la RFC
 * plutot qu'ignores. C'est vrai en particulier des deux qui comptent :
 * **`monlist` n'existe pas** (c'etait une extension privee de `ntpd`,
 * jamais un opcode standard, et c'est elle qui a rendu CVE-2013-5211
 * celebre), et **les opcodes d'ECRITURE (3, 5, 8) sont refuses par
 * conception** — un simulateur ou l'on reconfigure un routeur par un
 * datagramme UDP non authentifie enseignerait exactement ce qu'il faut
 * ne pas faire.
 */

import type { NetworkPdu } from '@/network/core/NetworkPdu';

/** Les opcodes de RFC 9327 §3. */
export const OPCODES_CONTROLE: Readonly<Record<number, string>> = {
  1: 'read status',
  2: 'read variables',
  3: 'write variables',
  4: 'read clock variables',
  5: 'write clock variables',
  6: 'set trap address/port',
  7: 'trap response',
  8: 'runtime configuration',
  9: 'export configuration',
  10: 'retrieve MRU list',
  11: 'retrieve ordered list',
  12: 'request nonce',
  31: 'unset trap',
};

/** Ceux auxquels cette machine sait repondre. */
export const OPCODES_SERVIS: readonly number[] = [1, 2];

/**
 * Les codes d'erreur de RFC 9327 §3.2, places dans l'octet de poids fort
 * du champ `Status` quand le bit E est pose.
 */
export const ERREURS_CONTROLE = {
  UNSPECIFIED: 0,
  AUTH_FAILURE: 1,
  INVALID_FORMAT: 2,
  INVALID_OPCODE: 3,
  INVALID_ASSOCIATION: 4,
  INVALID_VARIABLE: 5,
  INVALID_VALUE: 6,
  ADMIN_PROHIBITED: 7,
} as const;

export const NOMS_ERREURS_CONTROLE: Readonly<Record<number, string>> = {
  0: 'unspecified error',
  1: 'authentication failure',
  2: 'invalid message format',
  3: 'invalid opcode',
  4: 'unknown association identifier',
  5: 'unknown variable name',
  6: 'invalid variable value',
  7: 'administratively prohibited',
};

export interface NtpControlPacket extends NetworkPdu {
  type: 'ntp-control';
  leapIndicator: number;
  version: number;
  /** Le bit R : une reponse, ou une requete. */
  response: boolean;
  /** Le bit E. */
  error: boolean;
  /** Le bit M : d'autres fragments suivent. */
  more: boolean;
  opcode: number;
  sequence: number;
  status: number;
  associationId: number;
  offset: number;
  /** La longueur des donnees, en octets — ce que `count` porte sur le fil. */
  count: number;
  /** La charge utile `nom=valeur,` de RFC 9327 §3.3. */
  data: string;
}

/** Le mode 6 sur le fil. */
export const MODE_CONTROLE = 6;

/**
 * Les douze octets d'en-tete d'un message de controle.
 *
 * Ce simulateur ne serialise pas ses paquets NTP — ils voyagent comme
 * objets, comme le dit `auth.ts` — mais cet en-tete est ecrit pour de
 * vrai parce qu'il porte des CHAMPS DE BITS : `R`, `E` et `M` partagent
 * un octet avec l'opcode, et rien n'oblige un code qui les manipule
 * separement a rester d'accord avec la RFC. L'ecrire une fois donne un
 * endroit unique ou la disposition est vraie, et un test qui la verifie.
 */
export function serialiserEnteteControle(pkt: NtpControlPacket): Uint8Array {
  const octets = new Uint8Array(12);
  const vue = new DataView(octets.buffer);
  vue.setUint8(0, ((pkt.leapIndicator & 0x3) << 6) | ((pkt.version & 0x7) << 3) | MODE_CONTROLE);
  vue.setUint8(1,
    (pkt.response ? 0x80 : 0) | (pkt.error ? 0x40 : 0) | (pkt.more ? 0x20 : 0)
    | (pkt.opcode & 0x1f));
  vue.setUint16(2, pkt.sequence & 0xffff);
  vue.setUint16(4, pkt.status & 0xffff);
  vue.setUint16(6, pkt.associationId & 0xffff);
  vue.setUint16(8, pkt.offset & 0xffff);
  vue.setUint16(10, pkt.count & 0xffff);
  return octets;
}

/**
 * Le mot d'etat SYSTEME (RFC 9327 §3.1.1) : indicateur de saut, source
 * d'horloge, nombre d'evenements, code du dernier evenement.
 *
 * `ntpq -c "rv 0"` le rend en tete de sa reponse, et c'est le seul
 * endroit ou un operateur voit d'un coup si la machine est synchronisee
 * ET sur quoi.
 */
export function motEtatSysteme(
  leap: number, sourceHorloge: number, nbEvenements: number, codeEvenement: number,
): number {
  return ((leap & 0x3) << 14) | ((sourceHorloge & 0x3f) << 8)
    | ((nbEvenements & 0xf) << 4) | (codeEvenement & 0xf);
}

/**
 * Le mot d'etat d'un PAIR (RFC 9327 §3.1.2).
 *
 * Le champ `select` est celui que `ntpq -p` rend par son caractere de
 * pointage en debut de ligne : c'est la meme information, ecrite deux
 * fois — d'ou une seule fonction pour la produire, et
 * `pointageDepuisSelect` pour la lire.
 */
export function motEtatPair(
  config: boolean, joignable: boolean, select: number,
  nbEvenements: number, codeEvenement: number,
): number {
  const drapeaux = (config ? 0x8 : 0) | (joignable ? 0x1 : 0);
  return (drapeaux << 12) | ((select & 0x7) << 8)
    | ((nbEvenements & 0xf) << 4) | (codeEvenement & 0xf);
}

/** Les valeurs du champ `select`, RFC 9327 §3.1.2. */
export const SELECT = {
  REJECT: 0,
  FALSETICK: 1,
  EXCESS: 2,
  OUTLIER: 3,
  CANDIDATE: 4,
  BACKUP: 5,
  SYSPEER: 6,
  PPS: 7,
} as const;

/**
 * Le caractere de pointage de `ntpq -p`.
 *
 * Il est DERIVE du champ `select` du mot d'etat plutot que calcule a
 * cote : les deux disent la meme chose, et deux calculs finiraient par
 * se contredire — le defaut que ce depot referme partout.
 */
export function pointageDepuisSelect(select: number): string {
  switch (select) {
    case SELECT.SYSPEER: return '*';
    case SELECT.PPS: return 'o';
    case SELECT.BACKUP: return '#';
    case SELECT.CANDIDATE: return '+';
    case SELECT.OUTLIER: return '-';
    case SELECT.FALSETICK: return 'x';
    default: return ' ';
  }
}

/**
 * La charge utile d'une reponse : `nom=valeur, nom=valeur, …`.
 *
 * Une valeur contenant une virgule, un espace ou un guillemet est mise
 * entre guillemets, comme le fait `ntpd` — sans quoi `refid=INIT, x=1`
 * et une valeur `INIT, x=1` seraient indiscernables a la relecture.
 */
export function formaterVariables(vars: Readonly<Record<string, string>>): string {
  return Object.entries(vars)
    .map(([k, v]) => (/[,="\s]/.test(v) ? `${k}="${v}"` : `${k}=${v}`))
    .join(', ');
}

/** L'inverse, pour le client. */
export function analyserVariables(data: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Un decoupage sur la virgule casserait toute valeur entre guillemets
  // qui en contient une ; l'analyse suit donc le texte caractere par
  // caractere en retenant si elle est dans une chaine.
  let nom = '';
  let valeur = '';
  let dansValeur = false;
  let dansGuillemets = false;
  const poser = () => {
    const n = nom.trim();
    if (n) out[n] = valeur.trim();
    nom = ''; valeur = ''; dansValeur = false;
  };
  for (const c of data) {
    if (dansGuillemets) {
      if (c === '"') dansGuillemets = false;
      else valeur += c;
      continue;
    }
    if (c === '"' && dansValeur) { dansGuillemets = true; continue; }
    if (c === '=' && !dansValeur) { dansValeur = true; continue; }
    if (c === ',') { poser(); continue; }
    if (dansValeur) valeur += c;
    else nom += c;
  }
  poser();
  return out;
}

/**
 * Les paires (identifiant d'association, mot d'etat) que rend l'opcode 1.
 *
 * Sur le fil ce sont des entiers de 16 bits ; ce simulateur les transporte
 * en texte comme le reste de sa charge utile, dans la forme que `ntpq`
 * affiche lui-meme (`assocID=1234 status=961a`).
 */
export function formaterListeAssociations(
  entrees: ReadonlyArray<{ id: number; status: number }>,
): string {
  return entrees
    .map((e) => `${e.id} ${e.status.toString(16).padStart(4, '0')}`)
    .join(',');
}

export function analyserListeAssociations(
  data: string,
): Array<{ id: number; status: number }> {
  const out: Array<{ id: number; status: number }> = [];
  for (const morceau of data.split(',')) {
    const [a, b] = morceau.trim().split(/\s+/);
    const id = parseInt(a, 10);
    const status = parseInt(b, 16);
    if (!isNaN(id) && !isNaN(status)) out.push({ id, status });
  }
  return out;
}
