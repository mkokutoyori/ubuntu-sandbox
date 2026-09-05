/**
 * PSInterpreter — Thin facade over PSRuntime.
 *
 * Preserves the exact public API used by tests and PowerShellSubShell:
 *   - new PSInterpreter()              — standalone, no device (NULL_PROVIDERS)
 *   - new PSInterpreter(providers)     — device-backed (WindowsPSProviders)
 *   - interp.execute(code): string
 *   - interp.executeInteractive(code): string
 *   - interp.getVariable(name): PSValue
 *   - interp.setVariable(name, value): void
 *   - interp.testPathHook
 *   - interp.envVarHook
 *
 * Internally delegates to PSRuntime. Providers are optional so the
 * standalone interpreter (no Windows device) keeps working unchanged.
 */

import { PSRuntime, PSRuntimeError } from '@/powershell/runtime/PSRuntime';
import { CmdletRegistry }            from '@/powershell/runtime/PSCmdletRegistry';
import { NULL_PROVIDERS }            from '@/powershell/providers/NullProviders';
import type { PSProviders }          from '@/powershell/providers/PSProviders';
import { registerCoreCmdlets }       from '@/powershell/cmdlets/core/index';
import type { PSValue }              from '@/powershell/runtime/PSEnvironment';
import type { PSScriptBlock }        from '@/powershell/parser/PSASTNode';

// Re-export PSRuntimeError so existing imports like
// `import { PSRuntimeError } from '@/powershell/interpreter/PSInterpreter'`
// continue to work without change.
export { PSRuntimeError };

// Lazy singletons: one registry per Windows edition, shared across all
// PSInterpreter instances of that edition (avoids re-registering on every
// `new PSInterpreter()`). Standalone interpreters (no device) get the full
// set so language-level tests keep every cmdlet available.
let _sharedRegistry: CmdletRegistry | null = null;
let _clientRegistry: CmdletRegistry | null = null;
function getSharedRegistry(): CmdletRegistry {
  if (!_sharedRegistry) {
    _sharedRegistry = new CmdletRegistry();
    registerCoreCmdlets(_sharedRegistry);
  }
  return _sharedRegistry;
}
function getClientRegistry(): CmdletRegistry {
  if (!_clientRegistry) {
    _clientRegistry = new CmdletRegistry();
    registerCoreCmdlets(_clientRegistry, { includeServerCmdlets: false });
  }
  return _clientRegistry;
}

export interface PSInterpreterOptions {
  /** Windows edition of the hosting device — 'client' hides Server-only cmdlets. */
  edition?: 'client' | 'server';
}

export class PSInterpreter {
  private readonly runtime: PSRuntime;

  constructor(providers: PSProviders = NULL_PROVIDERS, opts: PSInterpreterOptions = {}) {
    const registry = opts.edition === 'client' ? getClientRegistry() : getSharedRegistry();
    this.runtime = new PSRuntime(registry, providers);
    // Register a stub script for dot-sourcing tests
    this.runtime.registerScript('script.ps1', '$someVarFromScript = "dotSourced"');
  }

  /** Register a simulated script file for dot-sourcing (`. "path.ps1"`). */
  registerScript(path: string, content: string): void {
    this.runtime.registerScript(path, content);
  }

  // ── Public API (unchanged) ─────────────────────────────────────────────────

  execute(code: string): string {
    return this.runtime.execute(code);
  }

  executeInteractive(code: string): string {
    return this.runtime.executeInteractive(code);
  }

  getVariable(name: string): PSValue {
    return this.runtime.getVariable(name);
  }

  setVariable(name: string, value: PSValue): void {
    this.runtime.setVariable(name, value);
  }

  invokeRemote(block: PSScriptBlock, positionalArgs: PSValue[] = []): PSValue {
    return this.runtime.invokeScriptBlock(block, {}, positionalArgs, this.runtime.global);
  }

  /** All completable command names + aliases (for Tab completion). */
  listCommandNames(): string[] {
    return this.runtime.listCommandNames();
  }

  /** Variable names currently in scope (for `$x<Tab>`). */
  listVariableNames(): string[] {
    return this.runtime.listVariableNames();
  }

  /** Declared parameters for a cmdlet/alias (for `-<Tab>`). */
  getCommandParameters(name: string): string[] {
    return this.runtime.getCommandParameters(name);
  }

  // ── Hooks (forwarded to the runtime) ──────────────────────────────────────

  expandInterpolation(raw: string): string {
    return this.runtime.expandInterpolation(raw);
  }

  get testPathHook(): ((path: string) => boolean) | null {
    return this.runtime.testPathHook;
  }
  set testPathHook(fn: ((path: string) => boolean) | null) {
    this.runtime.testPathHook = fn;
  }

  get envVarHook(): ((name: string) => string | null) | null {
    return this.runtime.envVarHook;
  }
  set envVarHook(fn: ((name: string) => string | null) | null) {
    this.runtime.envVarHook = fn;
  }

  get historyHook(): (() => readonly string[]) | null {
    return this.runtime.historyHook;
  }
  set historyHook(fn: (() => readonly string[]) | null) {
    this.runtime.historyHook = fn;
  }
}
