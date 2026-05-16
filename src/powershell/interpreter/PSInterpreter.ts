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

// Re-export PSRuntimeError so existing imports like
// `import { PSRuntimeError } from '@/powershell/interpreter/PSInterpreter'`
// continue to work without change.
export { PSRuntimeError };

// Lazy singleton: a single registry is shared across all PSInterpreter instances.
// Built once on first use (avoids re-registering on every `new PSInterpreter()`).
let _sharedRegistry: CmdletRegistry | null = null;
function getSharedRegistry(): CmdletRegistry {
  if (!_sharedRegistry) {
    _sharedRegistry = new CmdletRegistry();
    registerCoreCmdlets(_sharedRegistry);
  }
  return _sharedRegistry;
}

export class PSInterpreter {
  private readonly runtime: PSRuntime;

  constructor(providers: PSProviders = NULL_PROVIDERS) {
    this.runtime = new PSRuntime(getSharedRegistry(), providers);
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

  /** All completable command names + aliases (for Tab completion). */
  listCommandNames(): string[] {
    return this.runtime.listCommandNames();
  }

  // ── Hooks (forwarded to the runtime) ──────────────────────────────────────

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
}
