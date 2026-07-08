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

// ─── Parameter Types ────────────────────────────────────────────────

export type ParamType = 'INT' | 'STRING' | 'IP_ADDR' | 'SUBNET_MASK' | 'MAC_ADDR' | 'INTERFACE' | 'VLAN_LIST' | 'WORD';

export interface ParamSpec {
  name: string;
  type: ParamType;
  description: string;
  optional?: boolean;
  validator?: (value: string) => boolean;
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
  hintSuggestions?: Array<{ keyword: string; description: string }>;
  _hintOnly?: boolean;
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
  /** For invalid input: position of the error in the input */
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
   * skipping a denylist and never overwriting existing children. Models
   * Cisco's "most show commands are privilege-1": the privileged trie's
   * show family is mirrored into user EXEC except the genuinely priv-15
   * entries.
   */
  copySubtreeChildrenInto(keyword: string, target: CommandTrie, deny: ReadonlySet<string>): void {
    const src = this.root.children.get(keyword.toLowerCase());
    const dst = target.root.children.get(keyword.toLowerCase());
    if (!src || !dst) return;
    for (const [k, node] of src.children) {
      if (deny.has(k)) continue;
      if (!dst.children.has(k)) dst.children.set(k, node);
    }
  }

  private resolveDescription(node: CommandNode): string {
    if (node.description === node.keyword) {
      return this.canonicalDescriptions.get(node.keyword) ?? node.description;
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
            return { status: 'ok', node, args, matchedKeywords };
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
            return { status: 'ok', node, args, matchedKeywords };
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
              return { status: 'ok', node, args, matchedKeywords };
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
        return { status: 'ok', node, args, matchedKeywords };
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
      return { status: 'ok', node, args, matchedKeywords };
    }

    // Check if there are required params not yet supplied
    if (node.params.length > 0 && args.length < node.params.filter(p => !p.optional).length) {
      return { status: 'incomplete', node, args, matchedKeywords, error: '% Incomplete command.' };
    }

    // Node exists but has no action and has children → incomplete
    if (node.children.size > 0) {
      return { status: 'incomplete', node, args, matchedKeywords, error: '% Incomplete command.' };
    }

    return { status: 'incomplete', node, args, matchedKeywords, error: '% Incomplete command.' };
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
  getCompletions(inputBeforeQuestion: string): Array<{ keyword: string; description: string }> {
    const raw = inputBeforeQuestion;
    const tokens = raw.trim().split(/\s+/).filter(t => t.length > 0);
    const endsWithSpace = raw.length > 0 && raw.endsWith(' ');

    // Empty input or just spaces → show all root commands
    if (tokens.length === 0) {
      return this.nodeCompletions(this.root, []);
    }

    let node = this.root;
    const path: string[] = [];

    // Navigate through all complete (non-last) tokens
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i].toLowerCase();
      const isLast = i === tokens.length - 1;

      if (isLast && !endsWithSpace) {
        // PARTIAL TOKEN (no trailing space) → prefix listing
        // "sh?" → which keywords start with "sh"? List them.
        // "show?" → which keywords start with "show"? → "show"
        // Never drill down into the match — just show the matches themselves.
        const matches = this.prefixMatch(node, token);
        const listed = matches.map(m => ({ keyword: m.keyword, description: this.resolveDescription(m) }));
        if (this.dynamicResolver) {
          const seen = new Set(listed.map(e => e.keyword.toLowerCase()));
          const context: DynamicCompletionContext = {
            path,
            paramType: node.params[0]?.type ?? null,
            partial: tokens[i],
          };
          for (const value of this.dynamicResolver.candidatesFor(context)) {
            if (value.toLowerCase().startsWith(token) && !seen.has(value.toLowerCase())) {
              seen.add(value.toLowerCase());
              listed.push({ keyword: value, description: '' });
            }
          }
        }
        return listed;
      }

      const exactRawHelp = node.children.get(token);
      if (exactRawHelp) {
        node = exactRawHelp;
        path.push(node.keyword);
        continue;
      }

      const matches = this.prefixMatch(node, token);
      if (matches.length === 1) {
        node = matches[0];
        path.push(node.keyword);
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

      return [];
    }

    // Trailing space → show subcommands/children of the last matched node
    return this.nodeCompletions(node, path);
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

    for (const m of this.prefixMatch(node, partialLower)) push(m.keyword);

    if (node.hintSuggestions) {
      for (const h of node.hintSuggestions) {
        if (h.keyword.toLowerCase().startsWith(partialLower)) push(h.keyword);
      }
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

  private prefixMatch(node: CommandNode, prefix: string): CommandNode[] {
    const results: CommandNode[] = [];
    for (const [keyword, child] of node.children) {
      if (child._hintOnly) continue;
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
  private nodeCompletions(node: CommandNode, path: readonly string[]): Array<{ keyword: string; description: string }> {
    const results: Array<{ keyword: string; description: string }> = [];

    for (const [, child] of node.children) {
      results.push({ keyword: child.keyword, description: this.resolveDescription(child) });
    }

    // Parameter specs
    for (const param of node.params) {
      results.push({ keyword: `<${param.name}>`, description: param.description });
    }

    if (node.hintSuggestions && node.hintSuggestions.length > 0) {
      const seen = new Set(results.map(r => r.keyword.toLowerCase()));
      for (const hint of node.hintSuggestions) {
        if (!seen.has(hint.keyword.toLowerCase())) {
          results.push(hint);
          seen.add(hint.keyword.toLowerCase());
        }
      }
    }

    if (this.dynamicResolver && path.length > 0) {
      const seen = new Set(results.map(r => r.keyword.toLowerCase()));
      const context: DynamicCompletionContext = {
        path,
        paramType: node.params[0]?.type ?? null,
        partial: '',
      };
      for (const value of this.dynamicResolver.candidatesFor(context)) {
        if (!seen.has(value.toLowerCase())) {
          seen.add(value.toLowerCase());
          results.push({ keyword: value, description: '' });
        }
      }
    }

    if (node.greedy && results.length === 0) {
      results.push({ keyword: 'WORD', description: node.description });
    }

    // <cr> — shown when the current command is already executable
    // (real Cisco always shows <cr> when you can press Enter)
    if (node.action) {
      results.push({ keyword: '<cr>', description: '' });
    }

    return results;
  }

  private validateParam(value: string, spec: ParamSpec): boolean {
    if (spec.validator) return spec.validator(value);

    switch (spec.type) {
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
    const marker = ' '.repeat(errorPos) + '^';
    return `% Invalid input detected at '^' marker.\n${input}\n${marker}`;
  }
}
