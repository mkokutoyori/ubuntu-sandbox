import { evaluateArithmeticExpression } from './Arithmetic';
import type { ArithmeticScope } from './Arithmetic';

const SHELL_LOCAL_VARIABLES = new Set([
  'UID', 'EUID', 'PPID', 'HOSTNAME', 'BASH', 'BASH_VERSION', 'BASH_VERSINFO', 'BASH_SUBSHELL',
  'OSTYPE', 'HOSTTYPE', 'MACHTYPE', 'IFS', 'PS1', 'PS2', 'PS4',
  'RANDOM', 'SECONDS', 'LINENO', 'BASHPID', 'GROUPS', 'HISTFILE', 'HISTSIZE',
  'COLUMNS', 'LINES',
]);

const DEFAULT_SHELL_VARIABLES: Readonly<Record<string, string>> = {
  IFS: ' \t\n',
  OSTYPE: 'linux-gnu',
  HOSTTYPE: 'x86_64',
  MACHTYPE: 'x86_64-pc-linux-gnu',
  BASH_VERSION: '5.2.21(1)-release',
};

const BASH_VERSION_INFORMATION = ['5', '2', '21', '1', 'release', 'x86_64-pc-linux-gnu'];

export const SHELL_ONLY_VARIABLES: unique symbol = Symbol('shellOnlyVariables');

export type VariableSeed = Record<string, string> & { [SHELL_ONLY_VARIABLES]?: ReadonlySet<string> };

export function seedWithShellOnly(variables: Record<string, string>, shellOnly: ReadonlySet<string>): VariableSeed {
  const seed: VariableSeed = { ...variables };
  Object.defineProperty(seed, SHELL_ONLY_VARIABLES, { value: shellOnly, enumerable: false });
  return seed;
}

export interface EnvironmentOptions {
  variables?: VariableSeed;
  scriptName?: string;
  positionalArgs?: string[];
  initialExitCode?: number;
  pid?: number;
  ppid?: number;
  dynamicVariables?: Readonly<Record<string, () => string>>;
}

export interface VariableAttributes {
  integer: boolean;
  lowercase: boolean;
  uppercase: boolean;
  capitalize: boolean;
  readonly: boolean;
  exported: boolean;
  trace: boolean;
}

export type VariableKind = 'scalar' | 'indexed' | 'associative';

export interface VariableDescription {
  readonly name: string;
  readonly kind: VariableKind;
  readonly attributes: Readonly<VariableAttributes>;
  readonly nameref: string | undefined;
  readonly value: string | undefined;
  readonly indexed: ReadonlyArray<readonly [number, string]>;
  readonly associative: ReadonlyArray<readonly [string, string]>;
}

interface Variable {
  kind: VariableKind;
  value: string | undefined;
  indexed: Map<number, string>;
  associative: Map<string, string>;
  attributes: VariableAttributes;
  nameref: string | undefined;
}

function freshAttributes(): VariableAttributes {
  return { integer: false, lowercase: false, uppercase: false, capitalize: false, readonly: false, exported: false, trace: false };
}

function freshVariable(kind: VariableKind = 'scalar'): Variable {
  return { kind, value: undefined, indexed: new Map(), associative: new Map(), attributes: freshAttributes(), nameref: undefined };
}

function cloneVariable(source: Variable): Variable {
  return {
    kind: source.kind,
    value: source.value,
    indexed: new Map(source.indexed),
    associative: new Map(source.associative),
    attributes: { ...source.attributes },
    nameref: source.nameref,
  };
}

const READONLY_MESSAGE = (name: string): string => `bash: ${name}: readonly variable`;

export class Environment implements ArithmeticScope {
  private readonly variables = new Map<string, Variable>();
  private readonly traps = new Map<string, string>();
  private parent: Environment | null = null;
  private _lastExitCode = 0;
  private readonly pid: number;
  private readonly ppid: number | undefined;
  private dynamic: Readonly<Record<string, () => string>> = {};
  private positional: string[] | undefined;
  private scriptName = 'bash';
  private backgroundPid = '';

  constructor(options: EnvironmentOptions = {}) {
    this.pid = options.pid ?? Math.floor(Math.random() * 30000) + 1000;
    this.ppid = options.ppid;
    if (options.initialExitCode !== undefined) this._lastExitCode = options.initialExitCode;
    this.dynamic = options.dynamicVariables ?? {};
    for (const [name, value] of Object.entries(DEFAULT_SHELL_VARIABLES)) this.store(name, value, false);
    BASH_VERSION_INFORMATION.forEach((value, index) => this.arrayEntry('BASH_VERSINFO').indexed.set(index, value));
    if (options.variables) {
      const shellOnly = options.variables[SHELL_ONLY_VARIABLES];
      for (const [name, value] of Object.entries(options.variables)) {
        this.store(name, value, !SHELL_LOCAL_VARIABLES.has(name) && shellOnly?.has(name) !== true);
      }
      this.backgroundPid = options.variables['!'] ?? '';
    }
    if (options.scriptName !== undefined) this.scriptName = options.scriptName;
    this.positional = options.positionalArgs ?? [];
  }

  private store(name: string, value: string, exported: boolean): void {
    const variable = this.variables.get(name) ?? freshVariable();
    variable.value = value;
    variable.attributes.exported = exported;
    this.variables.set(name, variable);
  }

  private arrayEntry(name: string): Variable {
    const variable = this.variables.get(name) ?? freshVariable('indexed');
    variable.kind = 'indexed';
    this.variables.set(name, variable);
    return variable;
  }

  private find(name: string): { variable: Variable; scope: Environment } | undefined {
    let cursor: Environment | null = this;
    while (cursor) {
      const variable = cursor.variables.get(name);
      if (variable !== undefined) return { variable, scope: cursor };
      cursor = cursor.parent;
    }
    return undefined;
  }

  private root(): Environment {
    let cursor: Environment = this;
    while (cursor.parent !== null) cursor = cursor.parent;
    return cursor;
  }

  private namerefTarget(name: string): string | undefined {
    return this.find(name)?.variable.nameref;
  }

  resolveName(name: string, depth = 0): string {
    if (depth >= 16) return name;
    const target = this.namerefTarget(name);
    if (target === undefined || target === name) return name;
    return this.resolveName(target, depth + 1);
  }

  declareNameref(name: string, target: string): void {
    const found = this.find(name) ?? { variable: freshVariable(), scope: this.root() };
    found.variable.nameref = target;
    found.scope.variables.set(name, found.variable);
  }

  private positionalList(): string[] {
    let cursor: Environment | null = this;
    while (cursor) {
      if (cursor.positional !== undefined) return cursor.positional;
      cursor = cursor.parent;
    }
    return [];
  }

  private scriptNameValue(): string {
    return this.scriptName;
  }

  get(name: string): string | undefined {
    const special = this.getSpecial(name);
    if (special !== undefined) return special;
    const computed = this.dynamic[name];
    if (computed !== undefined) return computed();
    const resolved = this.resolveName(name);
    const found = this.find(resolved);
    if (found === undefined) return undefined;
    const { variable } = found;
    if (variable.kind === 'indexed') return variable.indexed.get(0);
    if (variable.kind === 'associative') return variable.associative.get('0');
    return variable.value;
  }

  private convert(variable: Variable, value: string): string {
    let result = value;
    if (variable.attributes.integer) result = String(evaluateArithmeticExpression(result, this));
    if (variable.attributes.lowercase) result = result.toLowerCase();
    else if (variable.attributes.uppercase) result = result.toUpperCase();
    else if (variable.attributes.capitalize) result = result.charAt(0).toUpperCase() + result.slice(1).toLowerCase();
    return result;
  }

  private target(name: string): { variable: Variable; scope: Environment } {
    const found = this.find(name);
    if (found !== undefined) return found;
    const root = this.root();
    const variable = freshVariable();
    root.variables.set(name, variable);
    return { variable, scope: root };
  }

  private writable(name: string): { variable: Variable; scope: Environment } {
    const found = this.target(name);
    if (found.variable.attributes.readonly) throw new Error(READONLY_MESSAGE(name));
    return found;
  }

  set(name: string, value: string): void {
    name = this.resolveName(name);
    const { variable } = this.writable(name);
    const converted = this.convert(variable, value);
    if (variable.kind === 'indexed') variable.indexed.set(0, converted);
    else if (variable.kind === 'associative') variable.associative.set('0', converted);
    else variable.value = converted;
  }

  appendScalar(name: string, value: string): void {
    name = this.resolveName(name);
    const { variable } = this.writable(name);
    if (variable.attributes.integer) {
      const current = this.get(name) ?? '0';
      this.set(name, `${current === '' ? '0' : current}+(${value})`);
      return;
    }
    this.set(name, (this.get(name) ?? '') + value);
  }

  declareLocal(name: string): void {
    if (!this.variables.has(name)) this.variables.set(name, freshVariable());
  }

  declare(name: string, kind: VariableKind | undefined, attributes: Partial<VariableAttributes>, local: boolean): void {
    name = this.resolveName(name);
    let scope: Environment;
    if (local) {
      scope = this;
      if (!this.variables.has(name)) {
        const inherited = this.find(name)?.variable;
        if (inherited?.attributes.readonly) throw new Error(READONLY_MESSAGE(name));
        const variable = freshVariable(kind ?? 'scalar');
        if (inherited !== undefined && inherited.attributes.exported && attributes.exported === undefined) variable.attributes.exported = false;
        this.variables.set(name, variable);
      }
    } else {
      scope = this.find(name)?.scope ?? this.root();
      if (!scope.variables.has(name)) scope.variables.set(name, freshVariable(kind ?? 'scalar'));
    }
    const variable = scope.variables.get(name) as Variable;
    if (variable.attributes.readonly && attributes.readonly !== false && Object.keys(attributes).length > 0 && kind !== undefined) {
      throw new Error(READONLY_MESSAGE(name));
    }
    if (kind !== undefined && variable.kind !== kind) {
      if (variable.kind === 'scalar' && variable.value !== undefined) {
        if (kind === 'indexed') variable.indexed.set(0, variable.value);
        else variable.associative.set('0', variable.value);
      }
      variable.kind = kind;
      variable.value = undefined;
    }
    for (const [attribute, on] of Object.entries(attributes) as Array<[keyof VariableAttributes, boolean]>) {
      if (attribute === 'readonly' && !on && variable.attributes.readonly) continue;
      if (attribute === 'lowercase' && on) variable.attributes.uppercase = false;
      if (attribute === 'uppercase' && on) variable.attributes.lowercase = false;
      variable.attributes[attribute] = on;
    }
  }

  describe(name: string): VariableDescription | undefined {
    const found = this.find(name);
    if (found === undefined) return undefined;
    const { variable } = found;
    return {
      name,
      kind: variable.kind,
      attributes: variable.attributes,
      nameref: variable.nameref,
      value: variable.value,
      indexed: [...variable.indexed.entries()].sort((a, b) => a[0] - b[0]),
      associative: [...variable.associative.entries()],
    };
  }

  visibleNames(): string[] {
    const names = new Set<string>();
    let cursor: Environment | null = this;
    while (cursor) {
      for (const name of cursor.variables.keys()) names.add(name);
      cursor = cursor.parent;
    }
    return [...names].sort();
  }

  namesWithPrefix(prefix: string): string[] {
    return this.visibleNames().filter((name) => name.startsWith(prefix) && /^[A-Za-z_][A-Za-z_0-9]*$/.test(name) && this.isSet(name));
  }

  getParent(): Environment | null { return this.parent; }
  setTrap(signal: string, body: string): void { this.traps.set(signal, body); }
  clearTrap(signal: string): void { this.traps.delete(signal); }
  getTrap(signal: string): string | undefined { return this.traps.get(signal); }
  listTraps(): Array<[string, string]> { return [...this.traps.entries()]; }

  setReadonly(name: string, value?: string): void {
    if (value !== undefined) this.set(name, value);
    this.declare(name, undefined, { readonly: true }, false);
  }

  isReadonly(name: string): boolean {
    return this.find(this.resolveName(name))?.variable.attributes.readonly === true;
  }

  unset(name: string): void {
    name = this.resolveName(name);
    const found = this.find(name);
    if (found === undefined) return;
    if (found.variable.attributes.readonly) throw new Error(`bash: unset: ${name}: cannot unset: readonly variable`);
    found.scope.variables.delete(name);
  }

  withdrawScalar(name: string): void {
    name = this.resolveName(name);
    const found = this.find(name);
    if (found === undefined) return;
    if (found.variable.kind === 'scalar') found.scope.variables.delete(name);
  }

  isSet(name: string): boolean {
    if (this.get(name) !== undefined) return true;
    const found = this.find(this.resolveName(name));
    return found !== undefined && (found.variable.indexed.size > 0 || found.variable.associative.size > 0);
  }

  // ─── Indexed arrays ───────────────────────────────────────────

  getArray(name: string): string[] | undefined {
    const found = this.find(this.resolveName(name));
    if (found === undefined || found.variable.kind !== 'indexed') return undefined;
    return [...found.variable.indexed.entries()].sort((a, b) => a[0] - b[0]).map((entry) => entry[1]);
  }

  getArrayIndices(name: string): number[] {
    const found = this.find(this.resolveName(name));
    if (found === undefined || found.variable.kind !== 'indexed') return [];
    return [...found.variable.indexed.keys()].sort((a, b) => a - b);
  }

  setArray(name: string, values: string[]): void {
    name = this.resolveName(name);
    const { variable } = this.writable(name);
    variable.kind = 'indexed';
    variable.value = undefined;
    variable.indexed = new Map(values.map((value, index) => [index, this.convert(variable, value)]));
  }

  appendArray(name: string, values: string[]): void {
    name = this.resolveName(name);
    const { variable } = this.writable(name);
    if (variable.kind === 'scalar') {
      if (variable.value !== undefined) variable.indexed.set(0, variable.value);
      variable.kind = 'indexed';
      variable.value = undefined;
    }
    const indices = [...variable.indexed.keys()];
    let next = indices.length === 0 ? 0 : Math.max(...indices) + 1;
    for (const value of values) variable.indexed.set(next++, this.convert(variable, value));
  }

  setArrayElement(name: string, index: number, value: string): void {
    name = this.resolveName(name);
    const { variable } = this.writable(name);
    if (variable.kind === 'scalar') {
      if (variable.value !== undefined) variable.indexed.set(0, variable.value);
      variable.kind = 'indexed';
      variable.value = undefined;
    }
    const position = index < 0 ? this.nextIndex(variable) + index : index;
    if (position < 0) throw new Error(`bash: ${name}[${index}]: bad array subscript`);
    variable.indexed.set(position, this.convert(variable, value));
  }

  private nextIndex(variable: Variable): number {
    const indices = [...variable.indexed.keys()];
    return indices.length === 0 ? 0 : Math.max(...indices) + 1;
  }

  unsetArrayElement(name: string, index: number): void {
    const found = this.find(this.resolveName(name));
    if (found === undefined) return;
    if (found.variable.attributes.readonly) throw new Error(`bash: unset: ${name}: cannot unset: readonly variable`);
    const position = index < 0 ? this.nextIndex(found.variable) + index : index;
    found.variable.indexed.delete(position);
  }

  getArrayElement(name: string, idx: number): string | undefined {
    const found = this.find(this.resolveName(name));
    if (found === undefined || found.variable.kind !== 'indexed') return undefined;
    const position = idx < 0 ? this.nextIndex(found.variable) + idx : idx;
    return found.variable.indexed.get(position);
  }

  getArrayLength(name: string): number {
    const found = this.find(this.resolveName(name));
    return found !== undefined && found.variable.kind === 'indexed' ? found.variable.indexed.size : 0;
  }

  // ─── Associative arrays ───────────────────────────────────────

  declareAssoc(name: string): void {
    this.declare(name, 'associative', {}, false);
  }

  isAssoc(name: string): boolean {
    return this.find(this.resolveName(name))?.variable.kind === 'associative';
  }

  setAssocElement(name: string, key: string, value: string): void {
    name = this.resolveName(name);
    const { variable } = this.writable(name);
    if (variable.kind !== 'associative') {
      if (variable.kind === 'scalar' && variable.value !== undefined) variable.associative.set('0', variable.value);
      variable.kind = 'associative';
      variable.value = undefined;
    }
    variable.associative.set(key, this.convert(variable, value));
  }

  getAssocElement(name: string, key: string): string | undefined {
    const found = this.find(this.resolveName(name));
    return found?.variable.kind === 'associative' ? found.variable.associative.get(key) : undefined;
  }

  unsetAssocElement(name: string, key: string): void {
    const found = this.find(this.resolveName(name));
    if (found?.variable.kind === 'associative') found.variable.associative.delete(key);
  }

  clearAssoc(name: string): void {
    const found = this.find(this.resolveName(name));
    if (found?.variable.kind === 'associative') found.variable.associative.clear();
  }

  getAssocValues(name: string): string[] {
    const found = this.find(this.resolveName(name));
    return found?.variable.kind === 'associative' ? [...found.variable.associative.values()] : [];
  }

  getAssocKeys(name: string): string[] {
    const found = this.find(this.resolveName(name));
    return found?.variable.kind === 'associative' ? [...found.variable.associative.keys()] : [];
  }

  getAssocSize(name: string): number {
    const found = this.find(this.resolveName(name));
    return found?.variable.kind === 'associative' ? found.variable.associative.size : 0;
  }

  // ─── Export ───────────────────────────────────────────────────

  export(name: string, value?: string): void {
    if (value !== undefined) this.set(name, value);
    this.declare(name, undefined, { exported: true }, false);
  }

  unexport(name: string): void {
    const found = this.find(this.resolveName(name));
    if (found !== undefined) found.variable.attributes.exported = false;
  }

  getExported(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const name of this.visibleNames()) {
      const found = this.find(name);
      if (found === undefined || !found.variable.attributes.exported) continue;
      const value = this.get(name);
      if (value !== undefined) result[name] = value;
    }
    return result;
  }

  // ─── Positional parameters ────────────────────────────────────

  setPositionalArgs(args: string[]): void {
    this.positional = [...args];
  }

  getPositionalArgs(): string[] {
    return [...this.positionalList()];
  }

  // ─── Scope management ─────────────────────────────────────────

  createChild(): Environment {
    const child = new Environment({ pid: this.pid, ppid: this.ppid, initialExitCode: this.lastExitCode, dynamicVariables: this.dynamic });
    child.variables.clear();
    child.parent = this;
    child.positional = undefined;
    child.scriptName = this.scriptName;
    return child;
  }

  createSubshell(): Environment {
    const sub = new Environment({ pid: this.pid, ppid: this.ppid, initialExitCode: this.lastExitCode, dynamicVariables: this.dynamic });
    sub.variables.clear();
    for (const name of this.visibleNames()) {
      const found = this.find(name);
      if (found !== undefined) sub.variables.set(name, cloneVariable(found.variable));
    }
    sub.positional = [...this.positionalList()];
    sub.scriptName = this.scriptName;
    return sub;
  }

  get lastExitCode(): number { return this._lastExitCode; }
  set lastExitCode(code: number) { this._lastExitCode = code; }

  recordBackgroundPid(pid: string): void {
    this.backgroundPid = pid;
  }

  private getSpecial(name: string): string | undefined {
    switch (name) {
      case '?': return String(this._lastExitCode);
      case '$': return String(this.pid);
      case '!': return this.backgroundPid;
      case '#': return String(this.positionalList().length);
      case '0': return this.scriptNameValue();
      case '@':
      case '*': return this.positionalList().join(' ');
      case 'PPID': return this.ppid !== undefined ? String(this.ppid) : undefined;
      default:
        if (/^[1-9][0-9]*$/.test(name)) return this.positionalList()[Number(name) - 1];
        return undefined;
    }
  }

  getAll(): Map<string, string> {
    const result = new Map<string, string>();
    for (const name of this.visibleNames()) {
      const value = this.get(name);
      if (value !== undefined) result.set(name, value);
    }
    return result;
  }
}
