import type { RedirectPolicy } from '@/network/layers/internet/IcmpRedirect';
import { ALL_SCOPE, DEFAULT_SCOPE, DeviceConfScopes, type DeviceConfKnob } from './DeviceConfScopes';

export { ALL_SCOPE, DEFAULT_SCOPE, type DeviceConfKnob };

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

export class Ipv4DeviceConf extends DeviceConfScopes implements RedirectPolicy {
  constructor(interfaces: readonly string[]) {
    super(interfaces, IPV4_DEVICE_CONF_KNOBS);
  }

  protected defaultReachesExistingInterfaces(): boolean {
    return true;
  }

  forwardingChanged(enabled: boolean): void {
    this.setSilently(ALL_SCOPE, 'accept_redirects', enabled ? 0 : 1);
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
}
