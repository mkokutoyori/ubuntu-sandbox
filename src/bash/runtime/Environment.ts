/**
 * Environment — Variable scope management for bash interpreter.
 *
 * Supports:
 * - Scoped variables (local/global) via scope chain
 * - Special variables ($?, $$, $0, $1..., $@, $#, $!)
 * - Export tracking (for subshell inheritance)
 * - Positional parameters ($1, $2, ..., $@, $#)
 */

export interface EnvironmentOptions {
  /** Initial variables (e.g. PATH, HOME). */
  variables?: Record<string, string>;
  /** Script name ($0). */
  scriptName?: string;
  /** Positional arguments ($1, $2, ...). */
  positionalArgs?: string[];
}

export class Environment {
  /** Variable storage: name → value. */
  private vars: Map<string, string> = new Map();
  /** Exported variable names. */
  private exported: Set<string> = new Set();
  /** Readonly variable names. */
  private readonlyVars: Set<string> = new Set();
  /** Parent scope (for local variable lookups). */
  private parent: Environment | null = null;
  /** Last exit code ($?). */
  private _lastExitCode: number = 0;
  /** Process ID ($$) — simulated. */
  private readonly pid: number;

  constructor(options: EnvironmentOptions = {}) {
    this.pid = Math.floor(Math.random() * 30000) + 1000;

    if (options.variables) {
      for (const [k, v] of Object.entries(options.variables)) {
        this.vars.set(k, v);
      }
    }
    if (options.scriptName !== undefined) {
      this.vars.set('0', options.scriptName);
    }
    this.setPositionalArgs(options.positionalArgs ?? []);
  }

  // ─── Variable Access ──────────────────────────────────────────

  /** Get a variable value, searching up the scope chain. */
  get(name: string): string | undefined {
    // Special variables first
    const special = this.getSpecial(name);
    if (special !== undefined) return special;

    if (this.vars.has(name)) return this.vars.get(name);
    return this.parent?.get(name);
  }

  /** Set a variable in the current scope. Throws if readonly. */
  set(name: string, value: string): void {
    if (this.readonlyVars.has(name)) {
      throw new Error(`bash: ${name}: readonly variable`);
    }
    this.vars.set(name, value);
  }

  /** Mark a variable as readonly (optionally set its value). */
  setReadonly(name: string, value?: string): void {
    if (value !== undefined) this.vars.set(name, value);
    this.readonlyVars.add(name);
  }

  /** Check if a variable is readonly. */
  isReadonly(name: string): boolean {
    return this.readonlyVars.has(name);
  }

  /** Unset a variable. */
  unset(name: string): void {
    this.vars.delete(name);
    this.exported.delete(name);
  }

  /** Check if a variable is set (including empty string). */
  isSet(name: string): boolean {
    return this.get(name) !== undefined;
  }

  // ─── Export ───────────────────────────────────────────────────

  /** Mark a variable as exported. */
  export(name: string, value?: string): void {
    if (value !== undefined) this.set(name, value);
    this.exported.add(name);
  }

  /** Get all exported variables as a record. */
  getExported(): Record<string, string> {
    const result: Record<string, string> = {};
    if (this.parent) {
      Object.assign(result, this.parent.getExported());
    }
    for (const name of this.exported) {
      const val = this.get(name);
      if (val !== undefined) result[name] = val;
    }
    return result;
  }

  // ─── Positional Parameters ────────────────────────────────────

  /** Set positional arguments ($1, $2, ..., $@, $#). */
  setPositionalArgs(args: string[]): void {
    // Clear old positional
    let i = 1;
    while (this.vars.has(String(i))) {
      this.vars.delete(String(i));
      i++;
    }
    // Set new
    args.forEach((arg, idx) => this.vars.set(String(idx + 1), arg));
    this.vars.set('@', args.join(' '));
    this.vars.set('#', args.length.toString());
    this.vars.set('*', args.join(' '));
  }

  /** Get positional arguments as an array. */
  getPositionalArgs(): string[] {
    const count = parseInt(this.get('#') ?? '0');
    const args: string[] = [];
    for (let i = 1; i <= count; i++) {
      args.push(this.get(String(i)) ?? '');
    }
    return args;
  }

  // ─── Scope Management ─────────────────────────────────────────

  /** Create a child scope (for function calls). */
  createChild(): Environment {
    const child = new Environment();
    child.parent = this;
    // Inherit PID and script name
    child.vars.set('0', this.get('0') ?? '');
    return child;
  }

  // ─── Exit Code ────────────────────────────────────────────────

  get lastExitCode(): number { return this._lastExitCode; }
  set lastExitCode(code: number) { this._lastExitCode = code; }

  // ─── Special Variables ────────────────────────────────────────

  private getSpecial(name: string): string | undefined {
    switch (name) {
      case '?': return String(this._lastExitCode);
      case '$': return String(this.pid);
      case '!': return this.vars.get('!') ?? '';
      default: return undefined;
    }
  }

  // ─── All Variables (for debugging) ────────────────────────────

  /** Get all variable names in current scope. */
  getAll(): Map<string, string> {
    const result = new Map<string, string>();
    if (this.parent) {
      for (const [k, v] of this.parent.getAll()) {
        result.set(k, v);
      }
    }
    for (const [k, v] of this.vars) {
      result.set(k, v);
    }
    return result;
  }
}
