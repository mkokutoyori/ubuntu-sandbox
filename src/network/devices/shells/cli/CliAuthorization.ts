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

import type { CommandCanonicalizer } from './CommandCanonicalizer';

/**
 * L'espace de nommage d'une regle de niveau : c'est le mot que
 * l'operateur ecrit dans `privilege <mode> level <n> <commande>`. IOS en
 * accepte d'autres, mais ces quatre sont ceux que cette CLI expose.
 */
export type AuthScope = 'exec' | 'configure' | 'interface' | 'line';

export const AUTH_SCOPE_VALUES: ReadonlyArray<{
  readonly keyword: AuthScope; readonly description: string;
}> = [
  { keyword: 'configure', description: 'Global configuration mode' },
  { keyword: 'exec', description: 'Exec mode' },
  { keyword: 'interface', description: 'Interface configuration mode' },
  { keyword: 'line', description: 'Line configuration mode' },
];

export const AUTH_SCOPES: readonly AuthScope[] = AUTH_SCOPE_VALUES.map((v) => v.keyword);

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

/** Une commande entree dans une vue, avec ses deux nuances. */
export interface AuthViewCommand {
  readonly command: string;
  /** `all` — l'entree couvre ce qui COMPLETE la commande. */
  readonly all: boolean;
  /** `include-exclusive` — aucune autre vue ne peut la revendiquer. */
  readonly exclusive: boolean;
}

/** Une vue d'analyseur, y compris composee. */
export interface AuthView {
  readonly name: string;
  /**
   * Les commandes autorisees PAR MODE d'analyseur (`exec`, `configure`,
   * `interface`, `line`). Une vue qui ne gouvernerait que l'exec ne
   * pourrait decrire aucun role qui configure quoi que ce soit.
   */
  readonly modes: ReadonlyMap<string, {
    readonly include: readonly AuthViewCommand[];
    readonly exclude: readonly AuthViewCommand[];
  }>;
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

/**
 * Le niveau rendu quand la table des regles ne peut pas etre lue. C'est
 * le plus haut : seule une session qui a deja tout ne perd rien, et
 * toute autre est refusee plutot qu'accordee par defaut.
 */
const NIVEAU_INDECIDABLE = 15;

function normalise(commande: string): string {
  return commande.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** `cible` couvre-t-elle `commande` ? Un prefixe couvre ce qui le complete. */
function couvre(cible: string, commande: string): boolean {
  return commande === cible || commande.startsWith(cible + ' ');
}

/**
 * Ce qu'une regle `privilege` porte : un niveau, et si elle s'etend a ce
 * qui COMPLETE la commande.
 *
 * `all` etait absent, et son absence coutait deux fois : le mot-cle
 * etait refuse, et la semantique d'`all` etait appliquee a TOUTE regle —
 * les deux formes d'IOS faisaient donc la meme chose, qui etait celle de
 * la seconde.
 */
export interface CommandLevelRule {
  readonly level: number;
  /** `privilege <mode> all level <n> <commande>`. */
  readonly all: boolean;
}

export class CommandLevelTable<S extends string = AuthScope> {
  constructor(private readonly rules: () => Map<string, CommandLevelRule> | undefined) {}

  private static key(scope: string, commande: string): string {
    return `${scope} ${normalise(commande)}`;
  }

  setLevel(scope: S, commande: string, level: number, all = false): void {
    const table = this.rules();
    if (table) table.set(CommandLevelTable.key(scope, commande), { level, all });
  }

  /** Retire la regle et rend le niveau qu'elle portait, ou `undefined`. */
  reset(scope: S, commande: string): number | undefined {
    const table = this.rules();
    if (!table) return undefined;
    const key = CommandLevelTable.key(scope, commande);
    const regle = table.get(key);
    if (regle !== undefined) table.delete(key);
    return regle?.level;
  }

  /**
   * Le niveau EFFECTIF d'une commande.
   *
   * Trois regles d'IOS s'y rencontrent, et il fallait les trois :
   *
   * 1. la regle la plus LONGUE gagne — `privilege exec level 7 show` et
   *    `privilege exec level 10 show running-config` coexistent, et
   *    c'est la seconde qui decide pour `show running-config` ; sans
   *    cela l'ordre de frappe de l'operateur trancherait ;
   * 2. une regle SANS `all` ne vaut que pour la commande NOMMEE ; avec
   *    `all`, elle vaut aussi pour ce qui la complete ;
   * 3. hisser une commande hisse ses PARENTES : « all commands whose
   *    syntax is a subset of that command are also set to that level
   *    (…) unless you set them to a different level ». C'est le piege
   *    n°1 du chapitre — `privilege exec level 5 show running-config`
   *    retire tous les `show` au niveau 1 — et l'ignorer enseignait une
   *    delegation sans effet de bord, donc une fausse securite.
   *
   * Il faut pouvoir ATTEINDRE une commande pour la taper : le niveau
   * rendu est donc le plus eleve entre celui de la commande et celui
   * qu'exigent ses parentes.
   */
  levelOf(scope: AuthScope, commande: string, defaut: number): number {
    const table = this.rules();
    // Une table ILLISIBLE n'est pas une table vide : la premiere veut
    // dire « on ne sait pas », la seconde « aucune regle ». Rendre le
    // niveau par defaut pour la premiere accordait une commande hissee
    // au niveau 15 des lors que l'equipement n'etait pas joignable —
    // ne pas savoir n'est pas savoir que oui.
    if (!table) return NIVEAU_INDECIDABLE;
    if (table.size === 0) return defaut;
    const cible = normalise(commande);
    const prefixe = `${scope} `;
    let propre: { longueur: number; niveau: number } | null = null;
    for (const [key, regle] of table) {
      if (!key.startsWith(prefixe)) continue;
      const nom = key.slice(prefixe.length);
      if (nom !== cible && !(regle.all && couvre(nom, cible))) continue;
      if (!propre || nom.length > propre.longueur) {
        propre = { longueur: nom.length, niveau: regle.level };
      }
    }
    const requis = this.niveauDesParentes(table, prefixe, cible);
    return Math.max(propre ? propre.niveau : defaut, requis);
  }

  /**
   * Le niveau qu'il faut pour ATTEINDRE `cible` : le plus eleve des
   * niveaux de ses parentes strictes. Une parente que nomme une regle
   * vaut ce que dit cette regle ; sinon elle vaut le plus haut niveau
   * de ce qui la complete — c'est la promotion elle-meme.
   */
  private niveauDesParentes(
    table: Map<string, CommandLevelRule>, prefixe: string, cible: string,
  ): number {
    const mots = cible.split(' ');
    let requis = 0;
    for (let i = 1; i < mots.length; i++) {
      const parente = mots.slice(0, i).join(' ');
      const explicite = table.get(`${prefixe}${parente}`);
      if (explicite) { requis = Math.max(requis, explicite.level); continue; }
      for (const [key, regle] of table) {
        if (!key.startsWith(prefixe)) continue;
        const nom = key.slice(prefixe.length);
        if (nom !== parente && couvre(parente, nom)) requis = Math.max(requis, regle.level);
      }
    }
    return requis;
  }

  /** Les regles d'un espace dont le niveau est atteignable par la session. */
  grantedAtOrBelow(scope: AuthScope, level: number): Array<{ commande: string; niveau: number }> {
    const table = this.rules();
    if (!table) return [];
    const prefixe = `${scope} `;
    const out: Array<{ commande: string; niveau: number }> = [];
    for (const [key, regle] of table) {
      if (!key.startsWith(prefixe) || regle.level > level) continue;
      out.push({ commande: key.slice(prefixe.length), niveau: regle.level });
    }
    return out;
  }
}

/**
 * Les lignes `privilege …` de la configuration, lues sur la table qui
 * DECIDE.
 *
 * Elles etaient rendues depuis le fourre-tout des « lignes de
 * configuration non traitees », c'est-a-dire un SECOND magasin, tenu a
 * jour par des chaines brutes. Les deux pouvaient donc diverger, et
 * divergeaient : une regle posee `privilege exec level 5 Reload` etait
 * rendue et sans effet. La configuration etant REJOUEE a l'import d'une
 * topologie, la divergence etait persistante.
 *
 * L'ordre est celui d'insertion, comme partout ailleurs dans ce depot :
 * une configuration doit reproduire ce que l'operateur a tape.
 */
export function privilegeConfigLines(rules: Map<string, CommandLevelRule> | undefined): string[] {
  if (!rules || rules.size === 0) return [];
  const lines: string[] = [];
  for (const [key, regle] of rules) {
    const sep = key.indexOf(' ');
    if (sep <= 0) continue;
    const mode = key.slice(0, sep);
    lines.push(`privilege ${mode}${regle.all ? ' all' : ''} level ${regle.level} ${key.slice(sep + 1)}`);
  }
  return lines;
}

/**
 * Ce qui n'est pas une commande dans une configuration rendue : l'ancrage
 * du texte autour des lignes, qu'aucun niveau ne gouverne.
 */
const LIGNES_HORS_COMMANDE = /^(?:!|end|Building configuration\.\.\.|Current configuration|Using \d+ out of|\s*$)/;

/** L'espace de nommage des lignes INDENTEES sous un en-tete de bloc. */
function scopeDuBloc(entete: string): AuthScope {
  const premier = normalise(entete).split(' ')[0];
  if (premier === 'interface') return 'interface';
  if (premier === 'line') return 'line';
  return 'configure';
}

/**
 * Filtrer une configuration rendue par le niveau de la session.
 *
 * IOS ne montre que « all the commands that the current user is able to
 * modify », et Cisco documente ce filtrage comme une mesure de SECURITE
 * en nommant lui-meme le contre-exemple : sans lui, un operateur de
 * niveau intermediaire lit `snmp-server community …` et s'en sert pour
 * reprendre la machine. Ce simulateur rendait la configuration ENTIERE.
 *
 * La consequence normale — sans delegation, la configuration parait vide
 * — est celle qu'IOS produit, et non un defaut de ce filtre.
 *
 * Un bloc dont l'EN-TETE est invisible disparait en entier : montrer
 * ` ip address …` sans dire de quelle interface il s'agit ne serait ni
 * plus sur ni plus lisible.
 */
export function filterConfigForLevel(
  lignes: readonly string[],
  visible: (scope: AuthScope, command: string) => boolean,
): string[] {
  const out: string[] = [];
  let blocMasque = false;
  let scopeCourant: AuthScope = 'configure';
  for (const ligne of lignes) {
    const indentee = /^\s/.test(ligne) && ligne.trim().length > 0;
    if (LIGNES_HORS_COMMANDE.test(ligne)) {
      blocMasque = false;
      out.push(ligne);
      continue;
    }
    if (!indentee) {
      blocMasque = !visible('configure', ligne);
      scopeCourant = scopeDuBloc(ligne);
      if (!blocMasque) out.push(ligne);
      continue;
    }
    if (blocMasque) continue;
    if (visible(scopeCourant, ligne.trim())) out.push(ligne);
  }
  return out;
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
  /**
   * `commande` est la forme canonique en MOTS-CLES : une entree de vue
   * porte sur une commande, pas sur ses arguments — `commands exec
   * include ping` autorise `ping 10.0.0.1`. C'est la meme distinction
   * que pour les niveaux, et seul l'arbre la connait.
   */
  visible(nom: string, scope: AuthScope, commande: string): boolean {
    const membres = this.resolues(nom);
    if (membres.length === 0) return false;
    const cible = normalise(commande);
    const jeux = membres.map((v) => v.modes.get(scope)).filter((j) => j !== undefined);
    const couvertPar = (c: AuthViewCommand): boolean => {
      const inclus = normalise(c.command);
      return c.all ? couvre(inclus, cible) : inclus === cible;
    };
    if (jeux.some((j) => j!.exclude.some((c) => couvre(normalise(c.command), cible)))) return false;
    return jeux.some((j) => j!.include.some((c) =>
      // Un prefixe entre dans la vue reste joignable pour ce qu'il
      // complete quand `all` est pose ; et une commande incluse PLUS
      // LONGUE que ce qui est tape reste atteignable, parce que c'est un
      // arbre et non une egalite — on doit pouvoir taper `show` pour se
      // voir proposer la suite.
      couvertPar(c) || normalise(c.command).startsWith(cible + ' ')));
  }

  /**
   * La vue qui a RESERVE cette commande par `include-exclusive`, s'il y
   * en a une autre que `sauf`.
   */
  reservedBy(scope: AuthScope, commande: string, sauf: string): string | null {
    const cible = normalise(commande);
    for (const [nom, vue] of this.views()) {
      if (nom === sauf) continue;
      const jeu = vue.modes.get(scope);
      if (!jeu) continue;
      if (jeu.include.some((c) => c.exclusive && normalise(c.command) === cible)) return nom;
    }
    return null;
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
  /**
   * `canonicalizer` est optionnel pour que les appelants qui n'ont pas
   * d'arbre sous la main — les tests unitaires de ce module — restent
   * possibles ; en production il est toujours fourni, et son absence
   * fait retomber sur la comparaison litterale d'avant.
   */
  constructor(
    readonly levels: CommandLevelTable,
    readonly views: ParserViewRegistry,
    private readonly canonicalizer?: CommandCanonicalizer,
  ) {}

  /**
   * La forme sur laquelle TOUTE decision se prend.
   *
   * `sh ver` et `show version` sont la meme commande, et les comparer
   * litteralement rendait le mecanisme des niveaux contournable en
   * tapant trois lettres de moins. IOS resout l'abreviation avant
   * d'autoriser ; c'est ce que fait cette ligne, et elle est la seule de
   * la classe a decider quelle chaine les autres regardent.
   */
  private forme(scope: AuthScope, command: string): string {
    return this.canonicalizer
      ? this.canonicalizer.canonicalOrSelf(scope, command)
      : normalise(command);
  }

  /**
   * La forme sur laquelle un NIVEAU se decide : les mots-cles seuls.
   *
   * Une regle de niveau porte sur une commande, pas sur ses arguments —
   * `privilege configure level 5 hostname` gouverne `hostname R1`. Les
   * vues, elles, continuent de raisonner sur la forme complete, parce
   * qu'elles decrivent ce qu'un role a le droit de TAPER.
   */
  private formeMotsCles(scope: AuthScope, command: string): string {
    return this.canonicalizer
      ? this.canonicalizer.keywordsOrSelf(scope, command)
      : normalise(command);
  }

  authorize(input: AuthorizeInput): AuthVerdict {
    const commande = this.forme(input.scope, input.command);
    if (SORTIES.some((c) => couvre(c, commande))) return 'run';
    if (input.scope === 'exec' && TOUJOURS_EN_EXEC.some((c) => couvre(c, commande))) return 'run';

    const vue = input.principal.view;
    if (vue !== null && this.views.has(vue)) {
      return this.views.visible(
        vue, input.scope, this.formeMotsCles(input.scope, input.command),
      ) ? 'run' : 'absent';
    }

    const niveau = this.levels.levelOf(
      input.scope, this.formeMotsCles(input.scope, input.command), input.defaultLevel);
    return niveau <= input.principal.level ? 'run' : 'absent';
  }

  /** L'operateur a-t-il DESCENDU cette commande jusqu'a la session ? */
  estAccordee(input: AuthorizeInput): boolean {
    if (input.principal.view !== null) return false;
    const niveau = this.levels.levelOf(
      input.scope, this.formeMotsCles(input.scope, input.command), input.defaultLevel);
    return niveau <= input.principal.level && niveau < input.defaultLevel;
  }

  /**
   * Poser le niveau d'une commande, sous sa forme CANONIQUE.
   *
   * Les trois ecrivains — `privilege`, `no privilege`, `privilege reset`
   * — ecrivaient la `Map` a la main, chacun avec sa propre derivation de
   * cle : deux d'entre elles minusculaient, la troisieme non, si bien
   * qu'une regle posee `privilege exec level 5 Reload` etait rendue dans
   * la configuration et que `privilege exec reset Reload` ne la trouvait
   * pas. Les faire passer ici est ce qui rend la cle unique.
   */
  setCommandLevel(scope: AuthScope, command: string, level: number, all = false): void {
    this.levels.setLevel(scope, this.formeMotsCles(scope, command), level, all);
  }

  /** Retire la regle et rend le niveau qu'elle portait, ou `undefined`. */
  resetCommandLevel(scope: AuthScope, command: string): number | undefined {
    return this.levels.reset(scope, this.formeMotsCles(scope, command));
  }

  /**
   * La forme sous laquelle une entree de VUE est rangee : ses MOTS-CLES
   * canoniques. Une entree porte sur une commande et laisse ses
   * arguments libres — `commands exec include ping` autorise
   * `ping 10.0.0.1`.
   */
  formeDeVue(scope: AuthScope, command: string): string {
    return this.formeMotsCles(scope, command);
  }

  /** Les regles d'un espace dont le niveau est atteignable par la session. */
  reglesAccordees(scope: AuthScope, level: number): Array<{ commande: string; niveau: number }> {
    return this.levels.grantedAtOrBelow(scope, level);
  }

  /**
   * Le niveau EFFECTIF d'une commande — celui d'IOS apres les regles
   * `privilege`, lu sur la forme canonique.
   *
   * C'est ce que l'autorisation AAA par commande doit interroger :
   * `aaa authorization commands N` gouverne les commandes DE niveau N,
   * pas les commandes tapees par une session de niveau N. Choisir la
   * liste sur le niveau de la session soumettait `show version` — niveau
   * 1 — a la liste 15 des lors qu'un administrateur la tapait.
   */
  levelOfCommand(input: AuthorizeInput): number {
    return this.levels.levelOf(
      input.scope, this.formeMotsCles(input.scope, input.command), input.defaultLevel,
    );
  }
}

/** L'espace de nommage des regles qui gouverne un mode de la CLI. */
export function scopeForMode(mode: string): AuthScope {
  if (mode === 'user' || mode === 'privileged') return 'exec';
  if (mode === 'config-if' || mode === 'config-subif') return 'interface';
  if (mode === 'config-line') return 'line';
  return 'configure';
}
