/**
 * IShellBase — the minimum contract every shell in the simulator
 * implements, regardless of which generation it belongs to.
 *
 * Two parallel hierarchies live in the codebase: the legacy
 * `ISubShell` (per-terminal sub-shells like SQL*Plus, RMAN, SFTP) and
 * the new `IShell` (full Shell-layer adapters used by SSH push and
 * the cross-vendor stack). Making them both extend this base gives the
 * project a single shell ancestor that callers, tests and tools can
 * branch on uniformly — `shell.kind`, `shell.connection`,
 * `shell.getPrompt()`, `shell.dispose()` always exist.
 *
 * IShellBase intentionally exposes only the subset that BOTH worlds
 * agree on. Anything richer (input modes, full key classification,
 * lifecycle hooks) lives in `IShell` and is therefore opt-in.
 */

export type ShellConnection = 'console' | 'ssh' | 'telnet' | 'subshell';

export interface IShellBase {
  /** Stable identifier — `bash`, `cmd`, `powershell`, `sqlplus`, … */
  readonly kind: string;

  /** How this shell is being driven. Immutable for the shell's lifetime. */
  readonly connection: ShellConnection;

  /** Prompt string for the next input line. */
  getPrompt(): string;

  /**
   * Tab-completion candidates for `line`. Optional because some legacy
   * sub-shells (RMAN, SFTP) ship no completion engine; callers should
   * default to an empty list when the method is absent.
   */
  getCompletions?(line: string): readonly string[] | string[];

  /** Release any held resources (sessions, file handles, …). */
  dispose(): void;
}
