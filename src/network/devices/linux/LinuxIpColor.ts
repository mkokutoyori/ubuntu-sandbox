/**
 * `ip -c` — la colorisation d'iproute2.
 *
 * L'option était acceptée et JETÉE : `executeIpCommand` ignore en silence
 * toute option qu'il ne connaît pas, donc `ip -c a` rendait exactement les
 * mêmes octets que `ip a`. Rien n'était faux à l'écran, il n'y avait
 * simplement aucune couleur à y voir — et c'est la seule commande réseau
 * dont un apprenant attend de la couleur.
 *
 * Ce qui est écrit ici est MESURÉ sur un vrai `iproute2` 6.1 installé pour
 * l'occasion, pas reconstitué de mémoire, parce que trois détails de la
 * disposition sont contre-intuitifs et qu'aucun ne s'invente :
 *
 *  1. **L'espace séparateur est DANS la séquence.** Le vrai `ip` imprime
 *     `state \e[1;32mUP \e[0mgroup default` — l'espace qui suit `UP` est
 *     colorié, parce qu'iproute2 passe `"%s "` en entier à sa fonction de
 *     couleur. Idem pour `lo: `, pour `dev eth0 `, pour `brd 10.0.0.255 `.
 *     C'est pour cela que les fonctions ci-dessous prennent le fragment
 *     EXACT à colorier, espace compris, plutôt qu'un mot que l'appelant
 *     recollerait ensuite.
 *  2. **Le préfixe reste dehors sur une adresse d'interface, dedans sur
 *     une route.** `inet \e[1;35m127.0.0.1\e[0m/8` mais
 *     `\e[1;35m192.0.2.0/24 \e[0mdev` — deux formats d'impression
 *     différents dans le vrai code, et les recopier est ce qui évite de
 *     tomber sur une troisième convention inventée.
 *  3. **`UNKNOWN` n'est pas colorié.** Seuls `UP` (vert) et `DOWN` (rouge)
 *     le sont ; tout autre état opérationnel sort nu.
 *
 * La palette elle-même vient de `lib/color.c` d'iproute2, qui en tient
 * DEUX : `attr_colors_light` et `attr_colors_dark`, choisies d'après la
 * variable `COLORFGBG`. Vérifié en la forçant dans les deux sens sur le
 * vrai binaire. Le terminal simulé a un fond sombre (`#2e3436`), donc la
 * palette fidèle ici est la sombre — celle des variantes grasses.
 */

/** `-c[=always|auto|never]` : ce que l'option a demandé. */
export type IpColorMode = 'never' | 'auto' | 'always';

/**
 * Palette « fond sombre » d'iproute2 : COLOR_IFNAME, COLOR_MAC,
 * COLOR_INET, COLOR_INET6, COLOR_OPERSTATE_UP, COLOR_OPERSTATE_DOWN.
 * `1;94` sur l'IPv6 n'est pas une coquille : c'est le seul de la table
 * qui vise un bleu vif plutôt que le bleu de base, le bleu sombre étant
 * illisible sur fond noir.
 */
const C_IFNAME = '[1;36m';
const C_MAC = '[1;33m';
const C_INET = '[1;35m';
const C_INET6 = '[1;94m';
const C_UP = '[1;32m';
const C_DOWN = '[1;31m';
const C_CLEAR = '[0m';

export interface IpColorizer {
  /** Faux quand la sortie doit rester nue : tout renvoyer tel quel. */
  readonly enabled: boolean;
  ifname(fragment: string): string;
  mac(fragment: string): string;
  inet(fragment: string): string;
  inet6(fragment: string): string;
  /**
   * L'état opérationnel. `state` décide de la couleur, `fragment` porte
   * le texte à colorier — les deux diffèrent parce que le vrai `ip`
   * colorie `UP ` avec son espace, et parfois une colonne complétée.
   */
  operstate(state: string, fragment?: string): string;
}

const NO_COLOR: IpColorizer = {
  enabled: false,
  ifname: (s) => s,
  mac: (s) => s,
  inet: (s) => s,
  inet6: (s) => s,
  operstate: (_state, fragment) => fragment ?? _state,
};

const WITH_COLOR: IpColorizer = {
  enabled: true,
  ifname: (s) => `${C_IFNAME}${s}${C_CLEAR}`,
  mac: (s) => `${C_MAC}${s}${C_CLEAR}`,
  inet: (s) => `${C_INET}${s}${C_CLEAR}`,
  inet6: (s) => `${C_INET6}${s}${C_CLEAR}`,
  operstate: (state, fragment) => {
    const texte = fragment ?? state;
    if (state === 'UP') return `${C_UP}${texte}${C_CLEAR}`;
    if (state === 'DOWN') return `${C_DOWN}${texte}${C_CLEAR}`;
    return texte;
  },
};

export function ipColorizer(enabled: boolean): IpColorizer {
  return enabled ? WITH_COLOR : NO_COLOR;
}

/**
 * Reconnaît la famille `-c` d'iproute2 sur un argument.
 *
 * Le nom se compare par PRÉFIXE (`matches()` dans ip.c), donc `-c`, `-co`,
 * `-col`, `-color` et `--color` désignent tous la même option — mesuré.
 * La valeur après `=`, elle, se compare exactement : `-c=ALWAYS` et
 * `-c=alw` sont refusés par le vrai binaire.
 *
 * Rend `null` quand l'argument n'appartient pas à cette famille (l'appelant
 * continue son analyse), `'invalid'` quand il lui appartient mais que la
 * valeur est inconnue.
 */
export function parseIpColorOption(arg: string): IpColorMode | 'invalid' | null {
  const sansTirets = arg.startsWith('--') ? arg.slice(2) : arg.startsWith('-') ? arg.slice(1) : null;
  if (sansTirets === null) return null;

  const egal = sansTirets.indexOf('=');
  const nom = egal === -1 ? sansTirets : sansTirets.slice(0, egal);
  // Préfixe non vide de « color ». `-c` en fait partie, `-col` aussi.
  if (nom.length === 0 || !'color'.startsWith(nom)) return null;

  // `-c` nu vaut ALWAYS, et non `auto` comme on le supposerait : mesuré en
  // redirigeant la sortie du vrai binaire, qui colorie quand même.
  if (egal === -1) return 'always';

  const valeur = sansTirets.slice(egal + 1);
  if (valeur === 'always' || valeur === 'auto' || valeur === 'never') return valeur;
  return 'invalid';
}

/** Le refus du vrai `ip` sur une valeur inconnue, mot pour mot. */
export function ipUnknownOptionError(arg: string): string {
  return `Option "${arg}" is unknown, try "ip -help".`;
}
