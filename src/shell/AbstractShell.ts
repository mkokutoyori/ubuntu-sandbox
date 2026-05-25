/**
 * AbstractShell — the Template-Method base class every concrete shell
 * extends.
 *
 * Why a base class? Almost every shell, regardless of vendor, has the
 * same surface for the things a terminal driver needs:
 *   - prompt rendering
 *   - history (Up/Down arrows)
 *   - vendor-neutral key actions (Ctrl+C cancels, Ctrl+L clears,
 *     Ctrl+D ends the shell)
 *   - lifecycle hooks (activate/pause/resume/deactivate/dispose)
 *
 * What changes between shells is ONLY the actual command dispatch and
 * the prompt string — those are abstract here. Tab-completion and
 * special-line recognition (`exit`, `clear`, …) have sane defaults the
 * subclass can override.
 *
 * Design pattern: **Template Method** — `processLine` orchestrates the
 * pipeline (history → exit gate → clear-screen gate → dispatch) and
 * delegates the variable bit (`dispatch`) to subclasses. Same for
 * `classifyKey`.
 */

import type { Equipment } from '@/network';
import type {
  IShell, ShellKeyEvent, ShellLineResult, ShellSpecialAction,
} from './IShell';
import { ShellContext } from './ShellContext';

export interface AbstractShellOptions {
  readonly device: Equipment;
  readonly user: string;
  readonly context: ShellContext;
  /** Optional parent shell — set when this shell is nested under another. */
  readonly parent?: IShell | null;
}

export abstract class AbstractShell implements IShell {
  /** Stable identifier — `bash`, `cmd`, `powershell`, … */
  abstract readonly kind: string;

  readonly device: Equipment;
  readonly user: string;
  readonly context: ShellContext;
  protected parent: IShell | null;

  /** Words that, when typed alone, unwind this shell — defaults are POSIX. */
  protected exitWords: ReadonlySet<string> = new Set(['exit', 'logout']);

  /** Aliases for "wipe the screen now" — defaults cover Linux + Windows. */
  protected clearWords: ReadonlySet<string> = new Set(['clear', 'cls']);

  /** Whether this shell has been disposed (idempotency guard). */
  private _disposed = false;

  /** True between `activate()` and `deactivate()`. */
  private _active = false;

  constructor(opts: AbstractShellOptions) {
    this.device = opts.device;
    this.user = opts.user;
    this.context = opts.context;
    this.parent = opts.parent ?? null;
  }

  // ─── Required hooks ────────────────────────────────────────────────

  abstract getPrompt(): string;

  /**
   * Vendor-specific dispatch. Receives the raw trimmed line (already
   * non-empty, not an exit word, not a clear word). Returns the
   * vendor's output and optionally a child shell to push.
   */
  protected abstract dispatch(line: string): Promise<ShellLineResult> | ShellLineResult;

  // ─── Defaultable hooks ─────────────────────────────────────────────

  /** Lines printed when this shell is activated. Default: none. */
  getActivationBanner(): readonly string[] { return []; }

  /** Lines printed when this shell is deactivated. Default: none. */
  getDeactivationBanner(): readonly string[] { return []; }

  /**
   * Tab-completion candidates. Default delegates to the underlying
   * device's `getCompletions(line)` if present — concrete subclasses can
   * override to enrich with shell-specific candidates (cmdlets, etc.).
   */
  getCompletions(line: string): readonly string[] {
    const dev = this.device as unknown as { getCompletions?: (p: string) => string[] };
    return dev.getCompletions ? dev.getCompletions(line) : [];
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────

  activate(): void { this._active = true; this.onActivate(); }
  pause(): void { this.onPause(); }
  resume(): void { this.onResume(); }
  deactivate(): void { this._active = false; this.onDeactivate(); }
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this.onDispose();
  }

  /** Subclass extension points — default no-ops. */
  protected onActivate(): void {}
  protected onPause(): void {}
  protected onResume(): void {}
  protected onDeactivate(): void {}
  protected onDispose(): void {}

  get isActive(): boolean { return this._active; }
  get isDisposed(): boolean { return this._disposed; }

  // ─── Template-method pipeline ──────────────────────────────────────

  /**
   * Process a line by walking the standard pipeline:
   *   1. History push (non-empty, non-duplicate)
   *   2. Empty → just a fresh prompt
   *   3. Exit word → unwind
   *   4. Clear word → wipe screen, no dispatch
   *   5. Otherwise → vendor dispatch
   */
  async processLine(line: string): Promise<ShellLineResult> {
    const trimmed = line.trim();

    this.context.pushHistory(trimmed);

    if (!trimmed) return { output: [] };

    const lower = trimmed.toLowerCase();

    if (this.exitWords.has(lower)) {
      return { output: this.getDeactivationBanner().slice(), exit: true };
    }

    if (this.clearWords.has(lower)) {
      return { output: [], clearScreen: true };
    }

    const result = await this.dispatch(trimmed);
    // Normalise the readonly contract — never mutate the caller's array.
    return {
      output: result.output ?? [],
      childShell: result.childShell,
      exit: result.exit,
      clearScreen: result.clearScreen,
      suppressPrompt: result.suppressPrompt,
    };
  }

  /**
   * Map a keystroke to a vendor-neutral action. Subclasses extend
   * `extraKeyMappings` to add their own (e.g. Cisco's `Ctrl+Z` ⇒ end).
   */
  classifyKey(e: ShellKeyEvent): ShellSpecialAction {
    if (e.ctrlKey && e.key === 'c') return { kind: 'cancel' };
    if (e.ctrlKey && e.key === 'l') return { kind: 'clear-screen' };
    if (e.ctrlKey && e.key === 'd') return { kind: 'eof' };
    if (e.key === 'ArrowUp') return { kind: 'history-prev' };
    if (e.key === 'ArrowDown') return { kind: 'history-next' };
    return this.extraKeyMappings(e);
  }

  /** Hook for vendor-specific extra key mappings. Default: nothing. */
  protected extraKeyMappings(_e: ShellKeyEvent): ShellSpecialAction {
    return { kind: 'none' };
  }
}
