/**
 * CommandTrie - Trie-based command parser for Cisco IOS CLI emulation
 *
 * Supports:
 *   - Abbreviation matching (e.g., "sh" → "show", "conf t" → "configure terminal")
 *   - Ambiguity detection ("s" matches "show" and "shutdown" → ambiguous)
 *   - Context-aware help (?) listing valid completions
 *   - Parameter validation (INT, STRING, IP_ADDR, INTERFACE, etc.)
 *   - Tab completion
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
}

export type CommandAction = (args: string[], rawLine: string) => string;

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

  constructor() {
    this.root = this.createNode('', 'Root');
  }

  private createNode(keyword: string, description: string): CommandNode {
    return { keyword, description, children: new Map(), params: [] };
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
      if (i === keywords.length - 1) {
        child.description = description;
      }
      node = child;
    }

    node.action = action;
    if (params) node.params = params;
  }

  /**
   * Register a command with greedy argument consumption.
   * After matching keywords, all remaining tokens are passed as args.
   */
  registerGreedy(path: string, description: string, action: CommandAction): void {
    const keywords = path.split(/\s+/);
    let node = this.root;

    for (let i = 0; i < keywords.length; i++) {
      const kw = keywords[i].toLowerCase();
      let child = node.children.get(kw);
      if (!child) {
        child = this.createNode(kw, i === keywords.length - 1 ? description : kw);
        node.children.set(kw, child);
      }
      if (i === keywords.length - 1) {
        child.description = description;
      }
      node = child;
    }

    node.action = action;
    node.greedy = true;
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
      const exactChild = node.children.get(tokenLower);
      if (exactChild) {
        node = exactChild;
        matchedKeywords.push(node.keyword);
        paramIdx = 0;

        // If this node is greedy, collect remaining as args
        if (node.greedy && i < tokens.length - 1) {
          args.push(...tokens.slice(i + 1));
          return { status: 'ok', node, args, matchedKeywords };
        }
        continue;
      }

      // Prefix match
      const matches = this.prefixMatch(node, tokenLower);

      if (matches.length === 1) {
        node = matches[0];
        matchedKeywords.push(node.keyword);
        paramIdx = 0;

        // If this node is greedy, collect remaining as args
        if (node.greedy && i < tokens.length - 1) {
          args.push(...tokens.slice(i + 1));
          return { status: 'ok', node, args, matchedKeywords };
        }
        continue;
      }

      if (matches.length > 1) {
        // Try disambiguation: if there are more tokens, check which matches
        // can continue to the next token (lookahead disambiguation)
        if (i < tokens.length - 1) {
          const nextToken = tokens[i + 1].toLowerCase();
          const viable = matches.filter(m => {
            const exactNext = m.children.get(nextToken);
            if (exactNext) return true;
            const prefixNext = this.prefixMatch(m, nextToken);
            return prefixNext.length > 0;
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
   * Get completions for the current input (used by ? and Tab).
   * Returns list of { keyword, description } entries.
   */
  getCompletions(input: string): Array<{ keyword: string; description: string }> {
    const tokens = input.trim().split(/\s+/).filter(t => t.length > 0);
    let node = this.root;

    // Walk to the node matching all complete tokens
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i].toLowerCase();
      const isLast = i === tokens.length - 1;

      // If this is the last token and input ends with space, we want children of matched node
      // If not ending with space, we want prefix matches of current token
      if (isLast && !input.endsWith(' ')) {
        // Partial token — return prefix matches
        const matches = this.prefixMatch(node, token);
        if (matches.length === 1) {
          // Unique match — show its children or params
          node = matches[0];
          return this.nodeCompletions(node);
        }
        // Return all prefix matches
        return matches.map(m => ({ keyword: m.keyword, description: m.description }));
      }

      // Complete token — navigate
      const exact = node.children.get(token);
      if (exact) {
        node = exact;
        continue;
      }

      const matches = this.prefixMatch(node, token);
      if (matches.length === 1) {
        node = matches[0];
        continue;
      }

      // Disambiguate with lookahead if possible
      if (matches.length > 1 && i < tokens.length - 1) {
        const nextToken = tokens[i + 1].toLowerCase();
        const viable = matches.filter(m => {
          if (m.children.get(nextToken)) return true;
          return this.prefixMatch(m, nextToken).length > 0;
        });
        if (viable.length === 1) {
          node = viable[0];
          continue;
        }
      }

      // Can't navigate further
      return [];
    }

    return this.nodeCompletions(node);
  }

  /**
   * Get tab completion for the current partial input.
   * Returns the completed string or null if no unique completion.
   */
  tabComplete(input: string): string | null {
    const tokens = input.trim().split(/\s+/).filter(t => t.length > 0);
    if (tokens.length === 0) return null;

    let node = this.root;
    const completed: string[] = [];

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i].toLowerCase();
      const isLast = i === tokens.length - 1;

      if (isLast && !input.endsWith(' ')) {
        const matches = this.prefixMatch(node, token);
        if (matches.length === 1) {
          completed.push(matches[0].keyword);
          return completed.join(' ') + ' ';
        }
        return null;
      }

      const exact = node.children.get(token);
      if (exact) {
        completed.push(exact.keyword);
        node = exact;
        continue;
      }

      const matches = this.prefixMatch(node, token);
      if (matches.length === 1) {
        completed.push(matches[0].keyword);
        node = matches[0];
        continue;
      }

      // Disambiguate with lookahead
      if (matches.length > 1 && i < tokens.length - 1) {
        const nextToken = tokens[i + 1].toLowerCase();
        const viable = matches.filter(m => {
          if (m.children.get(nextToken)) return true;
          return this.prefixMatch(m, nextToken).length > 0;
        });
        if (viable.length === 1) {
          completed.push(viable[0].keyword);
          node = viable[0];
          continue;
        }
      }

      completed.push(token);
    }

    return null;
  }

  // ─── Internal Helpers ───────────────────────────────────────────

  private prefixMatch(node: CommandNode, prefix: string): CommandNode[] {
    const results: CommandNode[] = [];
    for (const [keyword, child] of node.children) {
      if (keyword.startsWith(prefix)) {
        results.push(child);
      }
    }
    return results;
  }

  private nodeCompletions(node: CommandNode): Array<{ keyword: string; description: string }> {
    const results: Array<{ keyword: string; description: string }> = [];

    for (const [, child] of node.children) {
      results.push({ keyword: child.keyword, description: child.description });
    }

    for (const param of node.params) {
      results.push({ keyword: `<${param.name}>`, description: param.description });
    }

    if (results.length === 0 && node.action) {
      results.push({ keyword: '<cr>', description: 'Execute command' });
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
