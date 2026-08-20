/**
 * ShellFactory — single place that knows how to instantiate a Shell.
 *
 * Design pattern: **Factory Method + Registry**. Concrete Shell classes
 * register themselves under a kind string; consumers ask the factory
 * for a shell by kind without importing the concrete classes — that
 * keeps the dependency graph acyclic (e.g. LinuxBashShell can spawn a
 * SqlPlusShell without importing it directly).
 *
 * The registry is filled at module-load time by the {@link installDefaultShells}
 * helper which lives in {@link ./registerDefaults}; tests that need a
 * minimal registry can call `ShellFactory.reset()` and re-register
 * only the shells they care about.
 */

import type { Equipment } from '@/network';
import type { IShell, ShellConnection } from './IShell';
import { ShellContext } from './ShellContext';
import { primaryShellKindFor } from './shellKind';

export interface ShellSpawnArgs {
  readonly device: Equipment;
  readonly user: string;
  /** Parent shell when this one is being launched from inside another. */
  readonly parent?: IShell | null;
  /** Optional cwd/env seed; defaults derived from the device + user. */
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  /** Raw command line that triggered the spawn (e.g. `sqlplus / as sysdba`). */
  readonly launchLine?: string;
  /**
   * How the shell is being driven. Defaults to `console` for the top-level
   * spawn; SSH/sub-shell paths set it explicitly so the shell can render
   * connection-aware behaviour.
   */
  readonly connection?: ShellConnection;
  /**
   * Vendor-specific escape hatch — opaque payload propagated to the
   * concrete Shell constructor. Used to pass `WindowsShellSession`,
   * `LinuxShellSession`, router VTY index, etc., without polluting the
   * factory contract with platform fields.
   */
  readonly extras?: Readonly<Record<string, unknown>>;
}

export type ShellConstructor = (args: ShellSpawnArgs & { context: ShellContext }) => IShell;

/**
 * Optional metadata describing how a shell kind is *reached* from
 * another shell. Declaring it here — next to the constructor — is what
 * makes a new interpreter (python3, psql, mysql, …) work everywhere at
 * once: the console terminal, the SSH server's own sub-shell stack and
 * any future host all ask the factory the same question instead of
 * carrying their own launcher tables.
 */
export interface ShellRegistration {
  /**
   * Command line that execs this interpreter from a parent shell, e.g.
   * `/^psql\b/i`. Omit for shells that are only ever the primary.
   */
  readonly launcher?: RegExp;
  /**
   * Kinds of parent shell the launcher is recognised in — `['bash']` for
   * POSIX tools, `['cmd']` for Windows ones. Omit to match any parent.
   */
  readonly launchableFrom?: readonly string[];
}

export class ShellFactory {
  private static readonly registry: Map<string, ShellConstructor> = new Map();
  private static readonly launchers: Map<string, ShellRegistration> = new Map();

  /** Register a Shell implementation under its `kind` identifier. */
  static register(kind: string, ctor: ShellConstructor, meta?: ShellRegistration): void {
    this.registry.set(kind, ctor);
    if (meta?.launcher) this.launchers.set(kind, meta);
    else this.launchers.delete(kind);
  }

  /**
   * The kind of shell `line` launches when typed at a `from` prompt, or
   * null when it launches none. Both the local terminal and the SSH
   * server route sub-shell entry through this, so the two can never
   * drift apart on which commands open a REPL.
   */
  static launcherKindFor(line: string, from: string): string | null {
    const trimmed = line.trim();
    for (const [kind, meta] of this.launchers) {
      if (!meta.launcher?.test(trimmed)) continue;
      if (meta.launchableFrom && !meta.launchableFrom.includes(from)) continue;
      return kind;
    }
    return null;
  }

  /** Clear the registry — primarily for tests. */
  static reset(): void { this.registry.clear(); this.launchers.clear(); }

  /** True if a shell of that kind has been registered. */
  static has(kind: string): boolean { return this.registry.has(kind); }

  /** Instantiate a shell of the given kind, or throw if not registered. */
  static create(kind: string, args: ShellSpawnArgs): IShell {
    const ctor = this.registry.get(kind);
    if (!ctor) throw new Error(`No shell registered for kind '${kind}'`);
    const context = this.buildContext(args);
    return ctor({ ...args, context });
  }

  /**
   * Soft-create — returns null if the kind isn't registered or the
   * factory failed. Used by parent shells that *might* hand off to a
   * child but should print the legacy fallback when the child isn't
   * available (e.g. `sqlplus` on a non-Oracle host).
   */
  static tryCreateChild(kind: string, args: ShellSpawnArgs): IShell | null {
    try {
      if (!this.has(kind)) return null;
      return this.create(kind, args);
    } catch {
      return null;
    }
  }

  /** Build a fresh ShellContext for the spawn, derived from the device. */
  private static buildContext(args: ShellSpawnArgs): ShellContext {
    const dev = args.device as unknown as {
      getHostname?: () => string;
      getCwd?: () => string;
      getOSType?: () => string;
      resolveAccountName?: (name: string) => string | undefined;
    };
    const hostname = dev.getHostname?.() ?? 'remote';
    // Logins are case-insensitive but a profile directory carries the
    // account's own spelling, so `ssh user@host` must land in the `User`
    // profile — the same prompt the remote publishes over the wire.
    const user = dev.resolveAccountName?.(args.user) ?? args.user;
    const cwd = args.cwd ?? this.defaultCwdFor(dev, user);
    const creds = user === 'root'
      ? ShellContext.rootCredentials()
      : ShellContext.userCredentials(user);
    const ctx = new ShellContext(hostname, creds, cwd, args.env ?? {});
    return ctx;
  }

  /**
   * Vendor-aware default cwd. Honours the SSH user's home — `/home/<u>`
   * on POSIX, `C:\Users\<u>` on Windows — instead of inheriting the
   * device's local-console cwd, which belongs to a different user.
   */
  private static defaultCwdFor(
    dev: { getOSType?: () => string },
    user: string,
  ): string {
    if (primaryShellKindFor(dev) === 'cmd') {
      return `C:\\Users\\${user}`;
    }
    if (user === 'root') return '/root';
    return `/home/${user}`;
  }
}
