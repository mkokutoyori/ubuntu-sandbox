/**
 * PRD-NTP-Tutoriel.md §8 / lot N6 — `ntp access-group` filtre pour de
 * bon.
 *
 * ── Le defaut ───────────────────────────────────────────────────────
 *
 * Les quatre groupes etaient acceptes, ranges et rendus dans la
 * configuration — et **aucune ACL n'etait consultee a la reception d'un
 * paquet NTP**. La commande de durcissement du §3.7 et du §9 du
 * tutoriel n'avait aucun effet observable.
 *
 * ── Ce qui a ete verifie contre la documentation constructeur ───────
 *
 * Quatre points, parce qu'un simulateur qui se trompe ici enseigne un
 * durcissement qui n'en est pas un.
 *
 * 1. **Les quatre mots-cles**, et ce que chacun permet (reference de
 *    commandes Cisco IOS) :
 *
 *    | Mot-cle      | Requetes de temps | Requetes de controle | Se SYNCHRONISER dessus |
 *    |--------------|-------------------|----------------------|------------------------|
 *    | `peer`       | oui               | oui                  | **oui**                |
 *    | `serve`      | oui               | oui                  | non                    |
 *    | `serve-only` | oui               | non                  | non                    |
 *    | `query-only` | non               | oui                  | non                    |
 *
 * 2. **`nomodify` N'EST PAS un mot-cle IOS.** Le tutoriel ecrit
 *    `ntp access-group nomodify 10` ; c'est la syntaxe de `ntpd` et de
 *    `chrony`, pas celle d'IOS, dont la reference de commandes ne liste
 *    que les quatre ci-dessus. Il est donc REFUSE — l'accepter
 *    apprendrait une commande que la vraie machine rejette.
 *
 * 3. **L'ordre compte, et il va du moins au plus restrictif** :
 *    `peer`, `serve`, `serve-only`, `query-only`. Le premier groupe dont
 *    l'ACL accepte la source decide, et un paquet qui ne correspond a
 *    aucun est **ecarte**.
 *
 *    *Ecart de sources, dit plutot que tu* : une page de la reference de
 *    commandes Cisco place `query-only` en DEUXIEME position. Deux
 *    autres sources — dont la description de `ntp access-group
 *    match-all` — le placent en quatrieme, ce qui est aussi le seul
 *    ordre coherent avec « du moins au plus restrictif », `query-only`
 *    interdisant les requetes de temps que `serve` autorise. C'est ce
 *    dernier ordre qui est implemente.
 *
 * 4. **Aucun groupe configure = acces complet.** « If no access groups
 *    are specified, comprehensive access is granted to all sources » ;
 *    des qu'un seul est pose, « only the specified access is granted ».
 *    C'est le piege que le §3.7 tend sans le dire : poser un
 *    `serve-only` seul **empeche le routeur lui-meme de se
 *    synchroniser**, puisque se synchroniser demande `peer`.
 */

/** Les quatre familles, dans l'ordre d'evaluation d'IOS. */
export const ORDRE_ACCES = ['peer', 'serve', 'serve-only', 'query-only'] as const;

export type GenreAccesNtp = (typeof ORDRE_ACCES)[number];

/** Ce qu'un paquet entrant demande a la machine. */
export type ActionNtp =
  /** « Donne-moi l'heure » — une requete de client. */
  | 'serve-time'
  /** « Je te donne l'heure » — une reponse dont on veut se servir. */
  | 'sync-from'
  /** Une requete de controle (mode 6), celle de `monlist` et consorts. */
  | 'control-query';

/** Ce que chaque groupe autorise, tel que la reference de commandes le decrit. */
const PERMIS: Record<GenreAccesNtp, ReadonlySet<ActionNtp>> = {
  peer: new Set<ActionNtp>(['serve-time', 'control-query', 'sync-from']),
  serve: new Set<ActionNtp>(['serve-time', 'control-query']),
  'serve-only': new Set<ActionNtp>(['serve-time']),
  'query-only': new Set<ActionNtp>(['control-query']),
};

/** Un mot est-il un genre d'acces qu'IOS connait ? */
export function estGenreAcces(mot: string): mot is GenreAccesNtp {
  return (ORDRE_ACCES as readonly string[]).includes(mot.toLowerCase());
}

/**
 * Le verdict pour un paquet entrant.
 *
 * `correspond` dit si l'ACL nommee accepte cette source ; elle est
 * fournie par l'equipement, qui seul connait ses listes d'acces.
 *
 * Le parcours suit l'ordre d'IOS et s'arrete au PREMIER groupe dont
 * l'ACL accepte la source — « access is granted for the first match
 * that is found ». Un groupe qui accepte la source mais n'autorise pas
 * l'action refuse : c'est tout l'interet de `serve-only`, qui laisse
 * demander l'heure et rien d'autre.
 */
export function verdictAccesNtp(
  groupes: ReadonlyMap<string, string>,
  action: ActionNtp,
  correspond: (acl: string) => boolean,
): boolean {
  // Aucun groupe configure : acces complet, ce qui est le defaut d'IOS
  // et la raison pour laquelle poser UN seul groupe change tout.
  const poses = ORDRE_ACCES.filter((g) => groupes.has(g));
  if (poses.length === 0) return true;
  for (const genre of poses) {
    const acl = groupes.get(genre)!;
    if (!correspond(acl)) continue;
    return PERMIS[genre].has(action);
  }
  // Aucun groupe ne reconnait cette source : le paquet est ecarte.
  return false;
}
