/**
 * L'autorisation de la CLI, en UN seul endroit.
 *
 * IOS a trois mecanismes d'autorisation, et ce sont trois mecanismes
 * distincts qu'il ne faut pas melanger :
 *
 * 1. les NIVEAUX (0-15), un ordre total — une commande a un niveau, une
 *    session a un niveau, et la commande est visible si le sien est
 *    inferieur ou egal ;
 * 2. les VUES d'analyseur, qui REMPLACENT l'arbre visible au lieu de s'y
 *    ajouter — c'est ce qui permet de decrire un role sans passer par
 *    l'ordre total des niveaux ;
 * 3. l'autorisation AAA par commande, qui interroge un serveur.
 *
 * Ce module porte les deux premiers. Le troisieme vit dans
 * `AaaAuthenticator`, parce qu'il consulte le reseau.
 *
 * CE QU'IL REMPLACE, et pourquoi il fallait le faire : la decision etait
 * prise par CINQ predicats appeles a la suite dans `executeOnTrie` —
 * « la commande est-elle montee au-dessus du niveau ? », « est-elle
 * accordee au niveau ? », « l'est-elle en configuration ? », « est-ce
 * une `show` reservee ? », « la vue l'autorise-t-elle ? ». Chacun
 * relisait la table des regles a sa facon et refaisait son propre
 * filtrage de prefixe, et leur ordre d'appel etait la vraie
 * specification. Les consequences n'etaient pas theoriques : le filtre
 * par niveau n'existait pas en configuration, les vues ne s'appliquaient
 * pas en configuration, et une regle ajoutee a un endroit ne se voyait
 * pas des autres.
 *
 * Les trois premiers predicats disaient en realite LA MEME CHOSE —
 * `niveau_effectif(commande) <= niveau_session` — et ne differaient que
 * par le NIVEAU PAR DEFAUT de la commande, qui etait implicite : 1 pour
 * l'arbre utilisateur, 15 pour les autres. Le rendre explicite les
 * reunit en une regle unique.
 */

/**
 * L'espace de nommage d'une regle de niveau : c'est le mot que
 * l'operateur ecrit dans `privilege <mode> level <n> <commande>`. IOS en
 * accepte d'autres, mais ces quatre sont ceux que cette CLI expose.
 */
export type AuthScope = 'exec' | 'configure' | 'interface' | 'line';

/** Ce qu'est une session, du point de vue de l'autorisation. */
export interface CliPrincipal {
  /** 0-15. */
  readonly level: number;
  /** La vue active, ou `null` a la racine. */
  readonly view: string | null;
}

/**
 * `run` : la commande est visible et peut s'executer.
 * `absent` : elle n'existe pas POUR CETTE SESSION, et IOS repond alors
 * exactement ce qu'il repond a une commande inconnue — pas un refus.
 * C'est la difference que ce type existe pour empecher d'oublier.
 */
export type AuthVerdict = 'run' | 'absent';

/** Une vue d'analyseur, y compris composee. */
export interface AuthView {
  readonly name: string;
  readonly execInclude: readonly string[];
  readonly execExclude: readonly string[];
  /** Une superview ne contient pas de commandes : elle REUNIT des vues. */
  readonly superview?: boolean;
  readonly members?: readonly string[];
}

/**
 * Ce qui reste joignable depuis N'IMPORTE QUELLE vue et n'importe quel
 * niveau. Ce n'est pas une commodite : sans `exit` on ne sort pas d'un
 * role, et sans `show parser view` on ne sait pas dans lequel on est —
 * une vue dont on ne peut pas sortir n'est plus un role, c'est une
 * souriciere.
 */
const SORTIES: readonly string[] = ['exit', 'end', 'logout'];

/**
 * `enable` et `disable` sont des verbes d'EXEC, et la nuance n'est pas
 * theorique : en configuration, `enable secret …` est une commande de
 * configuration ordinaire, qui doit se plier au niveau comme les autres.
 * Les confondre laissait un chef d'equipe de niveau 10 changer le secret
 * d'activation de la machine.
 */
const TOUJOURS_EN_EXEC: readonly string[] = ['disable', 'enable', 'show parser view'];

function normalise(commande: string): string {
  return commande.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** `cible` couvre-t-elle `commande` ? Un prefixe couvre ce qui le complete. */
function couvre(cible: string, commande: string): boolean {
  return commande === cible || commande.startsWith(cible + ' ');
}

/**
 * La table des niveaux de commande : les defauts d'IOS, plus ce que
 * l'operateur a deplace avec `privilege`.
 *
 * Le stockage reste la `Map` que porte l'equipement — elle est lue par le
 * serialiseur de configuration et par l'aide — mais plus personne ne la
 * parcourt a la main : la regle de resolution vit ici, une fois.
 */
export class CommandLevelTable {
  constructor(private readonly rules: () => Map<string, number> | undefined) {}

  private static key(scope: AuthScope, commande: string): string {
    return `${scope} ${normalise(commande)}`;
  }

  setLevel(scope: AuthScope, commande: string, level: number): void {
    const table = this.rules();
    if (table) table.set(CommandLevelTable.key(scope, commande), level);
  }

  /** Retire la regle et rend le niveau qu'elle portait, ou `undefined`. */
  reset(scope: AuthScope, commande: string): number | undefined {
    const table = this.rules();
    if (!table) return undefined;
    const key = CommandLevelTable.key(scope, commande);
    const niveau = table.get(key);
    if (niveau !== undefined) table.delete(key);
    return niveau;
  }

  remove(scope: AuthScope, commande: string): void {
    this.rules()?.delete(CommandLevelTable.key(scope, commande));
  }

  /**
   * Le niveau EFFECTIF d'une commande : la regle la plus LONGUE gagne,
   * comme dans l'arbre d'IOS. `privilege exec level 7 show` et
   * `privilege exec level 10 show running-config` coexistent, et c'est la
   * seconde qui decide pour `show running-config` — sans cette regle,
   * l'ordre d'insertion trancherait, donc le comportement dependrait de
   * l'ordre de frappe de l'operateur.
   */
  levelOf(scope: AuthScope, commande: string, defaut: number): number {
    const table = this.rules();
    if (!table || table.size === 0) return defaut;
    const cible = normalise(commande);
    const prefixe = `${scope} `;
    let meilleur: { longueur: number; niveau: number } | null = null;
    for (const [key, niveau] of table) {
      if (!key.startsWith(prefixe)) continue;
      const regle = key.slice(prefixe.length);
      if (!couvre(regle, cible)) continue;
      if (!meilleur || regle.length > meilleur.longueur) {
        meilleur = { longueur: regle.length, niveau };
      }
    }
    return meilleur ? meilleur.niveau : defaut;
  }

  /** Les regles d'un espace dont le niveau est atteignable par la session. */
  grantedAtOrBelow(scope: AuthScope, level: number): Array<{ commande: string; niveau: number }> {
    const table = this.rules();
    if (!table) return [];
    const prefixe = `${scope} `;
    const out: Array<{ commande: string; niveau: number }> = [];
    for (const [key, niveau] of table) {
      if (!key.startsWith(prefixe) || niveau > level) continue;
      out.push({ commande: key.slice(prefixe.length), niveau });
    }
    return out;
  }
}

/**
 * Les vues, y compris COMPOSEES.
 *
 * Une superview ne porte aucune commande a elle : elle reunit les vues
 * qu'on lui a ajoutees. C'est ainsi qu'IOS decrit un role qui recoupe
 * plusieurs metiers sans dupliquer leurs listes — et c'est ce qui
 * manquait, `parser view X superview` etant accepte puis traite comme une
 * vue ordinaire VIDE, donc un compte qui la portait ne voyait rien.
 */
export class ParserViewRegistry {
  constructor(private readonly views: () => Map<string, AuthView>) {}

  get(nom: string): AuthView | undefined { return this.views().get(nom); }

  has(nom: string): boolean { return this.views().has(nom); }

  /**
   * Les vues effectivement consultees pour `nom` : elle-meme, ou ses
   * membres si c'est une superview. La resolution est bornee par les
   * vues deja vues, IOS refusant de toute facon d'imbriquer une
   * superview dans une superview.
   */
  private resolues(nom: string, vues = new Set<string>()): AuthView[] {
    if (vues.has(nom)) return [];
    vues.add(nom);
    const vue = this.views().get(nom);
    if (!vue) return [];
    if (!vue.superview) return [vue];
    const out: AuthView[] = [];
    for (const membre of vue.members ?? []) out.push(...this.resolues(membre, vues));
    return out;
  }

  /**
   * La commande est-elle visible dans cette vue ? `exclude` l'emporte —
   * il sert precisement a retirer une commande d'un prefixe qu'on vient
   * d'inclure. Un prefixe inclus autorise ce qui le complete (`show ip`
   * couvre `show ip route`), et une commande incluse plus longue que ce
   * qui est tape reste joignable, parce que c'est un arbre et pas une
   * egalite : on doit pouvoir taper `show` pour se voir proposer la
   * suite.
   */
  visible(nom: string, commande: string): boolean {
    const membres = this.resolues(nom);
    if (membres.length === 0) return false;
    const cible = normalise(commande);
    if (membres.some((v) => v.execExclude.some((c) => couvre(normalise(c), cible)))) return false;
    return membres.some((v) => v.execInclude.some((c) => {
      const inclus = normalise(c);
      return couvre(inclus, cible) || inclus.startsWith(cible + ' ');
    }));
  }
}

export interface AuthorizeInput {
  readonly principal: CliPrincipal;
  readonly scope: AuthScope;
  readonly command: string;
  /**
   * Le niveau de la commande QUAND l'operateur n'a rien deplace. Il vaut
   * 1 pour ce que l'arbre utilisateur porte et 15 pour le reste — c'est
   * la seule chose que l'appelant sait et que cette classe ignore.
   */
  readonly defaultLevel: number;
}

/**
 * Le point d'entree unique. `executeOnTrie`, la completion et l'aide
 * posent la MEME question, donc ne peuvent plus repondre differemment —
 * c'etait le defaut de fond : une commande refusee a l'execution
 * continuait d'etre proposee par `?`.
 */
export class CliAuthorization {
  constructor(
    readonly levels: CommandLevelTable,
    readonly views: ParserViewRegistry,
  ) {}

  authorize(input: AuthorizeInput): AuthVerdict {
    const commande = normalise(input.command);
    if (SORTIES.some((c) => couvre(c, commande))) return 'run';
    if (input.scope === 'exec' && TOUJOURS_EN_EXEC.some((c) => couvre(c, commande))) return 'run';

    const vue = input.principal.view;
    if (vue !== null && this.views.has(vue)) {
      return this.views.visible(vue, commande) ? 'run' : 'absent';
    }

    const niveau = this.levels.levelOf(input.scope, commande, input.defaultLevel);
    return niveau <= input.principal.level ? 'run' : 'absent';
  }

  /** L'operateur a-t-il DESCENDU cette commande jusqu'a la session ? */
  estAccordee(input: AuthorizeInput): boolean {
    const commande = normalise(input.command);
    if (input.principal.view !== null) return false;
    const niveau = this.levels.levelOf(input.scope, commande, input.defaultLevel);
    return niveau <= input.principal.level && niveau < input.defaultLevel;
  }
}

/** L'espace de nommage des regles qui gouverne un mode de la CLI. */
export function scopeForMode(mode: string): AuthScope {
  if (mode === 'user' || mode === 'privileged') return 'exec';
  if (mode === 'config-if' || mode === 'config-subif') return 'interface';
  if (mode === 'config-line') return 'line';
  return 'configure';
}
