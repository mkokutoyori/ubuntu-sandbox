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
  hintSuggestions?: Array<{ keyword: string; description: string }>;
  _hintOnly?: boolean;
  _passthrough?: boolean;
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
    continuations: ReadonlyArray<string | { keyword: string; description: string }>,
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
    continuations: ReadonlyArray<string | { keyword: string; description: string }>,
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

  private isExecutableAt(node: CommandNode, suppliedArgs: number): boolean {
    return !!node.action && suppliedArgs >= this.requiredArity(node);
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
    const arityMet = keywordForm || this.isExecutableAt(node, args.length);
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
        continue;
      }

      const matches = this.prefixMatch(node, token);
      if (matches.length === 1) {
        node = matches[0];
        path.push(node.keyword);
        consumedArgs = 0;
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
      if (node.params.length > consumedArgs || node.greedy) {
        if (consumedArgs === 0) firstArg = tokens[i];
        consumedArgs++;
        continue;
      }

      return [];
    }

    // Trailing space → show subcommands/children of the last matched node
    return this.applyFilter(path, this.nodeCompletions(node, consumedArgs, firstArg));
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

    for (let i = 0; i < tokens.length - 1; i++) {
      const token = tokens[i].toLowerCase();

      const exactRaw = node.children.get(token);
      const exact = exactRaw && !exactRaw._hintOnly ? exactRaw : undefined;
      if (exact) {
        completed.push(exact.keyword);
        node = exact;
        paramIdx = 0;
        continue;
      }

      const matches = this.prefixMatch(node, token);
      if (matches.length === 1) {
        completed.push(matches[0].keyword);
        node = matches[0];
        paramIdx = 0;
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
          continue;
        }
      }

      completed.push(tokens[i]);
      paramIdx++;
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

    for (const m of this.prefixMatch(node, partialLower, true)) push(m.keyword);

    if (node.hintSuggestions) {
      for (const h of node.hintSuggestions) {
        if (h.keyword.toLowerCase().startsWith(partialLower)) push(h.keyword);
      }
    }

    for (const auto of this.autoContinuations(node)) {
      if (auto.keyword.startsWith(partialLower)) push(auto.keyword);
    }

    for (const v of this.enumValues(node, paramIdx)) {
      if (v.keyword.toLowerCase().startsWith(partialLower)) push(v.keyword);
    }

    if (this.dynamicResolver) {
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
  private autoContinuations(node: CommandNode): ReadonlyArray<{ keyword: string; description: string }> {
    if (node._autoKeywords !== undefined) return node._autoKeywords;
    if (!node.greedy || !node.action) {
      node._autoKeywords = [];
      return node._autoKeywords;
    }
    const curated = new Set((node.hintSuggestions ?? []).map(h => h.keyword.toLowerCase()));
    const children = new Set(node.children.keys());
    const extracted = extractHandlerKeywords(node.action.toString())
      .filter(kw => !curated.has(kw) && !children.has(kw));
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
        node.children.set(key, child);
      }
      node = child;
    }
    node.params = [...specs];
  }

  private hintDescription(node: CommandNode, keyword: string): string {
    const key = keyword.toLowerCase();
    return node.hintSuggestions?.find(h => h.keyword.toLowerCase() === key)?.description ?? '';
  }

  private enumValues(
    node: CommandNode,
    consumedArgs: number,
  ): ReadonlyArray<{ keyword: string; description: string }> {
    const param = node.params[consumedArgs];
    return param?.type === 'ENUM' ? (param.values ?? []) : [];
  }

  requireArgs(path: string, minArgs: number): void {
    const node = this.nodeAt(path);
    if (node) node.minArgs = minArgs;
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
  ): Array<{ keyword: string; description: string }> {
    const raw = dedupeByKeyword(this.nodeCompletionsUnsorted(node, consumedArgs, firstArg));
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
  ): Array<{ keyword: string; description: string }> {
    const results: Array<{ keyword: string; description: string }> = [];

    // Tant que la commande ATTEND ENCORE un argument, les mots-clés
    // enfants ne sont pas des candidats : après `ip address
    // 192.168.10.1`, IOS attend le masque, pas `dhcp`. Une fois les
    // arguments servis, les mots-clés qui les suivent redeviennent
    // proposables — `access-list 10 ?` rend bien `deny`/`permit`.
    const argumentsConsumed = consumedArgs > 0 && node.params.length > consumedArgs;
    if (!argumentsConsumed) {
      for (const [, child] of node.children) {
        if (child._hintOnly && !child._passthrough) continue;
        const described = this.resolveDescription(child);
        results.push({
          keyword: child.keyword,
          description: described || this.hintDescription(node, child.keyword),
        });
      }
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
      for (const hint of node.hintSuggestions) {
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
    if (!argumentsConsumed && !awaitsDeclaredArgument) {
      const seen = new Set(results.map(r => r.keyword.toLowerCase()));
      for (const auto of this.autoContinuations(node)) {
        if (!seen.has(auto.keyword)) {
          seen.add(auto.keyword);
          results.push({ keyword: auto.keyword, description: auto.description });
        }
      }
    }

    if (node.greedy && results.length === 0) {
      results.push({ keyword: 'WORD', description: node.description });
    }

    // <cr> — shown when the current command is already executable
    // (real Cisco always shows <cr> when you can press Enter)
    const keywordForm = firstArg !== null && this.isContinuationKeyword(node, firstArg);
    if (!!node.action && (keywordForm || this.isExecutableAt(node, consumedArgs))) {
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
