/**
 * CommandTrie - Trie-based command parser for Cisco IOS CLI emulation
 *
 * Supports:
 *   - Abbreviation matching (e.g., "sh" → "show", "conf t" → "configure terminal")
 *   - Ambiguity detection ("s" matches "show" and "shutdown" → ambiguous)
 *   - Context-aware help (?) with proper Cisco IOS semantics:
 *       "sh?"    → list keywords starting with "sh" (prefix listing)
 *       "show ?" → list subcommands of "show" (subcommand listing)
 *   - <cr> indicator when a command is already executable
 *   - Parameter validation (INT, STRING, IP_ADDR, INTERFACE, etc.)
 *   - Tab completion (unique prefix → complete, ambiguous → null)
 *
 * Architecture:
 *   Each node in the trie represents a keyword. Children are possible
 *   next tokens. Leaf/executable nodes have an action callback.
 */

import { descriptionForKeyword } from './CliKeywordDescriptions';
import { outsideEveryAnnouncedRange } from '@/cli/ArgumentTypes';
import {
  type CommandSpec, validateCommandSpec, specIsGreedy, specAppliesTo,
} from './cli/CommandSpec';
import {
  SUGGESTION_SOURCES,
  type SuggestionCandidate, type SuggestionOrigin, type SuggestionRequest,
  type SuggestionTrieAccess,
} from './cli/SuggestionSources';

// ─── Parameter Types ────────────────────────────────────────────────

export type ParamType = 'INT' | 'STRING' | 'IP_ADDR' | 'SUBNET_MASK' | 'MAC_ADDR' | 'INTERFACE' | 'VLAN_LIST' | 'WORD' | 'ENUM';

export interface ParamSpec {
  name: string;
  type: ParamType;
  description: string;
  optional?: boolean;
  validator?: (value: string) => boolean;
  /** Bornes d'un `INT`, rendues `<min-max>` comme IOS le fait. */
  range?: readonly [number, number];
  rangeIsAdvisory?: boolean;
  /** Rendu littéral imposé, quand le type ne suffit pas (`LINE`, `hh:mm`). */
  literal?: string;
  /**
   * Les FORMES qu'une même place accepte, quand il y en a plusieurs.
   *
   * `ip access-group ?` en rend trois — `<1-199>`, `<1300-2699>`,
   * `WORD` — et un `ParamSpec` n'en rendait qu'une, si bien que la place
   * était décrite par l'aide de la SUIVANTE. Ce n'est pas un `ENUM` :
   * ce ne sont pas des valeurs admises mais des types, chacun avec sa
   * propre description, exactement comme la vraie machine les liste.
   */
  alternatives?: ReadonlyArray<{ literal: string; description: string }>;
  /** Valeurs admises d'un `ENUM`, rendues chacune comme un mot-clé propre. */
  values?: ReadonlyArray<{ keyword: string; description: string }>;
  /**
   * Les valeurs servent à `?` et JAMAIS à la complétion par Tab.
   *
   * Existe pour `interface <type>` sur VRP : `?` doit nommer les types
   * (`GigabitEthernet`, `LoopBack`…), tandis que Tab doit compléter les
   * PORTS RÉELS de la machine — deux réponses différentes à deux
   * questions différentes, et les confondre supprimait les seconds,
   * puisqu'un mot-clé l'emporte sur une valeur dynamique.
   */
  helpOnly?: boolean;
}

/**
 * IOS ne nomme pas ses arguments, il les TYPE : `A.B.C.D`, `<1-4094>`,
 * `WORD`, `LINE`. Un `<mask>` dans une aide se voit immédiatement.
 */
export function renderParamKeyword(param: ParamSpec): string {
  if (param.literal) return param.literal;
  switch (param.type) {
    case 'IP_ADDR':
    case 'SUBNET_MASK':
      return 'A.B.C.D';
    case 'MAC_ADDR':
      return 'H.H.H';
    case 'INT':
      return param.range ? `<${param.range[0]}-${param.range[1]}>` : '<0-4294967295>';
    case 'INTERFACE':
      return 'WORD';
    case 'VLAN_LIST':
      return 'WORD';
    case 'STRING':
      return 'LINE';
    default:
      return 'WORD';
  }
}

// ─── Trie Node ──────────────────────────────────────────────────────

export interface CommandNode {
  /** The full keyword this node represents */
  keyword: string;
  /** Description shown in ? help */
  description: string;
  /** Child keyword nodes */
  children: Map<string, CommandNode>;
  /** Parameter specs for dynamic arguments (e.g., <vlan-id>) */
  params: ParamSpec[];
  /** If this node is executable, the action to perform */
  action?: CommandAction;
  /** If true, this node accepts remaining args as-is */
  greedy?: boolean;
  minArgs?: number;
  /**
   * Nombre MAXIMAL d'arguments accepte. Le trie ne portait qu'un
   * minimum, donc un mot en trop derriere une commande gloutonne etait
   * silencieusement ignore : `sysname R1 R2` prenait `R1` et jetait
   * `R2`. Non declare, il n'y a pas de plafond — le comportement de
   * toutes les commandes existantes est inchange.
   */
  maxArgs?: number;
  /**
   * `leadingOnly` : un mot-clé qui ne peut venir qu'AVANT l'argument.
   * `ping ip|ipv6` choisit le protocole, donc il précède la cible ;
   * `ping X ip` n'existe pas, et le proposer après une cible déjà tapée
   * décrivait une commande qui n'existe pas. `repeat`, `size`… sont
   * l'inverse : ce sont des options de queue.
   */
  hintSuggestions?: Array<{
    keyword: string; description: string; leadingOnly?: boolean;
    valeur?: ReadonlyArray<{
      keyword: string; description: string;
      valeur?: ReadonlyArray<{ keyword: string; description: string }>;
    }>;
  }>;
  _hintOnly?: boolean;
  /**
   * Ce mot appartient au SOCLE : il n'est plus un argument du parent
   * glouton, et il ne s'execute pas ici. L'aide s'y arrete, l'execution
   * continue de passer par le parent.
   */
  _migre?: boolean;
  _elague?: boolean;
  /**
   * Enregistre POUR ETRE REFUSE, donc jamais annonce.
   *
   * `show ip sla monitor` existe uniquement pour que le glouton
   * `show ip sla` n'avale pas `monitor` et ne reponde pas a sa place :
   * IOS 15 a supprime cette branche, et le refus est le bon
   * comportement. L'aide le proposait pourtant, c'est-a-dire qu'elle
   * enseignait une syntaxe supprimee et menait droit au caret.
   */
  _neJamaisAnnoncer?: boolean;
  /** Les suites de ce noeud, ECRITES plutot que lues dans son source. */
  _continuations?: string[];
  _passthrough?: boolean;
  /**
   * Un nœud PUREMENT INDICATIF créé par `describeArgs` sous une commande
   * greedy décrit un mot-clé que le handler du parent absorbe. Il n'a
   * donc ni action ni greedy à lui — et l'aide en tirait deux conclusions
   * fausses : la commande n'était pas exécutable ici (`<cr>` absent alors
   * qu'IOS le montre) et rien ne pouvait suivre le mot-clé
   * (`tacacs-server host 1.1.1.1 key ?` répondait `% Invalid input` pour
   * une commande qui s'exécute très bien). Ces deux drapeaux disent ce
   * que le VRAI handler, lui, peut faire.
   */
  _porteAction?: boolean;
  _porteGreedy?: boolean;
  /**
   * Le nœud est enregistré greedy pour des raisons d'analyse, mais la
   * commande ne prend AUCUN argument : `cdp run ?` n'offre que `<cr>`
   * sur IOS, pas un `WORD` qui laisserait croire qu'il manque quelque
   * chose. Sans ce marqueur, le repli de dernier recours invente ce
   * `WORD` et lui recopie la description du parent.
   */
  _noArgument?: boolean;
  /**
   * L'arité ne suffit pas toujours à dire si la commande est complète.
   * `interface GigabitEthernet` a bien son argument — le TYPE — et
   * reste refusée, parce qu'il y manque le numéro ; or le numéro et le
   * type s'écrivent aussi bien en UN jeton
   * (`interface GigabitEthernet0/0/0`), forme que déclarer deux
   * arguments requis interdirait. Compter les jetons ne peut pas
   * trancher entre les deux ; les REGARDER le peut.
   *
   * Ce prédicat est consulté en plus de l'arité, jamais à sa place :
   * un nœud qui n'en déclare pas se comporte exactement comme avant.
   */
  executableWhen?: (args: readonly string[]) => boolean;
  /**
   * Keywords auto-extracted from the greedy handler's source (lazy,
   * computed once). Undefined = not yet computed.
   */
  _autoKeywords?: ReadonlyArray<{ keyword: string; description: string }>;
  _spec?: CommandSpec;
}

export type CommandAction = (args: string[], rawLine: string) => string;

/**
 * Supplies live device values (real interfaces, created VLANs, configured
 * IPs, …) for Tab completion and ? help of parameter positions. Purely
 * additive: static keyword completion never consults it. `path` carries
 * the canonical keywords matched so far (most registrations are greedy
 * and carry no ParamSpec, so the path is the primary dispatch key);
 * `paramType` is set when the node declares a typed ParamSpec.
 */
export interface DynamicCompletionContext {
  readonly path: readonly string[];
  readonly paramType: ParamType | null;
  readonly partial: string;
}

export interface DynamicParamResolver {
  candidatesFor(context: DynamicCompletionContext): readonly string[];
  rangeFor?(context: DynamicCompletionContext): readonly [number, number] | null;
}

// ─── Match Result ───────────────────────────────────────────────────

export interface MatchResult {
  status: 'ok' | 'ambiguous' | 'incomplete' | 'invalid';
  refusePar?: 'argument';
  /** The matched node (if ok or incomplete) */
  node?: CommandNode;
  /** The collected arguments for parameter nodes */
  args: string[];
  /** Error message (if ambiguous or invalid) */
  error?: string;
  /**
   * Character offset of the error in the raw input (ambiguous/incomplete/
   * invalid) — Cisco's own `error` string only uses this for `invalid`
   * (its own caret marker), but Huawei VRP's caret convention is uniform
   * across all three failure kinds, so callers building VRP wording need
   * it for ambiguous/incomplete too.
   */
  errorPos?: number;
  /** Matched keywords for ? completion context */
  matchedKeywords: string[];
}

// ─── Command Trie ───────────────────────────────────────────────────

export class CommandTrie {
  private root: CommandNode;
  private canonicalDescriptions = new Map<string, string>();
  private dynamicResolver: DynamicParamResolver | null = null;

  setDynamicResolver(resolver: DynamicParamResolver | null): void {
    this.dynamicResolver = resolver;
  }

  /**
   * Optional diagnostic observer, fired whenever a registration overwrites a
   * path that already had an action on the same trie. Off by default (zero
   * production cost); tests enable it to assert the command tree is free of
   * accidental duplicate registrations (a duplicate silently shadows the
   * earlier handler, which is almost always a bug). Set back to `null` to
   * disable.
   */
  static overwriteObserver: ((info: { path: string; kind: 'register' | 'registerGreedy' }) => void) | null = null;

  constructor() {
    this.root = this.createNode('', 'Root');
  }

  private createNode(keyword: string, description: string): CommandNode {
    return { keyword, description, children: new Map(), params: [] };
  }

  /**
   * Provide a canonical description for a top-level keyword. It is used in ?
   * help only when the node was left with the placeholder description that
   * equals its own keyword (i.e. the keyword is just a prefix of longer
   * commands and no command terminates exactly on it).
   */
  setCanonicalDescription(keyword: string, description: string): void {
    this.canonicalDescriptions.set(keyword.toLowerCase(), description);
  }

  /**
   * Import top-level commands from another trie that this trie does not
   * already define. Models Cisco's "privileged EXEC is a superset of user
   * EXEC": user commands become available in privileged mode without
   * duplicating their registration, while privileged-specific overrides
   * (same keyword) are preserved.
   */
  importMissingFrom(other: CommandTrie): void {
    for (const [kw, node] of other.root.children) {
      if (!this.root.children.has(kw)) {
        this.root.children.set(kw, CommandTrie.cloneNode(node));
      }
    }
  }

  /**
   * Copy the children of a top-level keyword node (e.g. all `show <x>`
   * sub-commands) from this trie into a target trie's same keyword node,
   * skipping a denylist. Models Cisco's "most show commands are
   * privilege-1": the privileged trie's show family is mirrored into user
   * EXEC except the genuinely priv-15 entries.
   *
   * A keyword the target already has is merged, not skipped: a partial
   * registration such as `show interfaces counters errors` leaves a bare
   * `interfaces` node with no action, which otherwise masked the whole
   * privileged subtree behind it. The merge is strictly additive — an
   * action is adopted only where the target has none, so a deliberate
   * user-EXEC override still wins.
   */
  copySubtreeChildrenInto(keyword: string, target: CommandTrie, deny: ReadonlySet<string>): void {
    const src = this.root.children.get(keyword.toLowerCase());
    const dst = target.root.children.get(keyword.toLowerCase());
    if (!src || !dst) return;
    for (const [k, node] of src.children) {
      if (deny.has(k)) continue;
      const existing = dst.children.get(k);
      if (!existing) dst.children.set(k, CommandTrie.cloneNode(node));
      else CommandTrie.mergeNodeInto(node, existing);
    }
  }

  /**
   * Drop named children of a top-level keyword node. Paired with
   * `copySubtreeChildrenInto` so its denylist is enforced whatever the
   * device registered by hand: the router registers `show running-config`
   * on the user trie directly, which no amount of care during mirroring
   * can undo.
   */
  pruneSubtreeChildren(keyword: string, deny: ReadonlySet<string>): void {
    const node = this.root.children.get(keyword.toLowerCase());
    if (!node) return;
    for (const k of deny) node.children.delete(k);
  }

  /**
   * Ce que le SOCLE declare a cet endroit, pour le seul calcul
   * d'ambiguite.
   *
   * Elaguer un chemin migre lui retire son action et LAISSE son noeud,
   * si bien qu'une abreviation continue de le rencontrer comme rival.
   * Une famille migree A LA MAIN, dont on supprime l'enregistrement,
   * n'en laisse aucun — et l'abreviation cesse alors d'etre ambigue :
   * mesure faite, `no ip rout` posait `no ip routing` en silence, une
   * faute de frappe coupant le routage de la machine.
   *
   * Le port REND les mots, il ne cree aucun noeud. Une premiere version
   * posait un noeud temoin par chemin migre, et la mesure a montre le
   * cout : `interface FastEthernet` est un mot-cle du socle, donc le
   * temoin ajoutait un enfant au trie et la tabulation proposait la
   * forme ET les huit ports, la ou elle ecrit le type d'un coup. Un
   * rival ne doit pas devenir un candidat.
   */
  private rivauxDuSocle: ((path: readonly string[], prefix: string) => string[]) | null = null;

  setRivalKeywordsPort(
    port: ((path: readonly string[], prefix: string) => string[]) | null,
  ): void {
    this.rivauxDuSocle = port;
  }

  prunePaths(paths: readonly string[]): void {
    // Une declaration EN ATTENTE deviendrait un noeud reel apres
    // l'elagage, donc un chemin migre reapparaitrait dans le trie.
    this.viderDeclarationsEnAttente();
    for (const path of paths) {
      const words = path.toLowerCase().split(/\s+/).filter(Boolean);
      if (words.length === 0) continue;
      let node = this.root;
      let missing = false;
      for (const word of words.slice(0, -1)) {
        const next = node.children.get(word) ?? this.marqueurSousGlouton(node, word);
        if (!next) { missing = true; break; }
        node = next;
      }
      if (missing) continue;

      const last = words[words.length - 1];
      const target = node.children.get(last) ?? this.marqueurSousGlouton(node, last);
      if (!target) continue;

      // Elaguer un chemin retire CE chemin, pas ce qui pend dessous.
      // Supprimer le noeud emportait son sous-arbre : migrer
      // `clear logging` effacait `clear logging persistent`, une commande
      // que personne n'avait migree et que plus rien n'annoncait.
      delete target.action;
      delete target.greedy;
      delete target.minArgs;
      delete target.hintSuggestions;
      target.params = [];
      /*
       * Une continuation DECLAREE nomme l'argument d'une commande de ce
       * trie : une fois celle-ci partie au socle, elle ne decrit plus
       * rien qu'il sache faire. La laisser faisait annoncer par `?` un
       * mot que la tabulation ne completait plus — la parite exacte que
       * `probe-cli-help-parity-ratchet` mesure. Le marqueur sert aussi
       * a REFUSER les declarations d'apres, `appliquerContinuations`
       * s'executant apres l'elagage.
       */
      delete target._continuations;
      delete target._autoKeywords;
      target._elague = true;
      // Le noeud reste pour ses enfants, mais il n'est plus une
      // COMMANDE : sans ce drapeau, la marche s'y arrete et rend
      // `% Incomplete command.` la ou la commande est simplement
      // absente — deux diagnostics qui envoient l'operateur a deux
      // endroits differents.
      target._hintOnly = true;
    }
  }

  /**
   * Le noeud qu'un chemin MIGRE laisse sous un parent glouton.
   *
   * `show aaa` est enregistre glouton : une fois
   * `show aaa local user lockout` parti au socle, plus rien n'arretait
   * la marche et `show aaa local ?` annoncait le `<cr>` du parent, pour
   * une frappe que la meme machine declare incomplete. Le marqueur ne se
   * propose pas et ne s'execute pas — il dit seulement que ce mot n'est
   * plus un argument.

   */
  private marqueurSousGlouton(node: CommandNode, mot: string): CommandNode | undefined {
    if (!node.greedy && !node._porteGreedy) return undefined;

    const cree = this.createNode(mot, '');
    cree._hintOnly = true;
    cree._migre = true;
    node.children.set(mot, cree);
    return cree;
  }

  private static cloneNode(src: CommandNode): CommandNode {
    const copy: CommandNode = { ...src, children: new Map(), params: [...src.params] };
    for (const [k, child] of src.children) copy.children.set(k, CommandTrie.cloneNode(child));
    return copy;
  }

  /** Fill the gaps of `dst` from `src`, never overwriting what `dst` defines. */
  private static mergeNodeInto(src: CommandNode, dst: CommandNode): void {
    if (!dst.action && src.action) {
      dst.action = src.action;
      dst.greedy = src.greedy;
      dst._hintOnly = false;
      if (dst.params.length === 0) dst.params = src.params;
      if (dst.description === dst.keyword) dst.description = src.description;
    }
    for (const [k, child] of src.children) {
      const existing = dst.children.get(k);
      if (!existing) dst.children.set(k, CommandTrie.cloneNode(child));
      else CommandTrie.mergeNodeInto(child, existing);
    }
  }

  private resolveDescription(node: CommandNode): string {
    if (node.description === node.keyword || node.description === '') {
      return this.canonicalDescriptions.get(node.keyword)
        ?? descriptionForKeyword(node.keyword)
        ?? node.description;
    }
    return node.description;
  }

  // ─── Tree Construction ──────────────────────────────────────────

  /**
   * Register a command path in the trie.
   * Path is a space-separated string of keywords, optionally ending with <param> specs.
   *
   * Example:
   *   trie.register('show mac address-table', 'Display MAC table', handler);
   *   trie.register('vlan', 'Create VLAN', handler, [{ name: 'id', type: 'INT', description: 'VLAN ID' }]);
   */
  private platform: string | null = null;

  setPlatform(platform: string | null): void {
    this.platform = platform;
  }

  getPlatform(): string | null {
    return this.platform;
  }

  declare(spec: CommandSpec): void {
    validateCommandSpec(spec);
    if (!specAppliesTo(spec, this.platform)) return;
    if (specIsGreedy(spec)) {
      this.registerGreedy(spec.path, spec.description, spec.run, spec.continuations);
      if (spec.args && spec.args.length > 0) this.describeArgs(spec.path, spec.args);
    } else {
      this.register(spec.path, spec.description, spec.run,
        spec.args ? [...spec.args] : undefined);
    }
    const node = this.nodeAt(spec.path);
    if (node) node._spec = spec;
  }

  declaredSpecs(): CommandSpec[] {
    const out: CommandSpec[] = [];
    const walk = (node: CommandNode): void => {
      if (node._spec) out.push(node._spec);
      for (const child of node.children.values()) walk(child);
    };
    walk(this.root);
    return out;
  }

  declaredConfigLines(device: unknown): string[] {
    const lines: string[] = [];
    for (const spec of this.declaredSpecs()) {
      if (spec.serialize) lines.push(...spec.serialize(device));
    }
    return lines;
  }

  register(path: string, description: string, action: CommandAction, params?: ParamSpec[]): void {
    const keywords = path.split(/\s+/);
    let node = this.root;

    for (let i = 0; i < keywords.length; i++) {
      const kw = keywords[i].toLowerCase();
      let child = node.children.get(kw);
      if (!child) {
        child = this.createNode(kw, i === keywords.length - 1 ? description : kw);
        node.children.set(kw, child);
      }
      child._hintOnly = false;
      if (i === keywords.length - 1) {
        child.description = description;
      }
      node = child;
    }

    if (node.action && CommandTrie.overwriteObserver) {
      CommandTrie.overwriteObserver({ path, kind: 'register' });
    }
    node.action = action;
    if (params) node.params = params;
  }

  /**
   * Cette commande est enregistree POUR ETRE REFUSEE : elle ne doit pas
   * etre annoncee. Elle continue de se faire reconnaitre — c'est tout
   * l'objet de son enregistrement, empecher un glouton voisin de
   * repondre a sa place — mais `?` et la tabulation l'ignorent.
   */
  neJamaisAnnoncer(path: string): void {
    const node = this.nodeAt(path);
    if (node) node._neJamaisAnnoncer = true;
  }

  /**
   * Ce chemin est parti au socle : rien ne s'y accroche plus.
   *
   * Les decorations d'apres-coup — suites declarees, arguments decrits,
   * arite exigee, description de noeud — s'executent APRES l'elagage,
   * donc elles reposaient leurs mots sur des noeuds vides. `?` annoncait
   * alors ce que plus rien n'executait, et c'est le socle qui porte
   * desormais la declaration.
   */
  private estElague(path: string): boolean {
    return this.nodeAt(path)?._elague === true;
  }

  registerSuggestions(
    path: string,
    suggestions: ReadonlyArray<{ keyword: string; description: string; leadingOnly?: boolean }>,
  ): void {
    if (this.estElague(path)) return;
    const keywords = path.split(/\s+/).map(k => k.toLowerCase());
    let node: CommandNode = this.root;
    for (const kw of keywords) {
      let child = node.children.get(kw);
      if (!child) {
        child = this.createNode(kw, kw);
        child._hintOnly = true;
        node.children.set(kw, child);
      }
      node = child;
    }
    node.hintSuggestions = [...suggestions];
  }

  /**
   * Register a command with greedy argument consumption.
   * After matching keywords, all remaining tokens are passed as args.
   *
   * `continuations` declares the fixed sub-keywords the greedy handler
   * accepts (e.g. `show interfaces` → status/switchport/counters). They
   * are surfaced by Tab completion and `?` help even though the handler
   * parses them internally — keeping the completion vocabulary next to
   * the code that consumes it.
   */
  registerGreedy(
    path: string,
    description: string,
    action: CommandAction,
    continuations?: ReadonlyArray<string | { keyword: string; description: string }>,
  ): void {
    const keywords = path.split(/\s+/);
    let node = this.root;

    for (let i = 0; i < keywords.length; i++) {
      const kw = keywords[i].toLowerCase();
      let child = node.children.get(kw);
      if (!child) {
        child = this.createNode(kw, i === keywords.length - 1 ? description : kw);
        node.children.set(kw, child);
      }
      child._hintOnly = false;
      if (i === keywords.length - 1) {
        child.description = description;
      }
      node = child;
    }

    if (node.action && CommandTrie.overwriteObserver) {
      CommandTrie.overwriteObserver({ path, kind: 'registerGreedy' });
    }
    node.action = action;
    node.greedy = true;
    if (continuations && continuations.length > 0) {
      this.addContinuations(node, continuations);
    }
  }

  /**
   * Declare fixed sub-keyword continuations for an already-registered
   * command path (greedy or not). Additive to any existing hints; makes
   * handler-parsed keywords completable without changing execution.
   */
  addCompletionKeywords(
    path: string,
    continuations: ReadonlyArray<string | { keyword: string; description: string; leadingOnly?: boolean }>,
  ): void {
    if (this.estElague(path)) return;
    const keywords = path.split(/\s+/).map(k => k.toLowerCase());
    let node: CommandNode = this.root;
    for (const kw of keywords) {
      const exact = node.children.get(kw);
      const child = exact ?? this.prefixMatch(node, kw)[0];
      if (!child) return;
      node = child;
    }
    this.addContinuations(node, continuations);
  }

  private addContinuations(
    node: CommandNode,
    continuations: ReadonlyArray<string | { keyword: string; description: string; leadingOnly?: boolean }>,
  ): void {
    const existing = node.hintSuggestions ? [...node.hintSuggestions] : [];
    const seen = new Set(existing.map(h => h.keyword.toLowerCase()));
    for (const c of continuations) {
      const entry = typeof c === 'string' ? { keyword: c, description: '' } : c;
      if (seen.has(entry.keyword.toLowerCase())) continue;
      seen.add(entry.keyword.toLowerCase());
      existing.push(entry);
    }
    node.hintSuggestions = existing;
  }

  // ─── Command Matching ───────────────────────────────────────────

  /**
   * Parse and match user input against the trie.
   * Supports abbreviated keywords (unique prefix matching).
   */
  match(input: string): MatchResult {
    this.viderDeclarationsEnAttente();
    const tokens = input.trim().split(/\s+/).filter(t => t.length > 0);
    if (tokens.length === 0) {
      return { status: 'ok', args: [], matchedKeywords: [] };
    }

    let node = this.root;
    const args: string[] = [];
    const matchedKeywords: string[] = [];
    let paramIdx = 0;

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      const tokenLower = token.toLowerCase();

      // Try exact match first, then prefix match
      const exactChildRaw = node.children.get(tokenLower);
      // Un noeud de PASSAGE ne s'execute jamais : il existe pour que
      // l'aide s'arrete la, et l'execution doit continuer de passer par
      // le parent glouton — sans quoi `no logging synchronous` tomberait
      // sur le marqueur laisse par `no logging trap`.
      const exactChild = exactChildRaw && !exactChildRaw._migre
        && (!exactChildRaw._hintOnly || this.leadsToACommand(exactChildRaw))
        ? exactChildRaw : undefined;
      if (exactChild) {
        node = exactChild;
        matchedKeywords.push(node.keyword);
        paramIdx = 0;

        // If this node is greedy AND has remaining tokens, check children first
        // before consuming greedily. This allows registered subpaths to take
        // precedence (e.g., "display interface brief" over "display interface <name>").
        if (node.greedy && i < tokens.length - 1) {
          const nextTk = tokens[i + 1].toLowerCase();
          const exactSuite = node.children.get(nextTk);
          const childMatch = (exactSuite && !this.estMigre(exactSuite) ? exactSuite : undefined)
            || this.prefixMatch(node, nextTk);
          const hasChildMatch = Array.isArray(childMatch) ? childMatch.length > 0 : !!childMatch;
          if (!hasChildMatch) {
            args.push(...tokens.slice(i + 1));
            return this.finish(node, args, matchedKeywords, input);
          }
        }
        continue;
      }

      // Prefix match
      const matches = this.prefixMatch(node, tokenLower);

      if (matches.length === 1) {
        // Un seul candidat EXECUTABLE ici, mais la machine en declare un
        // autre au socle : c'est une ambiguite, pas une resolution.
        const auSocle = matches[0].keyword === tokenLower ? []
          : (this.rivauxDuSocle?.(matchedKeywords, tokenLower) ?? [])
            .filter(mot => mot !== matches[0].keyword);
        if (auSocle.length > 0) {
          return {
            status: 'ambiguous',
            args,
            matchedKeywords,
            error: `% Ambiguous command: "${token}" (matches: `
              + `${[matches[0].keyword, ...auSocle].join(', ')})`,
            errorPos: input.indexOf(token),
          };
        }
        node = matches[0];
        matchedKeywords.push(node.keyword);
        paramIdx = 0;

        // Same child-first check for greedy nodes
        if (node.greedy && i < tokens.length - 1) {
          const nextTk = tokens[i + 1].toLowerCase();
          const exactSuite = node.children.get(nextTk);
          const childMatch = (exactSuite && !this.estMigre(exactSuite) ? exactSuite : undefined)
            || this.prefixMatch(node, nextTk);
          const hasChildMatch = Array.isArray(childMatch) ? childMatch.length > 0 : !!childMatch;
          if (!hasChildMatch) {
            args.push(...tokens.slice(i + 1));
            return this.finish(node, args, matchedKeywords, input);
          }
        }
        continue;
      }

      if (matches.length > 1) {
        /*
         * L'abreviation se juge sur le MOT, jamais sur ce qui suit. Ce
         * bloc departageait les candidats en regardant si le mot
         * suivant leur convenait : `ip rout 192.168.9.0 …` posait donc
         * la route, `route` etant le seul des deux a accepter une
         * adresse, alors que `ip rout` seul etait refuse. La meme
         * frappe decidait ou non selon ce qu'on ecrivait apres, et une
         * faute de frappe appliquait une commande que personne n'avait
         * tapee. IOS tranche l'inverse, sur une saisie qui porte
         * pourtant un mot de plus : `con t` rend `% Ambiguous command`.
         */
        const matchNames = matches.map(m => m.keyword).join(', ');
        return {
          status: 'ambiguous',
          args,
          matchedKeywords,
          error: `% Ambiguous command: "${token}" (matches: ${matchNames})`,
          errorPos: input.indexOf(token),
        };
      }

      // No keyword match — try as parameter
      if (paramIdx < node.params.length) {
        const param = node.params[paramIdx];
        if (this.validateParam(token, param)) {
          args.push(token);
          paramIdx++;
          continue;
        }
      }

      // If node has greedy action, remaining tokens are args
      if (node.greedy) {
        args.push(...tokens.slice(i));
        return this.finish(node, args, matchedKeywords, input);
      }

      // If current node has params and we already have an action, pass remaining as args
      if (node.action && node.params.length > 0) {
        args.push(token);
        paramIdx++;
        continue;
      }

      // Invalid input
      const pos = input.indexOf(token);
      return {
        status: 'invalid',
        args,
        matchedKeywords,
        error: this.formatInvalidInput(input, pos),
        errorPos: pos,
      };
    }

    // Reached end of tokens
    if (node.action) {
      return this.finish(node, args, matchedKeywords, input);
    }

    // Check if there are required params not yet supplied
    if (node.params.length > 0 && args.length < node.params.filter(p => !p.optional).length) {
      return { status: 'incomplete', node, args, matchedKeywords, error: '% Incomplete command.', errorPos: input.trimEnd().length };
    }

    // Node exists but has no action and has children → incomplete
    if (node.children.size > 0) {
      return { status: 'incomplete', node, args, matchedKeywords, error: '% Incomplete command.', errorPos: input.trimEnd().length };
    }

    return { status: 'incomplete', node, args, matchedKeywords, error: '% Incomplete command.', errorPos: input.trimEnd().length };
  }

  private requiredArity(node: CommandNode): number {
    return Math.max(
      node.params.filter(p => !p.optional).length,
      node.minArgs ?? 0,
    );
  }

  private isExecutableAt(
    node: CommandNode, suppliedArgs: number, args?: readonly string[],
  ): boolean {
    if ((!node.action && !node._porteAction)
      || suppliedArgs < this.requiredArity(node)) return false;
    return node.executableWhen ? node.executableWhen(args ?? []) : true;
  }

  private isContinuationKeyword(node: CommandNode, token: string): boolean {
    const key = token.toLowerCase();
    if (node.children.has(key)) return true;
    if (node.hintSuggestions?.some(h => h.keyword.toLowerCase() === key)) return true;
    return this.autoContinuations(node).some(a => a.keyword.toLowerCase() === key);
  }

  private descendantShortfall(node: CommandNode, args: readonly string[]): boolean {
    let target = node;
    let consumed = 0;
    while (consumed < args.length) {
      const child = target.children.get(args[consumed].toLowerCase());
      if (!child) break;
      target = child;
      consumed++;
    }
    if (target === node) return false;
    return args.length - consumed < this.requiredArity(target);
  }

  private declarationHolder(
    node: CommandNode, args: readonly string[],
  ): { node: CommandNode; firstArg: number } {
    let holder = node;
    let firstArg = 0;
    while (firstArg < args.length) {
      const child = holder.children.get(args[firstArg].toLowerCase());
      if (!child || child.params.length === 0) break;
      holder = child;
      firstArg++;
    }
    return { node: holder, firstArg };
  }

  private rejectAnnouncedRange(
    node: CommandNode, args: readonly string[], input: string, matchedKeywords: string[],
  ): MatchResult | null {
    const reject = (value: string): MatchResult => {
      const pos = input.indexOf(value);
      return {
        status: 'invalid',
        refusePar: 'argument',
        args: [...args],
        matchedKeywords,
        error: this.formatInvalidInput(input, pos),
        errorPos: pos,
      };
    };

    for (let i = 0; i < args.length; i++) {
      if (!/^\d+$/.test(args[i])) continue;
      const announced = this.valeurAttendue(node, args.slice(0, i));
      if (!announced || announced.length === 0) continue;
      if (!outsideEveryAnnouncedRange(args[i], announced)) continue;
      return reject(args[i]);
    }

    const { node: holder, firstArg } = this.declarationHolder(node, args);
    for (let k = 0; k < holder.params.length && firstArg + k < args.length; k++) {
      const spec = holder.params[k];
      const value = args[firstArg + k];
      if (!/^\d+$/.test(value)) continue;
      if (holder.children.has(value.toLowerCase())) continue;
      if (spec.alternatives) {
        if (outsideEveryAnnouncedRange(
          value, spec.alternatives.map((a) => ({ keyword: a.literal })))) return reject(value);
        continue;
      }
      if (spec.type !== 'INT' || !spec.range || spec.validator) continue;
      const range = spec.rangeIsAdvisory
        ? this.resolvedRange(spec, { path: matchedKeywords, partial: '', keyword: holder.keyword })
        : spec.range;
      if (!range) continue;
      if (Number(value) >= range[0] && Number(value) <= range[1]) continue;
      return reject(value);
    }
    return null;
  }

  private finish(
    node: CommandNode,
    args: string[],
    matchedKeywords: string[],
    input: string,
  ): MatchResult {
    const rejected = this.rejectAnnouncedRange(node, args, input, matchedKeywords);
    if (rejected) return rejected;
    const keywordForm = args.length > 0 && this.isContinuationKeyword(node, args[0]);
    const arityMet = keywordForm || this.isExecutableAt(node, args.length, args);
    if (arityMet && !!node.action && !this.descendantShortfall(node, args)) {
      return { status: 'ok', node, args, matchedKeywords };
    }
    return {
      status: 'incomplete', node, args, matchedKeywords,
      error: '% Incomplete command.', errorPos: input.trimEnd().length,
    };
  }

  // ─── Help & Completion ──────────────────────────────────────────

  /**
   * Get help completions with proper Cisco IOS ? semantics.
   *
   * Real Cisco IOS distinguishes:
   *   "sh?"     → prefix listing: which keywords start with "sh"? → "show"
   *   "show ?"  → subcommand listing: what comes after "show"? → children of show
   *   "show?"   → prefix listing: which keywords match "show"? → "show"
   *
   * The distinction is: does the input end with a space before the ?
   *
   * @param inputBeforeQuestion The raw input BEFORE the '?' character
   *   e.g. for user typing "sh?", pass "sh"
   *        for user typing "show ?", pass "show "
   */
  /**
   * Un même arbre sert parfois plusieurs contextes — `config-router` est
   * partagé par RIP, EIGRP et BGP, et leurs gestionnaires refusent déjà
   * ce qui n'appartient pas au protocole courant. L'aide, elle, ne le
   * savait pas : `router rip` proposait `neighbor … remote-as`, une
   * commande BGP que la même machine refuse à l'exécution.
   *
   * Le filtre est consulté au rendu, jamais à l'enregistrement : c'est
   * le contexte du moment qui décide, et il change entre deux `?`.
   */
  private completionFilter:
    ((path: readonly string[], keyword: string) => boolean) | null = null;

  setCompletionFilter(
    filter: ((path: readonly string[], keyword: string) => boolean) | null,
  ): void {
    this.completionFilter = filter;
  }

  private applyFilter(
    path: readonly string[],
    entries: Array<{ keyword: string; description: string }>,
  ): Array<{ keyword: string; description: string }> {
    const filter = this.completionFilter;
    if (!filter) return entries;
    return entries.filter((e) => e.keyword === '<cr>' || filter(path, e.keyword));
  }

  enumerateExecutablePaths(): string[] {
    this.viderDeclarationsEnAttente();
    const out: string[] = [];
    const walk = (node: CommandNode, path: string[]): void => {
      // Un noeud enregistre POUR ETRE REFUSE n'est pas un chemin
      // executable : il ne rend qu'un refus, et le compter ferait
      // reclamer qu'on l'annonce.
      if (path.length > 0 && node.action && !node._hintOnly && !node._neJamaisAnnoncer) {
        out.push(path.join(' '));
      }
      for (const child of node.children.values()) {
        walk(child, [...path, child.keyword]);
      }
    };
    walk(this.root, []);
    return out;
  }

  /**
   * Les commandes exécutables SOUS un chemin, ce chemin compris.
   *
   * `enumerateExecutablePaths` parcourt l'arbre entier ; celle-ci ne
   * descend que le sous-arbre demandé, parce qu'elle est appelée une
   * fois par mot-clé proposé — donc plusieurs dizaines de fois par
   * frappe de `?`.
   *
   * `limite` borne la descente : le prédicat qui l'appelle cherche
   * seulement s'il EXISTE une commande visible, et une réponse à mille
   * chemins coûte autant qu'une réponse à dix pour la même décision.
   */
  /**
   * Peut-on valider ICI, sans rien ajouter ? C'est exactement ce que le
   * marqueur `<cr>` annonce, et c'est ce qui distingue une commande d'un
   * simple point de passage : `show running-config` s'exécute seule,
   * `show ip` répond `% Incomplete command.` bien que l'arbre porte une
   * action sur ce nœud.
   */
  estExecutableTelQuel(path: string): boolean {
    this.viderDeclarationsEnAttente();
    const node = this.nodeAt(path);
    return node ? this.isExecutableAt(node, 0, []) : false;
  }

  executablePathsUnder(path: string): string[] {
    const out: string[] = [];
    this.walkExecutableUnder(path, (p) => { out.push(p); return false; });
    return out;
  }

  /**
   * Existe-t-il, STRICTEMENT sous ce chemin, une commande exécutable que
   * `predicat` accepte ? `null` quand le chemin n'a aucun descendant
   * exécutable — « il n'y a rien à juger », ce que l'appelant ne doit pas
   * confondre avec « rien n'est acceptable ».
   *
   * Le prédicat est passé À la marche plutôt que la liste rendue À
   * l'appelant : c'est ce qui permet de s'arrêter au premier descendant
   * qui convient. Une première version bornait la liste à 64 chemins pour
   * en limiter le coût, et cette borne était un défaut à elle seule —
   * dans une vue ne contenant que `show version`, la troncature coupait
   * avant lui et `show` disparaissait de la complétion.
   */
  someExecutableUnder(path: string, predicat: (chemin: string) => boolean): boolean | null {
    let vu = false;
    const trouve = this.walkExecutableUnder(path, (p) => {
      vu = true;
      return predicat(p);
    });
    if (trouve) return true;
    return vu ? false : null;
  }

  /** Rend `true` dès que `visite` s'arrête, ce qui interrompt la marche. */
  private walkExecutableUnder(path: string, visite: (chemin: string) => boolean): boolean {
    this.viderDeclarationsEnAttente();
    const depart = this.nodeAt(path);
    if (!depart) return false;
    const racine = path.trim().split(/\s+/).filter((t) => t.length > 0);
    const walk = (node: CommandNode, chemin: string[]): boolean => {
      const propre = chemin.join(' ');
      if (node.action && !node._hintOnly && !node._neJamaisAnnoncer && propre !== racine.join(' ')) {
        if (visite(propre)) return true;
      }
      for (const child of node.children.values()) {
        if (walk(child, [...chemin, child.keyword])) return true;
      }
      return false;
    };
    return walk(depart, racine);
  }

  private estMigre(node: CommandNode): boolean {
    return node._hintOnly === true && !node.action && !this.porteUneSuite(node);
  }

  private porteUneSuite(node: CommandNode): boolean {
    return node.params.length > 0
      || node.children.size > 0
      || (node.hintSuggestions?.length ?? 0) > 0;
  }

  private leadsToACommand(node: CommandNode): boolean {
    for (const child of node.children.values()) {
      if (child._migre) continue;
      if (!child._hintOnly && (child.action || child._porteAction)) return true;
      if (this.leadsToACommand(child)) return true;
    }
    return false;
  }

  enumerateDerivedContinuations(): string[] {
    this.viderDeclarationsEnAttente();
    const out: string[] = [];
    const walk = (node: CommandNode, path: string[]): void => {
      for (const auto of this.autoContinuations(node)) {
        out.push([...path, auto.keyword].join(' '));
      }
      for (const child of node.children.values()) {
        walk(child, [...path, child.keyword]);
      }
    };
    walk(this.root, []);
    return out;
  }

  enumerateUndescribedContinuations(): string[] {
    this.viderDeclarationsEnAttente();
    const out: string[] = [];
    const walk = (node: CommandNode, path: string[]): void => {
      for (const auto of this.autoContinuations(node)) {
        if (!auto.description) out.push([...path, auto.keyword].join(' '));
      }
      for (const child of node.children.values()) {
        walk(child, [...path, child.keyword]);
      }
    };
    walk(this.root, []);
    return out;
  }

  enumerateCommandPaths(): string[] {
    this.viderDeclarationsEnAttente();
    const out: string[] = [''];
    const walk = (node: CommandNode, path: string[]): void => {
      if (path.length > 0) out.push(path.join(' '));
      for (const child of node.children.values()) {
        walk(child, [...path, child.keyword]);
      }
    };
    walk(this.root, []);
    return out;
  }

  getCompletions(inputBeforeQuestion: string): Array<{ keyword: string; description: string }> {
    this.viderDeclarationsEnAttente();
    const raw = inputBeforeQuestion;
    const tokens = raw.trim().split(/\s+/).filter(t => t.length > 0);
    const endsWithSpace = raw.length > 0 && raw.endsWith(' ');

    // Empty input or just spaces → show all root commands
    if (tokens.length === 0) {
      return this.applyFilter([], this.nodeCompletions(this.root));
    }

    let node = this.root;
    const path: string[] = [];
    /** Combien d'arguments du nœud courant ont déjà été fournis. */
    let consumedArgs = 0;
    let argsSoFar: string[] = [];
    let firstArg: string | null = null;

    // Navigate through all complete (non-last) tokens
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i].toLowerCase();
      const isLast = i === tokens.length - 1;

      if (isLast && !endsWithSpace) {
        // PARTIAL TOKEN (no trailing space) → prefix listing
        // "sh?" → which keywords start with "sh"? List them.
        // "show?" → which keywords start with "show"? → "show"
        // Never drill down into the match — just show the matches themselves.
        const matches = this.prefixMatch(node, token, true)
          .filter((m) => !m._neJamaisAnnoncer);
        const listed = matches.map(m => ({ keyword: m.keyword, description: this.resolveDescription(m) }));
        {
          const seen = new Set(listed.map(e => e.keyword.toLowerCase()));
          const hinted = [
            ...(node.hintSuggestions ?? []),
            ...this.autoContinuations(node),
            ...this.enumValues(node, consumedArgs),
          ];
          for (const h of hinted) {
            if (h.keyword.toLowerCase().startsWith(token) && !seen.has(h.keyword.toLowerCase())) {
              seen.add(h.keyword.toLowerCase());
              listed.push({ keyword: h.keyword, description: h.description });
            }
          }
          // Les valeurs VIVANTES de la machine — ports, ACL, VLAN — que
          // seule la tabulation lisait. `show ip interface G?` repondait
          // « ce mot n'existe pas » pendant que `Tab` completait les
          // quatre ports, sur la meme machine au meme instant. Un
          // mot-cle reel garde la priorite : il est deja dans `seen`.
          for (const v of this.dynamicCandidates({
            node, path, consumedArgs, argsSoFar,
            partial: token, matchPartial: true, forTab: false,
          })) {
            if (v.keyword.toLowerCase().startsWith(token) && !seen.has(v.keyword.toLowerCase())) {
              seen.add(v.keyword.toLowerCase());
              listed.push({ keyword: v.keyword, description: v.description });
            }
          }
        }
        return this.applyFilter(path, listed);
      }

      const exactRawHelp = node.children.get(token);
      if (exactRawHelp) {
        node = exactRawHelp;
        path.push(node.keyword);
        consumedArgs = 0;
        argsSoFar = [];
        continue;
      }

      const matches = this.prefixMatch(node, token);
      if (matches.length === 1) {
        node = matches[0];
        path.push(node.keyword);
        consumedArgs = 0;
        argsSoFar = [];
        continue;
      }

      if (matches.length > 1 && i < tokens.length - 1) {
        const nextToken = tokens[i + 1].toLowerCase();
        const viable = matches.filter(m => {
          if (m.children.get(nextToken)) return true;
          return this.prefixMatch(m, nextToken).length > 0;
        });
        if (viable.length === 1) {
          node = viable[0];
          path.push(node.keyword);
          continue;
        }
      }

      // Le token n'est pas un mot-clé : c'est un ARGUMENT.
      //
      // C'est ici que l'aide divergeait de l'exécution. La marche
      // cherchait un enfant à chaque pas et abandonnait dès qu'elle
      // rencontrait une valeur — une adresse, un nombre, un nom — alors
      // que le nœud, lui, la consomme (`registerGreedy` absorbe la
      // suite, `params` la décrit). D'où un `ip address 192.168.10.1 ?`
      // sans réponse pour une commande qui s'exécute très bien.
      // Consommer l'argument et poursuivre supprime la classe entière,
      // y compris pour les commandes que personne n'a testées.
      if (node.params.length > consumedArgs || node.greedy || node._porteGreedy) {
        if (consumedArgs === 0) firstArg = tokens[i];
        argsSoFar.push(tokens[i]);
        consumedArgs++;
        continue;
      }

      return [];
    }

    // Trailing space → show subcommands/children of the last matched node
    return this.applyFilter(path,
      this.nodeCompletions(node, consumedArgs, firstArg, argsSoFar));
  }

  /**
   * Get tab completion for the current partial input.
   * Returns the completed string or null if no unique completion.
   *
   * Real Cisco Tab behavior:
   *   "sh<Tab>"   → "show " (unique prefix match → complete)
   *   "s<Tab>"    → null (ambiguous: "show", "shutdown", etc.)
   *   "show<Tab>" → "show " (exact match → add space)
   */
  tabComplete(input: string): string | null {
    const candidates = this.tabCandidates(input);
    return candidates.length === 1 ? candidates[0] + ' ' : null;
  }

  /**
   * All full-line completions for the current partial input: static
   * keywords, registered hint suggestions, and — when a dynamic resolver
   * is installed — live device values for the parameter position.
   * Non-final tokens are expanded to their canonical keywords
   * ("conf te" → "configure terminal").
   */
  tabCandidates(input: string): string[] {
    this.viderDeclarationsEnAttente();
    const tokens = input.trim().split(/\s+/).filter(t => t.length > 0);
    if (tokens.length === 0 || input.endsWith(' ')) return [];

    let node = this.root;
    const completed: string[] = [];
    let paramIdx = 0;
    /** Ce qui a été consommé PAR LE NŒUD COURANT, comme dans `?`. */
    let argsSoFar: string[] = [];

    for (let i = 0; i < tokens.length - 1; i++) {
      const token = tokens[i].toLowerCase();

      // Un nœud `_hintOnly` ne se PROPOSE pas — c'est ce que
      // `prefixMatch` garantit — mais il porte les arguments déclarés de
      // la suite, et la marche doit donc pouvoir y descendre quand le
      // mot a DÉJÀ été tapé. L'aide y descendait, la complétion non :
      // `aaa authentication lo` restait sur le nœud `aaa`, où `login`
      // n'est pas déclaré, et Tab tombait sur le mot grappillé `local`.
      const exactRaw = node.children.get(token);
      const exact = exactRaw && (!exactRaw._hintOnly || this.porteUneSuite(exactRaw))
        ? exactRaw : undefined;
      if (exact) {
        completed.push(exact.keyword);
        node = exact;
        paramIdx = 0;
        argsSoFar = [];
        continue;
      }

      const matches = this.prefixMatch(node, token);
      if (matches.length === 1) {
        completed.push(matches[0].keyword);
        node = matches[0];
        paramIdx = 0;
        argsSoFar = [];
        continue;
      }

      if (matches.length > 1) {
        const nextToken = tokens[i + 1].toLowerCase();
        const viable = matches.filter(m => {
          if (m.children.get(nextToken)) return true;
          return this.prefixMatch(m, nextToken).length > 0;
        });
        if (viable.length === 1) {
          completed.push(viable[0].keyword);
          node = viable[0];
          paramIdx = 0;
          argsSoFar = [];
          continue;
        }
      }

      // Le token n'est pas un mot-clé. Deux cas, et les confondre est ce
      // qui faisait fabriquer des commandes à la complétion.
      //
      // Si le nœud ATTEND un argument à cette place — il lui reste des
      // `params`, ou son handler est glouton — le token est cette
      // valeur : on la consomme et on continue, ce qui est le seul moyen
      // de compléter `ip route 10.0.0.0 255.255.255.`.
      //
      // Sinon, la ligne n'est plus analysable. L'ancienne version
      // empilait le mot ET RESTAIT SUR LE MÊME NŒUD, donc le mot suivant
      // était comparé aux enfants de la RACINE : `zzz ho` rendait
      // `zzz hostname`, `blah int` rendait `blah interface`, et `do sh`
      // rendait `do shutdown` — des lignes qu'aucun IOS n'accepterait.
      // Un vrai équipement ne complète rien après un mot qu'il ne
      // reconnaît pas. C'est la garde que `getCompletions` applique
      // depuis le typage des arguments, et qui manquait ici.
      // `_porteGreedy` : un nœud purement indicatif créé par
      // `describeArgs` sous une commande gloutonne absorbe la suite tout
      // comme elle. Sans lui, Tab s'arrêtait là où `?` continuait —
      // `tacacs-server host 1.1.1.1 p` ne complétait plus rien.
      if (node.params.length > paramIdx || node.greedy || node._porteGreedy) {
        completed.push(tokens[i]);
        argsSoFar.push(tokens[i]);
        paramIdx++;
        continue;
      }
      return [];
    }

    const partial = tokens[tokens.length - 1];
    const partialLower = partial.toLowerCase();
    const prefix = completed.length > 0 ? completed.join(' ') + ' ' : '';
    const results: string[] = [];
    const seen = new Set<string>();
    const push = (word: string): void => {
      const key = word.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      results.push(prefix + word);
    };

    const requete: SuggestionRequest = {
      node, path: completed, consumedArgs: paramIdx, argsSoFar,
      partial, matchPartial: true, forTab: true,
    };
    // Les MEMES gardes que le rendu de `?`, et pour les memes raisons.
    //
    // Tant que le noeud attend un argument DECLARE, ses suites ne sont
    // pas des candidats : apres `password`, la ligne attend un mot de
    // passe, pas `absolute-timeout`. `?` ecartait deja celles-la ; `Tab`
    // les servait, donc les deux portes repondaient differemment a la
    // meme question.
    //
    // Un mot-cle et une valeur PEUVENT se disputer la meme place —
    // `ping ?` offre `A.B.C.D` et `ip` — donc les enfants restent
    // collectes.
    const attendUnArgument = node.params.length > paramIdx;
    const argumentsConsommes = paramIdx > 0 && node.params.length > paramIdx;
    const statiques = this.collectSuggestions(
      requete, new Set<SuggestionOrigin>(['child', 'hint', 'auto', 'param']));
    for (const c of this.suggestionsApplicables(statiques, paramIdx, argsSoFar)) {
      if (c.origin === 'auto' && (attendUnArgument || argumentsConsommes)) continue;
      if (c.origin === 'child' && paramIdx > 0 && node.params.length > 0) continue;
      if (c.origin === 'child' || c.keyword.toLowerCase().startsWith(partialLower)) {
        push(c.keyword);
      }
    }

    // Un MOT-CLÉ et une VALEUR ne se disputent jamais la même place sur
    // un vrai IOS : l'analyseur essaie les mots-clés d'abord, et ne lit
    // une valeur que si aucun ne convient. La complétion les mélangeait,
    // avec une conséquence très visible : `interface gi` rendait cinq
    // candidats — le type `GigabitEthernet` ET les ports `0/0`…`0/3` —
    // donc Tab ne faisait rien, là où un vrai routeur écrit
    // `interface GigabitEthernet` immédiatement. Le type et son numéro
    // sont deux jetons pour l'analyseur, même quand on les colle.
    //
    // Les valeurs vivantes ne disparaissent pas pour autant : elles
    // reviennent dès qu'aucun mot-clé ne correspond (`interface 0/1`,
    // `ip route 10.0.0.0 255.255.255.`), et `?` continue de les lister,
    // ce qui reste le bon endroit pour découvrir les ports réels.
    if (results.length === 0) {
      for (const c of this.collectSuggestions(requete, new Set<SuggestionOrigin>(['dynamic']))) {
        if (c.keyword.toLowerCase().startsWith(partialLower)) push(c.keyword);
      }
    }

    // L'ordre des octets, comme celui de `?` : les deux portes
    // repondent a la meme question et rendaient deux ordres, celui de
    // l'aide et celui de l'INSERTION dans l'arbre — `show v` donnait
    // `vrf, vrrp, version, vlans`, qui ne se lit pas.
    return results.sort();
  }

  // ─── Internal Helpers ───────────────────────────────────────────

  /**
   * Keywords the node's greedy handler dispatches on, auto-extracted from
   * the handler's own source so every greedy command is completable
   * without per-command annotation. Explicit hintSuggestions (curated
   * descriptions) take precedence at merge time; extraction fills the
   * rest. Computed lazily, once per node.
   */
/**
   * La règle que `?` ET la complétion par tabulation lisent.
   *
   * Corriger `?` seul laissait la moitié du défaut debout : `Tab` est
   * une SECONDE marche (`tabCandidates`), avec ses propres gardes, qui
   * recomplétait encore ce que `?` venait d'arrêter de proposer —
   * `tacacs server s` + Tab rendait `server`. Deux réponses à une même
   * question ; il n'y a plus qu'un endroit qui décide.
   *
   * Deux exclusions, et rien d'autre :
   *   - un mot-clé DÉJÀ sur la ligne ;
   *   - un mot-clé `leadingOnly` une fois qu'un argument a été donné
   *     (`ping ip 1.1.1.1` existe, `ping 1.1.1.1 ip` non).
   */
  private valeurAttendue(
    node: CommandNode, argsSoFar: readonly string[],
  ): ReadonlyArray<{ keyword: string; description: string }> | null {
    const suites = node.hintSuggestions;
    if (!suites) return null;

    let attendu: ReadonlyArray<{
      keyword: string; description: string;
      valeur?: ReadonlyArray<{ keyword: string; description: string }>;
    }> | null = null;

    for (const mot of argsSoFar) {
      const bas = mot.toLowerCase();
      if (attendu !== null) {
        const valeur = attendu.find((v) => v.keyword.toLowerCase() === bas);
        attendu = valeur?.valeur ?? null;
        continue;
      }
      attendu = suites.find((h) => h.keyword.toLowerCase() === bas)?.valeur ?? null;
    }
    return attendu;
  }

  private suggestionsApplicables<T extends { keyword: string; leadingOnly?: boolean }>(
    liste: ReadonlyArray<T>,
    consumedArgs: number,
    argsSoFar: readonly string[],
  ): T[] {
    const dejaTape = new Set(argsSoFar.map((a) => a.toLowerCase()));
    return liste.filter((e) =>
      !dejaTape.has(e.keyword.toLowerCase())
      && !(e.leadingOnly && consumedArgs > 0));
  }


  /**
   * Les suites DECLAREES d'un noeud glouton.
   *
   * Elles etaient jusqu'ici EXTRAITES du texte source du gestionnaire,
   * ce qui liait l'aide au code : reecrire un corps la defaisait sans
   * que rien ne le signale, et ce depot en a fait l'experience — la
   * reecriture de `no privilege` a fait disparaitre le mot `level` de
   * son source, donc de son aide. Elles sont desormais ecrites.
   *
   * Distinct de `hintSuggestions` a dessein : une suite ainsi declaree
   * est une ALTERNATIVE d'aiguillage, ce qui lui vaut des regles
   * propres — une seule d'entre elles peut figurer sur la ligne, et
   * celle qu'on ne sait pas decrire n'est pas annoncee.
   */
  declareContinuations(path: string, keywords: readonly string[]): void {
    const node = this.nodeAt(path);
    if (!node) return;
    if (this.estElague(path)) return;
    const deja = new Set((node._continuations ?? []).map((k) => k.toLowerCase()));
    const out = [...(node._continuations ?? [])];
    for (const k of keywords) {
      if (!deja.has(k.toLowerCase())) { deja.add(k.toLowerCase()); out.push(k); }
    }
    node._continuations = out;
    node._autoKeywords = undefined;
  }

  private autoContinuations(node: CommandNode): ReadonlyArray<{ keyword: string; description: string }> {
    if (node._autoKeywords !== undefined) return node._autoKeywords;
    node._autoKeywords = (node._continuations ?? [])
      .map((kw) => ({ keyword: kw, description: descriptionForKeyword(kw) }));
    return node._autoKeywords;
  }

  /**
   * Attache des spécifications d'arguments à un nœud DÉJÀ enregistré.
   *
   * `ParamType`/`ParamSpec` existaient depuis toujours ; ce qui manquait
   * était leur usage — presque tous les enregistrements du dépôt passent
   * par `registerGreedy`, qui n'accepte pas de paramètres. Plutôt que de
   * réécrire des milliers d'appels, on décrit les arguments après coup,
   * là où l'aide doit s'améliorer.
   */
  describeArgs(path: string, specs: readonly ParamSpec[]): void {
    if (this.estElague(path)) return;
    if (!this.attacherArgs(path, specs)) {
      this.declarationsEnAttente.push({ path, specs: [...specs] });
    }
  }

  private declarationsEnAttente: Array<{ path: string; specs: ParamSpec[] }> = [];



  private viderDeclarationsEnAttente(): void {
    if (this.declarationsEnAttente.length === 0) return;
    const restantes = this.declarationsEnAttente;
    this.declarationsEnAttente = [];
    for (const declaration of restantes) {
      if (!this.attacherArgs(declaration.path, declaration.specs)) {
        this.declarationsEnAttente.push(declaration);
      }
    }
  }

  private attacherArgs(path: string, specs: readonly ParamSpec[]): boolean {
    const keywords = path.split(/\s+/).filter(Boolean);
    let node = this.root;
    for (const keyword of keywords) {
      const key = keyword.toLowerCase();
      let child = node.children.get(key);
      if (!child) {
        if (!node.action && !node.greedy && !node._porteAction && !node._porteGreedy) return false;
        // Le mot-clé n'est pas un nœud réel : la commande est enregistrée
        // greedy et l'absorbe. On crée un nœud PUREMENT INDICATIF pour
        // pouvoir y accrocher les arguments — `prefixMatch` ignore les
        // nœuds `_hintOnly`, donc l'exécution continue de passer par le
        // parent greedy et rien ne change pour elle.
        child = this.createNode(key, '');
        child._hintOnly = true;
        child._passthrough = true;
        child._porteAction = !!node.action || !!node._porteAction;
        child._porteGreedy = !!node.greedy || !!node._porteGreedy;
        node.children.set(key, child);
      }
      node = child;
    }
    node.params = [...specs];
    return true;
  }

  /**
   * Déclare qu'une commande greedy ne prend pas d'argument. Le chemin
   * doit exister ; un chemin inconnu est ignoré, comme `describeArgs`,
   * pour qu'une table d'aide ne dépende pas de l'ordre d'enregistrement.
   */
  takesNoArgument(path: string): void {
    const node = this.nodeAt(path);
    if (node && !node._elague) node._noArgument = true;
  }

  private hintDescription(node: CommandNode, keyword: string): string {
    const key = keyword.toLowerCase();
    return node.hintSuggestions?.find(h => h.keyword.toLowerCase() === key)?.description ?? '';
  }

  private suggestionAccess(): SuggestionTrieAccess {
    return {
      childCandidates: (r) => this.childCandidates(r),
      paramCandidates: (r) => this.paramCandidates(r),
      hintCandidates: (r) => this.hintCandidates(r),
      autoCandidates: (r) => this.autoCandidates(r),
      dynamicCandidates: (r) => this.dynamicCandidates(r),
    };
  }

  private collectSuggestions(
    request: SuggestionRequest,
    origins: ReadonlySet<SuggestionOrigin>,
  ): SuggestionCandidate[] {
    const access = this.suggestionAccess();
    const out: SuggestionCandidate[] = [];
    for (const source of SUGGESTION_SOURCES) {
      if (!origins.has(source.origin)) continue;
      out.push(...source.collect(request, access));
    }
    return out;
  }

  private childCandidates(r: SuggestionRequest): SuggestionCandidate[] {
    const enfants = r.matchPartial
      ? this.prefixMatch(r.node, r.partial.toLowerCase(), true)
      : [...r.node.children.values()]
        .filter((c) => (!c._hintOnly || c._passthrough) && !c._neJamaisAnnoncer);
    return enfants.map((child) => ({
      keyword: child.keyword,
      description: this.resolveDescription(child) || this.hintDescription(r.node, child.keyword),
      origin: 'child' as const,
    }));
  }

  private paramCandidates(r: SuggestionRequest): SuggestionCandidate[] {
    if (r.forTab) {
      return this.enumValues(r.node, r.consumedArgs, true)
        .map((v) => ({ ...v, origin: 'param' as const }));
    }
    const out: SuggestionCandidate[] = [];
    for (const param of r.node.params.slice(r.consumedArgs)) {
      if (param.alternatives) {
        for (const a of param.alternatives) {
          out.push({ keyword: a.literal, description: a.description, origin: 'param' });
        }
      } else if (param.type === 'ENUM' && param.values) {
        for (const v of param.values) out.push({ ...v, origin: 'param' });
      } else {
        const resolved = this.resolvedRange(param, { ...r, keyword: r.node.keyword });
        out.push({
          keyword: renderParamKeyword(resolved ? { ...param, range: resolved } : param),
          description: param.description,
          origin: 'param',
        });
      }
      if (!param.optional) break;
    }
    return out;
  }

  private hintCandidates(r: SuggestionRequest): SuggestionCandidate[] {
    return (r.node.hintSuggestions ?? []).map((h) => ({
      keyword: h.keyword,
      description: h.description || descriptionForKeyword(h.keyword),
      leadingOnly: h.leadingOnly,
      origin: 'hint' as const,
    }));
  }

  private autoCandidates(r: SuggestionRequest): SuggestionCandidate[] {
    const auto = this.autoContinuations(r.node);
    // L'extraction modélise UN aiguillage : le gestionnaire lit un
    // mot-clé et agit. Dès qu'un de ces mots est sur la ligne, les
    // autres sont ses alternatives, pas ses suites — sans quoi
    // `show interfaces stats ?` reproposait `accounting`, `counters`,
    // `summary`, que la machine refuse ensuite.
    const dejaTape = new Set(r.argsSoFar.map((a) => a.toLowerCase()));
    if (auto.some((a) => dejaTape.has(a.keyword.toLowerCase()))) return [];
    return auto.map((a) =>
      ({ keyword: a.keyword, description: a.description, origin: 'auto' as const }));
  }

  private resolvedRange(
    param: ParamSpec, r: { path: readonly string[]; partial: string; keyword?: string },
  ): readonly [number, number] | null {
    if (param.type !== 'INT' || !param.rangeIsAdvisory) return null;
    return this.dynamicResolver?.rangeFor?.({
      path: r.keyword ? [...r.path, r.keyword] : r.path,
      paramType: param.type, partial: r.partial,
    }) ?? null;
  }

  private dynamicCandidates(r: SuggestionRequest): SuggestionCandidate[] {
    if (!this.dynamicResolver) return [];
    const values = this.dynamicResolver.candidatesFor({
      path: r.path,
      paramType: r.node.params[r.consumedArgs]?.type ?? null,
      partial: r.partial,
    });
    return values.map((v) => ({ keyword: v, description: '', origin: 'dynamic' as const }));
  }

  private enumValues(
    node: CommandNode,
    consumedArgs: number,
    pourTab = false,
  ): ReadonlyArray<{ keyword: string; description: string }> {
    const param = node.params[consumedArgs];
    if (param?.type !== 'ENUM') return [];
    if (pourTab && param.helpOnly) return [];
    return param.values ?? [];
  }

  /**
   * Donne sa description à un nœud INTERMÉDIAIRE, celui qu'aucun
   * enregistrement ne nomme pour lui-même.
   *
   * `register('ip routing-table limit', …)` crée `routing-table` en
   * chemin, avec une description vide ; `ip ?` listait donc un mot-clé
   * nu, qui dit qu'il existe sans dire ce qu'il fait. Le nœud n'a pas
   * d'action et n'en reçoit pas : seul son libellé change.
   */
  describeNode(path: string, description: string): void {
    const node = this.nodeAt(path);
    if (!node || node._elague) return;
    // Un nœud créé en chemin reçoit sa propre CLÉ pour description, que
    // le rendu blanchit ensuite — répéter le mot-clé ne dit rien. Les
    // deux formes valent donc « pas de description », et ne garder que
    // le test de la chaîne vide laissait l'appel sans effet, ce qui a
    // été mesuré.
    const vide = !node.description
      || node.description.toLowerCase() === node.keyword.toLowerCase();
    if (vide) node.description = description;
  }

  requireArgs(path: string, minArgs: number): void {
    const node = this.nodeAt(path);
    if (node && !node._elague) node.minArgs = minArgs;
  }

  /**
   * Déclare qu'au-delà de l'arité, la commande n'est complète que si
   * ses arguments satisfont ce prédicat — le seul moyen de distinguer
   * `interface GigabitEthernet0/0/0`, qui s'exécute, de
   * `interface GigabitEthernet`, qui est refusée, alors que les deux
   * portent exactement un argument.
   */
  executableWhen(path: string, predicate: (args: readonly string[]) => boolean): void {
    const node = this.nodeAt(path);
    if (node) node.executableWhen = predicate;
  }

  /** Plafonne le nombre d'arguments d'une commande. */
  allowArgs(path: string, maxArgs: number): void {
    const node = this.nodeAt(path);
    if (node) node.maxArgs = maxArgs;
  }

  /** Le plafond declare, ou `null` quand la commande n'en a pas. */
  argumentCeiling(path: string): number | null {
    return this.nodeAt(path)?.maxArgs ?? null;
  }

  private nodeAt(path: string): CommandNode | null {
    this.viderDeclarationsEnAttente();
    let node: CommandNode = this.root;
    for (const kw of path.split(/\s+/).filter(Boolean)) {
      const key = kw.toLowerCase();
      const child = node.children.get(key) ?? this.prefixMatch(node, key, true)[0];
      if (!child) return null;
      node = child;
    }
    return node;
  }

  private prefixMatch(
    node: CommandNode,
    prefix: string,
    includePassthrough = false,
  ): CommandNode[] {
    const results: CommandNode[] = [];
    for (const [keyword, child] of node.children) {
      if (child._hintOnly && !(includePassthrough && child._passthrough)) continue;
      if (keyword.startsWith(prefix)) {
        results.push(child);
      }
    }
    return results;
  }

  /**
   * Build the completions list for a node's children/params.
   * Includes <cr> when the node itself is executable (real Cisco behavior).
   */
  /**
   * IOS trie TOUJOURS son aide alphabétiquement ; l'ordre d'insertion
   * dans le registre est un artefact d'implémentation qui se voit
   * immédiatement. Les paramètres (`<...>`) restent en fin de liste,
   * comme sur un vrai routeur, et `<cr>` garde sa place finale.
   */
  private nodeCompletions(
    node: CommandNode,
    consumedArgs = 0,
    firstArg: string | null = null,
    argsSoFar: readonly string[] = [],
  ): Array<{ keyword: string; description: string }> {
    const raw = dedupeByKeyword(
      this.nodeCompletionsUnsorted(node, consumedArgs, firstArg, argsSoFar));
    const rank = (keyword: string): number => {
      if (keyword === '<cr>') return 2;
      if (keyword.startsWith('<')) return 1;
      return 0;
    };
    return raw.slice().sort((a, b) => {
      const byRank = rank(a.keyword) - rank(b.keyword);
      if (byRank !== 0) return byRank;
      if (rank(a.keyword) !== 0) return 0;
      return a.keyword.localeCompare(b.keyword, 'en');
    });
  }

  private nodeCompletionsUnsorted(
    node: CommandNode,
    consumedArgs = 0,
    firstArg: string | null = null,
    argsSoFar: readonly string[] = [],
  ): Array<{ keyword: string; description: string }> {
    const results: Array<{ keyword: string; description: string }> = [];

    /**
     * Un mot-clé DÉJÀ SUR LA LIGNE ne se propose plus.
     *
     * C'est la règle qui manquait, et son absence ne se voyait que sur
     * un nœud glouton SANS `params` déclarés : la garde ci-dessous
     * (`node.params.length > consumedArgs`) y est fausse quel que soit
     * le nombre d'arguments consommés, donc le nœud reservait sa liste
     * entière à chaque profondeur. `tacacs server server ?` proposait
     * `server`, `tacacs-server host key ?` reproposait `host` et `key`,
     * indéfiniment — sur les deux constructeurs et dans presque tous
     * les modes.
     *
     * La règle vaut aussi pour une liste d'options qui, elle, se
     * poursuit légitimement : `ping 1.1.1.1 repeat 5 ?` doit encore
     * offrir `timeout` et `size`, et ne plus offrir `repeat`. C'est
     * exactement ce que fait une vraie machine.
     */
    const jamaisDeuxFois = <T extends { keyword: string; leadingOnly?: boolean }>(
      liste: ReadonlyArray<T>,
    ): T[] => this.suggestionsApplicables(liste, consumedArgs, argsSoFar);

    // Tant que la commande ATTEND ENCORE un argument, les mots-clés
    // enfants ne sont pas des candidats : après `ip address
    // 192.168.10.1`, IOS attend le masque, pas `dhcp`. Une fois les
    // arguments servis, les mots-clés qui les suivent redeviennent
    // proposables — `access-list 10 ?` rend bien `deny`/`permit`.
    const requete: SuggestionRequest = {
      node, path: [], consumedArgs, argsSoFar,
      partial: '', matchPartial: false, forTab: false,
    };
    const depuis = (origin: SuggestionOrigin) =>
      this.collectSuggestions(requete, new Set([origin]));

    const argumentsConsumed = consumedArgs > 0 && node.params.length > consumedArgs;

    /**
     * Un nœud QUI DÉCLARE des paramètres n'accepte ses enfants qu'à la
     * PREMIÈRE place. `ip address dhcp` est un nœud enfant, donc `dhcp`
     * occupe le rang d'argument zéro ; une fois l'adresse et le masque
     * saisis, la machine est dans la liste d'arguments de `ip address`
     * et l'exécution refuse `ip address 10.0.0.1 255.255.255.0 dhcp` —
     * que l'aide proposait pourtant.
     *
     * La règle ne joue QUE pour un nœud à paramètres déclarés, et c'est
     * ce qui la rend vraie : `show interfaces` n'en déclare aucun, donc
     * `show interfaces Gi0/0 accounting` reste atteignable après son
     * argument, comme sur une vraie machine.
     */
    const enfantsHorsDePortee = consumedArgs > 0 && node.params.length > 0;

    /**
     * L'AIGUILLAGE est pris : les autres branches ne sont plus des suites.
     *
     * Les mots extraits du corps d'un gestionnaire modelisent un
     * aiguillage — il lit un mot et branche. `show interfaces` en porte
     * six (`accounting`, `counters`, `description`, `rate-limit`,
     * `stats`, `summary`) qui s'excluent : `show interfaces stats
     * accounting` n'existe pas. La regle valait deja pour les mots
     * extraits ; elle vaut pour les ENFANTS du meme noeud, qui sont les
     * memes alternatives declarees autrement — sans quoi la moitie de la
     * famille disparaissait et l'autre restait proposee.
     *
     * Elle ne joue que si l'un de ces mots est DEJA sur la ligne, donc
     * `show interfaces Gi0/0 ?` garde les six : nommer une interface ne
     * choisit aucune vue.
     */
    const attendue = this.valeurAttendue(node, argsSoFar);
    if (attendue) return attendue.map((v) => ({ ...v }));

    const dejaSurLaLigne = new Set(argsSoFar.map((a) => a.toLowerCase()));
    const aiguillagePris = this.autoContinuations(node)
      .some((a) => dejaSurLaLigne.has(a.keyword.toLowerCase()));
    if (!enfantsHorsDePortee && !aiguillagePris) {
      results.push(...jamaisDeuxFois(depuis('child')));
    }

    // Un paramètre déjà fourni n'est plus proposé : après
    // `ip address 192.168.10.1`, IOS attend le masque, pas l'adresse.
    results.push(...depuis('param'));

    // Une continuation déclarée vient APRÈS l'argument obligatoire, pas
    // à sa place : `logging host ?` offrait `transport` et
    // `discriminator` avant l'adresse, deux formes que la même machine
    // refuse ensuite faute de serveur à qui les rattacher.
    const pending = node.params[consumedArgs];
    const awaitsMandatory = pending !== undefined && !pending.optional;

    if (!argumentsConsumed && !awaitsMandatory) {
      const seen = new Set(results.map(r => r.keyword.toLowerCase()));
      for (const hint of jamaisDeuxFois(depuis('hint'))) {
        if (!seen.has(hint.keyword.toLowerCase())) {
          results.push({ keyword: hint.keyword, description: hint.description });
          seen.add(hint.keyword.toLowerCase());
        }
      }
    }

    const awaitsDeclaredArgument = node.params.length > consumedArgs;
    if (!argumentsConsumed && !awaitsDeclaredArgument) {
      const seen = new Set(results.map(r => r.keyword.toLowerCase()));
      for (const auto of jamaisDeuxFois(depuis('auto'))) {
        if (!seen.has(auto.keyword)) {
          seen.add(auto.keyword);
          results.push({ keyword: auto.keyword, description: auto.description });
        }
      }
    }

    // Le repli de dernier recours n'a de sens que pour un nœud dont on
    // n'a RIEN à dire : un `WORD` annonce qu'un mot est attendu sans
    // prétendre savoir lequel.
    if (node.greedy && !node._noArgument && results.length === 0) {
      results.push({ keyword: 'WORD', description: node.description });
    }

    // <cr> — shown when the current command is already executable
    // (real Cisco always shows <cr> when you can press Enter)
    const keywordForm = firstArg !== null && this.isContinuationKeyword(node, firstArg);
    // Le raccourci `keywordForm` — « le premier argument est un mot-clé,
    // donc la commande est complète » — sert les formes gloutonnes dont
    // l'arité ne se calcule pas. Mais un `executableWhen` DÉCLARÉ est un
    // énoncé explicite sur ce qui complète la commande, et il doit
    // pouvoir opposer son veto : `class-map match-all` porte bien un
    // mot-clé en premier argument, et attend pourtant encore son nom.
    const predicatSatisfait = node.executableWhen
      ? node.executableWhen(argsSoFar) : true;
    if ((!!node.action || !!node._porteAction) && predicatSatisfait
      && (keywordForm || this.isExecutableAt(node, consumedArgs, argsSoFar))) {
      results.push({ keyword: '<cr>', description: '' });
    }

    return results;
  }

  private validateParam(value: string, spec: ParamSpec): boolean {
    if (spec.validator) return spec.validator(value);
    switch (spec.type) {
      case 'ENUM':
        return (spec.values ?? []).some(v => v.keyword.toLowerCase() === value.toLowerCase());
      case 'INT': return /^\d+$/.test(value);
      case 'STRING': return value.length > 0;
      case 'WORD': return /^[a-zA-Z0-9_-]+$/.test(value);
      case 'IP_ADDR': return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value);
      case 'SUBNET_MASK': return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value);
      case 'MAC_ADDR': return /^([0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}$/.test(value);
      case 'INTERFACE': return /^[a-zA-Z]+[\d/.-]+$/.test(value);
      case 'VLAN_LIST': return /^[\d,-]+$/.test(value);
      default: return true;
    }
  }

  private formatInvalidInput(input: string, errorPos: number): string {
    void input;
    return formatInvalidInput(errorPos);
  }
}

let largeurPrompt = 0;
export function setInvalidInputPromptWidth(n: number): void {
  largeurPrompt = Math.max(0, n | 0);
}

/**
 * Un même mot-clé ne peut pas apparaître deux fois dans une aide. Il le
 * pouvait : `describeArgs('permit tcp any any eq', …)` crée les nœuds
 * intermédiaires `any` et `eq`, que l'énumération du nœud propose déjà
 * par ailleurs. On garde la description la plus informative.
 */
function dedupeByKeyword(
  entries: Array<{ keyword: string; description: string }>,
): Array<{ keyword: string; description: string }> {
  const par = new Map<string, { keyword: string; description: string }>();
  for (const e of entries) {
    const cle = e.keyword.toLowerCase();
    const vu = par.get(cle);
    if (!vu || (vu.description === '' && e.description !== '')) par.set(cle, e);
  }
  return [...par.values()];
}

export function formatInvalidInput(errorPos: number): string {
  const marker = ' '.repeat(largeurPrompt + Math.max(0, errorPos)) + '^';
  return `${marker}\n% Invalid input detected at '^' marker.`;
}

export function formatInvalidInputAt(marker: string): string {
  return formatInvalidInput(Math.max(0, marker.indexOf('^')));
}
