/**
 * ShellActionRegistry — the single dispatch surface for terminal actions.
 *
 * Responsibilities:
 *   1. Resolve a typed line through an injected {@link AliasExpander}
 *      so the registered actions are matched on the CANONICAL head, not
 *      the user's (possibly aliased) head word.
 *   2. Look up a {@link ShellAction} for that head, either via the exact
 *      name index or a per-action `match` predicate.
 *   3. Expose a clean API for the runtime — `resolve(line)` returns the
 *      action + parsed argv; `register(action)` plugs new behaviours in.
 *
 * The registry is intentionally agnostic of Linux / Windows / Cisco —
 * each vendor brings its own bundle of registrations (see
 * `bundles/LinuxActionBundle.ts`).
 */

import type { ShellAction } from './ShellAction';

export interface AliasExpander {
  /** Replace the leading word(s) by their alias targets, idempotently. */
  expand(line: string): string;
}

export interface ResolvedAction {
  readonly action: ShellAction;
  readonly head: string;
  readonly args: ReadonlyArray<string>;
  readonly resolvedLine: string;
}

export class ShellActionRegistry {
  private readonly byName = new Map<string, ShellAction>();
  private readonly predicates: ShellAction[] = [];

  constructor(private readonly aliasExpander: AliasExpander = { expand: l => l }) {}

  register(action: ShellAction): void {
    if (this.byName.has(action.name)) {
      throw new Error(`ShellActionRegistry: duplicate action "${action.name}"`);
    }
    this.byName.set(action.name, action);
    if (action.match) this.predicates.push(action);
  }

  registerAll(actions: Iterable<ShellAction>): void {
    for (const a of actions) this.register(a);
  }

  has(name: string): boolean { return this.byName.has(name); }
  get(name: string): ShellAction | undefined { return this.byName.get(name); }
  list(): ReadonlyArray<ShellAction> { return [...this.byName.values()]; }

  /**
   * Resolve a typed command line into the action that should handle it.
   *
   * Returns null when no action matches — the caller is then free to
   * forward the line to its generic execution path (bash interpreter,
   * cmd.exe dispatcher …).
   */
  resolve(typedLine: string): ResolvedAction | null {
    const resolvedLine = this.aliasExpander.expand(typedLine.trim());
    if (!resolvedLine) return null;
    const parts = tokenize(resolvedLine);
    if (parts.length === 0) return null;
    const head = parts[0];
    const args = parts.slice(1);
    const exact = this.byName.get(head);
    if (exact) return { action: exact, head, args, resolvedLine };
    for (const pred of this.predicates) {
      if (pred.match!(head)) return { action: pred, head, args, resolvedLine };
    }
    return null;
  }
}

/** Whitespace-split that respects single/double quotes. */
function tokenize(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let pending = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) { quote = null; continue; }
      cur += c; pending = true; continue;
    }
    if (c === '"' || c === "'") { quote = c; pending = true; continue; }
    if (/\s/.test(c)) {
      if (pending) { out.push(cur); cur = ''; pending = false; }
      continue;
    }
    cur += c; pending = true;
  }
  if (pending) out.push(cur);
  return out;
}
