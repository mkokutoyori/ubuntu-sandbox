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
import type { IShell } from './IShell';
import { ShellContext } from './ShellContext';

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
   * Vendor-specific escape hatch — opaque payload propagated to the
   * concrete Shell constructor. Used to pass `WindowsShellSession`,
   * `LinuxShellSession`, router VTY index, etc., without polluting the
   * factory contract with platform fields.
   */
  readonly extras?: Readonly<Record<string, unknown>>;
}

export type ShellConstructor = (args: ShellSpawnArgs & { context: ShellContext }) => IShell;

export class ShellFactory {
  private static readonly registry: Map<string, ShellConstructor> = new Map();

  /** Register a Shell implementation under its `kind` identifier. */
  static register(kind: string, ctor: ShellConstructor): void {
    this.registry.set(kind, ctor);
  }

  /** Clear the registry — primarily for tests. */
  static reset(): void { this.registry.clear(); }

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
      constructor: { name: string };
    };
    const hostname = dev.getHostname?.() ?? 'remote';
    const cwd = args.cwd ?? this.defaultCwdFor(dev, args.user);
    const creds = args.user === 'root'
      ? ShellContext.rootCredentials()
      : ShellContext.userCredentials(args.user);
    const ctx = new ShellContext(hostname, creds, cwd, args.env ?? {});
    return ctx;
  }

  /**
   * Vendor-aware default cwd. Honours the SSH user's home — `/home/<u>`
   * on POSIX, `C:\Users\<u>` on Windows — instead of inheriting the
   * device's local-console cwd, which belongs to a different user.
   */
  private static defaultCwdFor(
    dev: { constructor: { name: string } },
    user: string,
  ): string {
    const cls = dev.constructor.name;
    if (cls === 'WindowsPC' || cls === 'WindowsServer') {
      return `C:\\Users\\${user}`;
    }
    if (user === 'root') return '/root';
    return `/home/${user}`;
  }
}
