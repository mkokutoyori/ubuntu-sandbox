import type { RedirectPolicy } from '@/network/layers/internet/IcmpRedirect';

export const ALL_SCOPE = 'all';
export const DEFAULT_SCOPE = 'default';

export interface DeviceConfKnob {
  readonly name: string;
  readonly initial: number;
}

export const IPV4_DEVICE_CONF_KNOBS: readonly DeviceConfKnob[] = [
  { name: 'accept_redirects', initial: 1 },
  { name: 'send_redirects', initial: 1 },
  { name: 'secure_redirects', initial: 1 },
  { name: 'shared_media', initial: 1 },
  { name: 'arp_ignore', initial: 0 },
  { name: 'arp_accept', initial: 0 },
  { name: 'arp_notify', initial: 0 },
  { name: 'rp_filter', initial: 2 },
];

interface DeviceScope {
  readonly values: Map<string, number>;
  readonly written: Set<string>;
}

export class Ipv4DeviceConf implements RedirectPolicy {
  private readonly everywhere = this.newScope();
  private readonly defaults = this.newScope();
  private readonly table = new Map<string, DeviceScope>([[ALL_SCOPE, this.everywhere], [DEFAULT_SCOPE, this.defaults]]);

  constructor(interfaces: readonly string[]) {
    for (const name of interfaces) this.addInterface(name);
  }

  scopes(): string[] {
    return [...this.table.keys()];
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
    if (scope === DEFAULT_SCOPE) this.propagateDefault(knob, value);
    else scoped.written.add(knob);
    return true;
  }

  write(scope: string, knob: string, text: string): boolean {
    const value = text.trim();
    return /^-?\d+$/.test(value) && this.set(scope, knob, Number(value));
  }

  forwardingChanged(enabled: boolean): void {
    this.everywhere.values.set('accept_redirects', enabled ? 0 : 1);
  }

  sends(iface: string): boolean {
    return this.either(iface, 'send_redirects');
  }

  maximum(iface: string, knob: string): number {
    return Math.max(this.get(ALL_SCOPE, knob), this.scoped(iface, knob));
  }

  sharesMedia(iface: string): boolean {
    return this.either(iface, 'shared_media');
  }

  trustsOnlyListedGateways(iface: string): boolean {
    return this.either(iface, 'secure_redirects');
  }

  accepts(iface: string, forwarding: boolean): boolean {
    return forwarding
      ? this.get(ALL_SCOPE, 'accept_redirects') !== 0 && this.scoped(iface, 'accept_redirects') !== 0
      : this.either(iface, 'accept_redirects');
  }

  private either(iface: string, knob: string): boolean {
    return this.get(ALL_SCOPE, knob) !== 0 || this.scoped(iface, knob) !== 0;
  }

  private scoped(iface: string, knob: string): number {
    return this.table.get(iface)?.values.get(knob) ?? this.get(DEFAULT_SCOPE, knob);
  }

  private propagateDefault(knob: string, value: number): void {
    for (const [scope, scoped] of this.table) {
      if (scope === ALL_SCOPE || scope === DEFAULT_SCOPE) continue;
      if (!scoped.written.has(knob)) scoped.values.set(knob, value);
    }
  }

  private newScope(): DeviceScope {
    return { values: new Map(IPV4_DEVICE_CONF_KNOBS.map((knob) => [knob.name, knob.initial])), written: new Set() };
  }
}
