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
  /** Shell PID ($$). Defaults to a stable random value when omitted. */
  pid?: number;
  /** Parent PID ($PPID). */
  ppid?: number;
}

export class Environment {
  /** Variable storage: name → value. */
  private vars: Map<string, string> = new Map();
  /** Indexed-array storage: name → ordered element list. Lives in a
   *  parallel map (rather than a tagged-union value) so the existing
   *  string-only `vars` map and every consumer of `get()` keep working
   *  unchanged. Array scalar-style access (`$arr` → first element)
   *  reads this map; element/slice access goes through `getArrayElement`. */
  private arrays: Map<string, string[]> = new Map();
  /** Associative-array storage (`declare -A name`): name → key→value map.
   *  Kept separate from `arrays` so the two array kinds never collide;
   *  expansion code looks up either based on which slot owns the name. */
  private assocArrays: Map<string, Map<string, string>> = new Map();
  /** Exported variable names. */
  private exported: Set<string> = new Set();
  /** Readonly variable names. */
  private readonlyVars: Set<string> = new Set();
  /** Names explicitly declared `local` in this scope — confines writes here. */
  private localNames: Set<string> = new Set();
  /** Active `trap` handlers, keyed by normalised signal name (EXIT, INT, …). */
  private traps: Map<string, string> = new Map();
  /** Parent scope (for local variable lookups). */
  private parent: Environment | null = null;
  /** Last exit code ($?). */
  private _lastExitCode: number = 0;
  /** Process ID ($$) — simulated. */
  private readonly pid: number;
  /** Parent process ID ($PPID) — simulated. */
  private readonly ppid: number | undefined;

  constructor(options: EnvironmentOptions = {}) {
    this.pid = options.pid ?? Math.floor(Math.random() * 30000) + 1000;
    this.ppid = options.ppid;

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

  /**
   * Bash dynamic-scoping `set`:
   *   - if `name` was declared `local` in this scope → write here;
   *   - else walk up to the nearest scope that already owns `name`
   *     (skipping scopes where it was declared local) → write there;
   *   - else (truly new variable) write to the global/root scope.
   * Throws when the chosen binding is readonly.
   */
  set(name: string, value: string): void {
    const target = this.localNames.has(name) ? this : this.resolveSetTarget(name);
    if (target.readonlyVars.has(name)) {
      throw new Error(`bash: ${name}: readonly variable`);
    }
    target.vars.set(name, value);
  }

  /** Find the scope that should receive a non-local assignment. */
  private resolveSetTarget(name: string): Environment {
    let cursor: Environment | null = this;
    while (cursor) {
      if (cursor.localNames.has(name)) return cursor;       // local binding owns it
      if (cursor.vars.has(name)) return cursor;             // first non-local owner
      if (cursor.parent === null) return cursor;            // fell off the chain → root
      cursor = cursor.parent;
    }
    return this;                                            // unreachable
  }

  /** Declare `name` as local to this scope so future writes stay here. */
  declareLocal(name: string): void {
    this.localNames.add(name);
  }

  // ─── trap handlers ────────────────────────────────────────────

  /** Install (or replace) the handler for `signal`. */
  setTrap(signal: string, body: string): void { this.traps.set(signal, body); }
  /** Drop the handler for `signal`. */
  clearTrap(signal: string): void { this.traps.delete(signal); }
  /** Get the registered body for `signal`, or undefined. */
  getTrap(signal: string): string | undefined { return this.traps.get(signal); }
  /** Snapshot every (signal, body) pair, for `trap` with no args. */
  listTraps(): Array<[string, string]> { return [...this.traps.entries()]; }

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
    this.arrays.delete(name);
    this.assocArrays.delete(name);
    this.exported.delete(name);
  }

  /** Check if a variable is set (including empty string). */
  isSet(name: string): boolean {
    return this.get(name) !== undefined || this.lookupArray(name) !== undefined;
  }

  // ─── Indexed Arrays ───────────────────────────────────────────

  /**
   * Find the (parent-walked) scope owning `name`'s array, mirroring
   * `get()` lookup semantics so child scopes see the parent's arrays.
   */
  private lookupArray(name: string): string[] | undefined {
    if (this.arrays.has(name)) return this.arrays.get(name);
    return this.parent?.lookupArray(name);
  }

  /**
   * Replace `name`'s array with `values`. Dynamic-scoping rules match
   * `set()`: writes go to the nearest owner, falling back to root.
   */
  setArray(name: string, values: string[]): void {
    const target = this.localNames.has(name) ? this : this.resolveArrayTarget(name);
    if (target.readonlyVars.has(name)) {
      throw new Error(`bash: ${name}: readonly variable`);
    }
    target.arrays.set(name, [...values]);
    // Keep the scalar slot in sync with element 0 so bare $name reads
    // the first element (the convention real bash follows for indexed
    // arrays); legacy consumers that only know about scalars still see
    // a sensible value.
    target.vars.set(name, values[0] ?? '');
  }

  /** Locate the scope to receive an array assignment. */
  private resolveArrayTarget(name: string): Environment {
    let cursor: Environment | null = this;
    while (cursor) {
      if (cursor.localNames.has(name)) return cursor;
      if (cursor.arrays.has(name) || cursor.vars.has(name)) return cursor;
      if (cursor.parent === null) return cursor;
      cursor = cursor.parent;
    }
    return this;
  }

  /** Append `values` to `name`'s array (creating it if absent). */
  appendArray(name: string, values: string[]): void {
    const current = this.lookupArray(name) ?? (this.isSet(name) ? [this.get(name) ?? ''] : []);
    this.setArray(name, [...current, ...values]);
  }

  /** Read the full element list (or `undefined` when `name` is not an array). */
  getArray(name: string): string[] | undefined {
    return this.lookupArray(name);
  }

  /**
   * `${arr[idx]}` — return the element at `idx`. Negative indices count
   * from the end (Bash 4.3+). Returns `undefined` when out of range or
   * when `name` is not an array.
   */
  getArrayElement(name: string, idx: number): string | undefined {
    const arr = this.lookupArray(name);
    if (!arr) return undefined;
    const real = idx < 0 ? arr.length + idx : idx;
    if (real < 0 || real >= arr.length) return undefined;
    return arr[real];
  }

  /** `${#arr[@]}` — element count, or 0 when no such array. */
  getArrayLength(name: string): number {
    return this.lookupArray(name)?.length ?? 0;
  }

  // ─── Associative Arrays (declare -A) ──────────────────────────

  /** Walk the parent chain looking for `name` in any assoc slot. */
  private lookupAssoc(name: string): Map<string, string> | undefined {
    if (this.assocArrays.has(name)) return this.assocArrays.get(name);
    return this.parent?.lookupAssoc(name);
  }

  /** Pick the scope that should receive an assoc-array write. */
  private resolveAssocTarget(name: string): Environment {
    let cursor: Environment | null = this;
    while (cursor) {
      if (cursor.localNames.has(name)) return cursor;
      if (cursor.assocArrays.has(name)) return cursor;
      if (cursor.parent === null) return cursor;
      cursor = cursor.parent;
    }
    return this;
  }

  /** Mark `name` as an associative array, creating an empty backing map. */
  declareAssoc(name: string): void {
    const target = this.localNames.has(name) ? this : this.resolveAssocTarget(name);
    if (!target.assocArrays.has(name)) {
      target.assocArrays.set(name, new Map());
    }
  }

  /** True when `name` was declared `-A`. */
  isAssoc(name: string): boolean {
    return this.lookupAssoc(name) !== undefined;
  }

  /** Set `name[key]` = value (auto-declares the map when missing). */
  setAssocElement(name: string, key: string, value: string): void {
    const existing = this.lookupAssoc(name);
    const target = this.localNames.has(name) ? this : this.resolveAssocTarget(name);
    let map = existing;
    if (!map || (this.localNames.has(name) && !target.assocArrays.has(name))) {
      map = new Map();
      target.assocArrays.set(name, map);
    }
    map.set(key, value);
  }

  /** Read `name[key]`, or `undefined` when absent. */
  getAssocElement(name: string, key: string): string | undefined {
    return this.lookupAssoc(name)?.get(key);
  }

  /** Drop `name[key]`. */
  unsetAssocElement(name: string, key: string): void {
    this.lookupAssoc(name)?.delete(key);
  }

  /** Ordered list of values; insertion order matches JS Map iteration. */
  getAssocValues(name: string): string[] {
    const m = this.lookupAssoc(name);
    return m ? [...m.values()] : [];
  }

  /** Keys for `${!name[@]}`. */
  getAssocKeys(name: string): string[] {
    const m = this.lookupAssoc(name);
    return m ? [...m.keys()] : [];
  }

  /** Size for `${#name[@]}`. */
  getAssocSize(name: string): number {
    return this.lookupAssoc(name)?.size ?? 0;
  }

  // ─── Export ───────────────────────────────────────────────────

  /** Mark a variable as exported. */
  export(name: string, value?: string): void {
    if (value !== undefined) this.set(name, value);
    this.exported.add(name);
  }

  /** Remove export attribute from a variable (export -n). */
  unexport(name: string): void {
    this.exported.delete(name);
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
    // Functions / subshells keep the parent shell's $$ and $PPID.
    const child = new Environment({ pid: this.pid, ppid: this.ppid });
    child.parent = this;
    // Inherit PID and script name
    child.vars.set('0', this.get('0') ?? '');
    return child;
  }

  /**
   * Subshell scope — a snapshot of every visible variable from this
   * environment, with NO parent link. Writes inside the subshell stay
   * confined; on disposal the parent shell is unchanged, matching real
   * `(…)` fork-semantics.
   */
  createSubshell(): Environment {
    const sub = new Environment({ pid: this.pid, ppid: this.ppid });
    // Inline the visible variable set rather than chain to `this` so
    // writes against the snapshot never bubble up.
    for (const [k, v] of this.getAll()) sub.vars.set(k, v);
    for (const ex of this.exported) sub.exported.add(ex);
    for (const ro of this.readonlyVars) sub.readonlyVars.add(ro);
    sub.vars.set('0', this.get('0') ?? '');
    return sub;
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
      case 'PPID':
        return this.ppid !== undefined ? String(this.ppid) : undefined;
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
