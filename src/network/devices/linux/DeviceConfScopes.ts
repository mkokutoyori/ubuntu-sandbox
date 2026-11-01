export const ALL_SCOPE = 'all';
export const DEFAULT_SCOPE = 'default';

export interface DeviceConfKnob {
  readonly name: string;
  readonly initial: number;
}

interface DeviceScope {
  readonly values: Map<string, number>;
  readonly written: Set<string>;
}

export abstract class DeviceConfScopes {
  private readonly everywhere: DeviceScope;
  private readonly defaults: DeviceScope;
  private readonly table: Map<string, DeviceScope>;

  protected constructor(interfaces: readonly string[], private readonly knobs: readonly DeviceConfKnob[]) {
    this.everywhere = this.newScope();
    this.defaults = this.newScope();
    this.table = new Map<string, DeviceScope>([[ALL_SCOPE, this.everywhere], [DEFAULT_SCOPE, this.defaults]]);
    for (const name of interfaces) this.addInterface(name);
  }

  protected abstract defaultReachesExistingInterfaces(): boolean;

  scopes(): string[] {
    return [...this.table.keys()];
  }

  interfaceNames(): string[] {
    return this.scopes().filter((scope) => scope !== ALL_SCOPE && scope !== DEFAULT_SCOPE);
  }

  addInterface(name: string): boolean {
    if (this.table.has(name)) return false;
    this.table.set(name, { values: new Map(this.defaults.values), written: new Set() });
    return true;
  }

  removeInterface(name: string): boolean {
    return name !== ALL_SCOPE && name !== DEFAULT_SCOPE && this.table.delete(name);
  }

  has(scope: string, knob: string): boolean {
    return this.table.get(scope)?.values.has(knob) ?? false;
  }

  get(scope: string, knob: string): number {
    return this.table.get(scope)?.values.get(knob) ?? 0;
  }

  set(scope: string, knob: string, value: number): boolean {
    const scoped = this.table.get(scope);
    if (scoped === undefined || !scoped.values.has(knob)) return false;
    scoped.values.set(knob, value);
    if (scope === DEFAULT_SCOPE) {
      if (this.defaultReachesExistingInterfaces()) this.propagateDefault(knob, value);
    } else {
      scoped.written.add(knob);
    }
    return true;
  }

  write(scope: string, knob: string, text: string): boolean {
    const value = text.trim();
    return /^-?\d+$/.test(value) && this.set(scope, knob, Number(value));
  }

  protected scoped(iface: string, knob: string): number {
    return this.table.get(iface)?.values.get(knob) ?? this.get(DEFAULT_SCOPE, knob);
  }

  protected setSilently(scope: string, knob: string, value: number): void {
    this.table.get(scope)?.values.set(knob, value);
  }

  private propagateDefault(knob: string, value: number): void {
    for (const [scope, scoped] of this.table) {
      if (scope === ALL_SCOPE || scope === DEFAULT_SCOPE) continue;
      if (!scoped.written.has(knob)) scoped.values.set(knob, value);
    }
  }

  private newScope(): DeviceScope {
    return { values: new Map(this.knobs.map((knob) => [knob.name, knob.initial])), written: new Set() };
  }
}
