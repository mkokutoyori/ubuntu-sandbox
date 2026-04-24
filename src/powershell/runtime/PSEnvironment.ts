/**
 * PSEnvironment — Lexical scope chain for PowerShell variables.
 *
 * PowerShell scoping rules:
 *   - Read walks up the parent chain (child sees parent variables).
 *   - Write creates or updates in the current scope only (no implicit parent mutation).
 *   - Explicit scope modifiers ($global:, $script:, $local:) are resolved here.
 *   - $env: variables are stored in a dedicated env map on the root scope.
 */

export type PSValue =
  | null
  | undefined
  | boolean
  | number
  | string
  | PSValue[]
  | Record<string, PSValue>
  | ((...args: PSValue[]) => PSValue)
  | object;

export class PSEnvironment {
  private readonly vars = new Map<string, PSValue>();
  private readonly parent: PSEnvironment | null;

  constructor(parent: PSEnvironment | null = null) {
    this.parent = parent;
  }

  // ─── Scope Factory ──────────────────────────────────────────────────────

  /** Creates a child scope for function/block invocation. */
  createChild(): PSEnvironment {
    return new PSEnvironment(this);
  }

  /** Returns the root (global) scope. */
  root(): PSEnvironment {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let scope: PSEnvironment = this;
    while (scope.parent !== null) scope = scope.parent;
    return scope;
  }

  // ─── Read ────────────────────────────────────────────────────────────────

  /**
   * Reads a variable.  Walks up parent scopes.
   * Returns `undefined` when not found (PowerShell returns $null for unset
   * variables but we keep undefined so callers can distinguish "not set").
   */
  get(name: string): PSValue {
    const key = name.toLowerCase();
    if (this.vars.has(key)) return this.vars.get(key)!;
    if (this.parent !== null) return this.parent.get(key);
    return undefined;
  }

  /** Reads from the global scope regardless of current depth. */
  getGlobal(name: string): PSValue {
    return this.root().get(name);
  }

  // ─── Write ───────────────────────────────────────────────────────────────

  /**
   * Writes to the current scope.
   * This matches PowerShell's default behaviour: assignments create a
   * local copy and never mutate parent scopes.
   */
  set(name: string, value: PSValue): void {
    this.vars.set(name.toLowerCase(), value);
  }

  /** Writes to the global (root) scope. */
  setGlobal(name: string, value: PSValue): void {
    this.root().set(name, value);
  }

  /**
   * Updates an existing variable in the nearest scope that owns it.
   * If the variable doesn't exist anywhere, creates it in the current scope.
   * Used for `+=`, `-=`, `++`, `--` and other in-place modifications.
   */
  update(name: string, value: PSValue): void {
    const key = name.toLowerCase();
    // Walk up to find owning scope
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let scope: PSEnvironment | null = this;
    while (scope !== null) {
      if (scope.vars.has(key)) {
        scope.vars.set(key, value);
        return;
      }
      scope = scope.parent;
    }
    // Not found anywhere — create in current scope
    this.vars.set(key, value);
  }

  // ─── Existence Check ─────────────────────────────────────────────────────

  has(name: string): boolean {
    const key = name.toLowerCase();
    if (this.vars.has(key)) return true;
    if (this.parent !== null) return this.parent.has(key);
    return false;
  }

  // ─── Snapshot (for debugging / testing) ─────────────────────────────────

  /** Returns all variables visible from this scope (current + ancestors). */
  snapshot(): Record<string, PSValue> {
    const result: Record<string, PSValue> = this.parent ? this.parent.snapshot() : {};
    for (const [k, v] of this.vars) result[k] = v;
    return result;
  }
}

// ─── Built-in Variable Initialiser ───────────────────────────────────────────

/** Seeds the global scope with PowerShell built-in automatic variables. */
export function seedBuiltins(env: PSEnvironment): void {
  env.set('true',  true);
  env.set('false', false);
  env.set('null',  null);

  env.set('PSVersionTable', {
    PSVersion:           '5.1.0',
    PSEdition:           'Desktop',
    BuildVersion:        '10.0.19041.1',
    CLRVersion:          '4.0.30319.42000',
    WSManStackVersion:   '3.0',
    PSCompatibleVersions: ['1.0', '2.0', '3.0', '4.0', '5.0', '5.1.0'],
    SerializationVersion: '1.1.0.1',
  } as Record<string, PSValue>);

  env.set('PSScriptRoot', '');
  env.set('PSCommandPath', '');
  env.set('MyInvocation', {} as Record<string, PSValue>);
  env.set('args', [] as PSValue[]);
  env.set('input', null);

  // $? — last command success status
  env.set('?', true);

  // $LASTEXITCODE — exit code of last native command
  env.set('LASTEXITCODE', 0);

  // $Error — accumulates error records
  env.set('Error', [] as PSValue[]);

  // Preference variables — default values matching PS 5.1
  env.set('ErrorActionPreference', 'Continue');
  env.set('VerbosePreference',     'SilentlyContinue');
  env.set('DebugPreference',       'SilentlyContinue');
  env.set('WarningPreference',     'Continue');
  env.set('ConfirmPreference',     'High');
  env.set('WhatIfPreference',      false);
  env.set('InformationPreference', 'SilentlyContinue');
  env.set('ProgressPreference',    'Continue');

  // Automatic path variables (generic defaults; host overrides via envVarHook)
  env.set('HOME',    'C:\\Users\\User');
  env.set('PSHOME',  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0');
  env.set('PROFILE', 'C:\\Users\\User\\Documents\\WindowsPowerShell\\Microsoft.PowerShell_profile.ps1');
}
