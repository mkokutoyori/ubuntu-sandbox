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

import { extractHandlerKeywords } from './HandlerKeywordExtractor';
import { descriptionForKeyword } from './CliKeywordDescriptions';

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
  /** Rendu littéral imposé, quand le type ne suffit pas (`LINE`, `hh:mm`). */
  literal?: string;
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
  hintSuggestions?: Array<{ keyword: string; description: string; leadingOnly?: boolean }>;
  _hintOnly?: boolean;
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
}

// ─── Match Result ───────────────────────────────────────────────────

export interface MatchResult {
  status: 'ok' | 'ambiguous' | 'incomplete' | 'invalid';
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
      if (!this.root.children.has(kw)) this.root.children.set(kw, node);
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
      if (!existing) dst.children.set(k, node);
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
      if (!existing) dst.children.set(k, child);
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

  registerSuggestions(path: string, suggestions: Array<{ keyword: string; description: string }>): void {
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
      const exactChild = exactChildRaw && !exactChildRaw._hintOnly ? exactChildRaw : undefined;
      if (exactChild) {
        node = exactChild;
        matchedKeywords.push(node.keyword);
        paramIdx = 0;

        // If this node is greedy AND has remaining tokens, check children first
        // before consuming greedily. This allows registered subpaths to take
        // precedence (e.g., "display interface brief" over "display interface <name>").
        if (node.greedy && i < tokens.length - 1) {
          const nextTk = tokens[i + 1].toLowerCase();
          const childMatch = node.children.get(nextTk) || this.prefixMatch(node, nextTk);
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
        node = matches[0];
        matchedKeywords.push(node.keyword);
        paramIdx = 0;

        // Same child-first check for greedy nodes
        if (node.greedy && i < tokens.length - 1) {
          const nextTk = tokens[i + 1].toLowerCase();
          const childMatch = node.children.get(nextTk) || this.prefixMatch(node, nextTk);
          const hasChildMatch = Array.isArray(childMatch) ? childMatch.length > 0 : !!childMatch;
          if (!hasChildMatch) {
            args.push(...tokens.slice(i + 1));
            return this.finish(node, args, matchedKeywords, input);
          }
        }
        continue;
      }

      if (matches.length > 1) {
        if (i < tokens.length - 1) {
          const nextToken = tokens[i + 1].toLowerCase();
          const viable = matches.filter(m => {
            const exactNext = m.children.get(nextToken);
            if (exactNext) return true;
            const prefixNext = this.prefixMatch(m, nextToken);
            if (prefixNext.length > 0) return true;
            if (m.greedy && m.children.size === 0) return true;
            return false;
          });
          if (viable.length === 1) {
            node = viable[0];
            matchedKeywords.push(node.keyword);
            paramIdx = 0;
            if (node.greedy && i < tokens.length - 1) {
              args.push(...tokens.slice(i + 1));
              return this.finish(node, args, matchedKeywords, input);
            }
            continue;
          }
        }

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

  private finish(
    node: CommandNode,
    args: string[],
    matchedKeywords: string[],
    input: string,
  ): MatchResult {
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

  getCompletions(inputBeforeQuestion: string): Array<{ keyword: string; description: string }> {
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
        const matches = this.prefixMatch(node, token, true);
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
      const exact = exactRaw && (!exactRaw._hintOnly || exactRaw.params.length > 0)
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

    for (const m of this.suggestionsApplicables(
      this.prefixMatch(node, partialLower, true), paramIdx, argsSoFar)) {
      push(m.keyword);
    }

    // La MÊME règle que `?`, lue au même endroit : ce que l'aide a
    // délibérément retiré, la complétion ne le rend pas non plus.
    if (node.hintSuggestions) {
      for (const h of this.suggestionsApplicables(node.hintSuggestions, paramIdx, argsSoFar)) {
        if (h.keyword.toLowerCase().startsWith(partialLower)) push(h.keyword);
      }
    }

    for (const auto of this.suggestionsApplicables(
      this.autoContinuations(node), paramIdx, argsSoFar)) {
      if (auto.keyword.startsWith(partialLower)) push(auto.keyword);
    }

    for (const v of this.enumValues(node, paramIdx, true)) {
      if (v.keyword.toLowerCase().startsWith(partialLower)) push(v.keyword);
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
    if (this.dynamicResolver && results.length === 0) {
      const context: DynamicCompletionContext = {
        path: completed,
        paramType: node.params[paramIdx]?.type ?? null,
        partial,
      };
      for (const value of this.dynamicResolver.candidatesFor(context)) {
        if (value.toLowerCase().startsWith(partialLower)) push(value);
      }
    }

    return results;
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

    private autoContinuations(node: CommandNode): ReadonlyArray<{ keyword: string; description: string }> {
    if (node._autoKeywords !== undefined) return node._autoKeywords;
    if (!node.greedy || !node.action) {
      node._autoKeywords = [];
      return node._autoKeywords;
    }
    // Une liste d'ARGUMENTS déclarée (`describeArgs`) dit la même chose
    // qu'une liste d'indices curatés : l'auteur connaît les suites de ce
    // nœud. Seule la première était consultée, si bien que Tab
    // complétait `aaa authentication local` — un mot grappillé dans le
    // corps du handler d'`aaa`, qu'IOS n'accepte pas à cette place et
    // que `?` ne proposait pas. Les deux portes lisaient deux règles.
    const declares = node.params.flatMap((p) =>
      (p.values ?? []).map((v) => v.keyword.toLowerCase()));
    const curated = new Set([
      ...(node.hintSuggestions ?? []).map(h => h.keyword.toLowerCase()),
      ...declares,
    ]);
    // Une liste CURATÉE dit que l'auteur connaît les suites de ce nœud.
    // Y ajouter les mots grappillés dans le corps du handler annule ce
    // qu'elle affirme : vingt mots-clés de `line` partagent un seul
    // aiguillage, donc chacun se voyait proposer l'union des mots des
    // dix-neuf autres — `login ?` offrait `password`, `size`,
    // `synchronous`. L'extraction ne comble que les nœuds dont personne
    // n'a déclaré les suites.
    if (curated.size > 0) {
      node._autoKeywords = [];
      return node._autoKeywords;
    }
    const children = new Set(node.children.keys());
    // Un nœud ne se propose JAMAIS lui-même comme sa propre suite.
    // L'extraction lit le corps d'un handler qui, lorsqu'il sert
    // plusieurs mots-clés, cite forcément le sien : `exec ?` répondait
    // `exec`, `login ?` répondait `login`, dans tous les modes servis
    // par un aiguillage commun.
    const soiMeme = node.keyword.toLowerCase();
    const extracted = extractHandlerKeywords(node.action.toString())
      .filter(kw => !curated.has(kw) && !children.has(kw) && kw !== soiMeme);
    // A greedy handler often also accepts abbreviations (`con` for
    // `console`, `sum` for `summary`). An extracted keyword that is a
    // proper prefix of a real keyword — a child, a curated hint, or
    // another extracted keyword — is such an abbreviation, not a distinct
    // command, and must never be offered as its own completion candidate.
    const fullKeywords = [...curated, ...children, ...extracted];
    node._autoKeywords = extracted
      .filter(kw => !fullKeywords.some(other => other !== kw && other.startsWith(kw)))
      .map(kw => ({ keyword: kw, description: descriptionForKeyword(kw) }));
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
    const keywords = path.split(/\s+/).filter(Boolean);
    let node = this.root;
    for (const keyword of keywords) {
      const key = keyword.toLowerCase();
      let child = node.children.get(key);
      if (!child) {
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
  }

  /**
   * Déclare qu'une commande greedy ne prend pas d'argument. Le chemin
   * doit exister ; un chemin inconnu est ignoré, comme `describeArgs`,
   * pour qu'une table d'aide ne dépende pas de l'ordre d'enregistrement.
   */
  takesNoArgument(path: string): void {
    const node = this.nodeAt(path);
    if (node) node._noArgument = true;
  }

  private hintDescription(node: CommandNode, keyword: string): string {
    const key = keyword.toLowerCase();
    return node.hintSuggestions?.find(h => h.keyword.toLowerCase() === key)?.description ?? '';
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
    if (!node) return;
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
    if (node) node.minArgs = minArgs;
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
    const argumentsConsumed = consumedArgs > 0 && node.params.length > consumedArgs;
    if (!argumentsConsumed) {
      const enfants: Array<{ keyword: string; description: string }> = [];
      for (const [, child] of node.children) {
        if (child._hintOnly && !child._passthrough) continue;
        const described = this.resolveDescription(child);
        enfants.push({
          keyword: child.keyword,
          description: described || this.hintDescription(node, child.keyword),
        });
      }
      results.push(...jamaisDeuxFois(enfants));
    }

    // Un paramètre déjà fourni n'est plus proposé : après
    // `ip address 192.168.10.1`, IOS attend le masque, pas l'adresse.
    for (const param of node.params.slice(consumedArgs)) {
      if (param.type === 'ENUM' && param.values) {
        for (const v of param.values) results.push({ ...v });
      } else {
        results.push({ keyword: renderParamKeyword(param), description: param.description });
      }
      if (!param.optional) break;
    }

    // Une continuation déclarée vient APRÈS l'argument obligatoire, pas
    // à sa place : `logging host ?` offrait `transport` et
    // `discriminator` avant l'adresse, deux formes que la même machine
    // refuse ensuite faute de serveur à qui les rattacher.
    const pending = node.params[consumedArgs];
    const awaitsMandatory = pending !== undefined && !pending.optional;

    if (!argumentsConsumed && !awaitsMandatory
        && node.hintSuggestions && node.hintSuggestions.length > 0) {
      const seen = new Set(results.map(r => r.keyword.toLowerCase()));
      for (const hint of jamaisDeuxFois(node.hintSuggestions)) {
        if (!seen.has(hint.keyword.toLowerCase())) {
          // Un hint déclaré sous sa forme courte (`['count']`) naît sans
          // description ; la table canonique en a une.
          results.push(hint.description
            ? hint
            : { keyword: hint.keyword, description: descriptionForKeyword(hint.keyword) });
          seen.add(hint.keyword.toLowerCase());
        }
      }
    }

    const awaitsDeclaredArgument = node.params.length > consumedArgs;
    /** Des continuations existaient, mais aucune n'était descriptible. */
    let autoIndescriptibles = false;
    if (!argumentsConsumed && !awaitsDeclaredArgument) {
      const seen = new Set(results.map(r => r.keyword.toLowerCase()));
      for (const auto of jamaisDeuxFois(this.autoContinuations(node))) {
        // Un mot EXTRAIT du corps d'un handler et qu'on ne sait pas
        // décrire n'est probablement pas un mot-clé : c'est un nom de
        // variable que l'extracteur a ramassé au passage. `acl ?` sur
        // VRP proposait ainsi `nom` et `refus`, deux identifiants du
        // code, que la machine refuse ensuite. L'aide ne peut pas
        // annoncer ce qu'elle n'est pas capable d'expliquer.
        //
        // La complétion par tabulation, elle, continue de les accepter
        // (`tabCandidates` lit `autoContinuations` directement) : un
        // mot-clé réel qu'on n'a pas encore décrit reste complétable, et
        // le NOMMER dans `CliKeywordDescriptions` le fait réapparaître
        // ici — c'est la voie prise pour `vpn-instance`, un vrai mot-clé
        // que ce même filtre aurait masqué.
        if (!auto.description) { autoIndescriptibles = true; continue; }
        if (!seen.has(auto.keyword)) {
          seen.add(auto.keyword);
          results.push({ keyword: auto.keyword, description: auto.description });
        }
      }
    }

    // Le repli de dernier recours n'a de sens que pour un nœud dont on
    // n'a RIEN à dire. Si le filtre ci-dessus vient d'écarter des
    // continuations faute de description, le nœud en a bien — les
    // remplacer par un `WORD` inventé annoncerait un argument là où la
    // commande attend un mot-clé, ce qui est un deuxième mensonge après
    // celui qu'on vient d'éviter.
    if (node.greedy && !node._noArgument && results.length === 0 && !autoIndescriptibles) {
      results.push({ keyword: 'WORD', description: node.description });
    }

    // <cr> — shown when the current command is already executable
    // (real Cisco always shows <cr> when you can press Enter)
    const keywordForm = firstArg !== null && this.isContinuationKeyword(node, firstArg);
    if ((!!node.action || !!node._porteAction)
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
