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
];

export class Ipv4DeviceConf implements RedirectPolicy {
  private readonly values = new Map<string, Map<string, number>>();
  private readonly written = new Map<string, Set<string>>();

  constructor(interfaces: readonly string[]) {
    this.values.set(ALL_SCOPE, this.initialValues());
    this.values.set(DEFAULT_SCOPE, this.initialValues());
    for (const name of interfaces) this.addInterface(name);
  }

  scopes(): string[] {
    return [...this.values.keys()];
  }

  addInterface(name: string): void {
    if (this.values.has(name)) return;
    this.values.set(name, new Map(this.values.get(DEFAULT_SCOPE)));
    this.written.set(name, new Set());
  }

  has(scope: string, knob: string): boolean {
    return this.values.get(scope)?.has(knob) ?? false;
  }

  get(scope: string, knob: string): number {
    return this.values.get(scope)?.get(knob) ?? 0;
  }

  set(scope: string, knob: string, value: number): boolean {
    const scoped = this.values.get(scope);
    if (scoped === undefined || !scoped.has(knob)) return false;
    scoped.set(knob, value);
    if (scope === DEFAULT_SCOPE) this.propagateDefault(knob, value);
    else if (scope !== ALL_SCOPE) this.written.get(scope)?.add(knob);
    return true;
  }

  write(scope: string, knob: string, text: string): boolean {
    const value = text.trim();
    return /^-?\d+$/.test(value) && this.set(scope, knob, Number(value));
  }

  forwardingChanged(enabled: boolean): void {
    this.values.get(ALL_SCOPE)?.set('accept_redirects', enabled ? 0 : 1);
  }

  sends(iface: string): boolean {
    return this.either(iface, 'send_redirects');
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
    return this.values.get(iface)?.get(knob) ?? this.get(DEFAULT_SCOPE, knob);
  }

  private propagateDefault(knob: string, value: number): void {
    for (const [scope, scoped] of this.values) {
      if (scope === ALL_SCOPE || scope === DEFAULT_SCOPE) continue;
      if (!this.written.get(scope)?.has(knob)) scoped.set(knob, value);
    }
  }

  private initialValues(): Map<string, number> {
    return new Map(IPV4_DEVICE_CONF_KNOBS.map((knob) => [knob.name, knob.initial]));
  }
}
