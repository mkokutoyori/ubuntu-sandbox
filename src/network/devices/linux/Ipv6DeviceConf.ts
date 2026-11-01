import type { Ipv6AddrconfPolicy } from '@/network/hardware/Ipv6Addrconf';
import { ALL_SCOPE, DEFAULT_SCOPE, DeviceConfScopes, type DeviceConfKnob } from './DeviceConfScopes';

export const IPV6_DEVICE_CONF_KNOBS: readonly DeviceConfKnob[] = [
  { name: 'forwarding', initial: 0 },
  { name: 'accept_ra', initial: 1 },
  { name: 'accept_ra_defrtr', initial: 1 },
  { name: 'accept_ra_pinfo', initial: 1 },
  { name: 'autoconf', initial: 1 },
  { name: 'disable_ipv6', initial: 0 },
  { name: 'use_tempaddr', initial: 2 },
  { name: 'temp_valid_lft', initial: 604800 },
  { name: 'temp_prefered_lft', initial: 86400 },
  { name: 'max_desync_factor', initial: 600 },
  { name: 'regen_max_retry', initial: 3 },
  { name: 'dad_transmits', initial: 1 },
  { name: 'max_addresses', initial: 16 },
];

const LOOPBACK = 'lo';
const DISABLED_PRIVACY = -1;

const WRITTEN_ON_ALL_REACH_EVERY_INTERFACE: ReadonlySet<string> = new Set(['disable_ipv6', 'forwarding']);

export class Ipv6DeviceConf extends DeviceConfScopes {
  constructor(interfaces: readonly string[]) {
    super(interfaces, IPV6_DEVICE_CONF_KNOBS);
  }

  protected defaultReachesExistingInterfaces(): boolean {
    return false;
  }

  override addInterface(name: string): boolean {
    if (!super.addInterface(name)) return false;
    if (name === LOOPBACK) this.setSilently(name, 'use_tempaddr', DISABLED_PRIVACY);
    return true;
  }

  addrconfPolicy(iface: string): Ipv6AddrconfPolicy {
    return {
      useTempaddr: this.scoped(iface, 'use_tempaddr'),
      tempValidLft: this.scoped(iface, 'temp_valid_lft'),
      tempPreferedLft: this.scoped(iface, 'temp_prefered_lft'),
      maxDesyncFactor: this.scoped(iface, 'max_desync_factor'),
      regenMaxRetry: this.scoped(iface, 'regen_max_retry'),
      dadTransmits: this.scoped(iface, 'dad_transmits'),
      maxAddresses: this.scoped(iface, 'max_addresses'),
    };
  }

  override set(scope: string, knob: string, value: number): boolean {
    if (!super.set(scope, knob, value)) return false;
    if (scope === ALL_SCOPE && WRITTEN_ON_ALL_REACH_EVERY_INTERFACE.has(knob)) {
      this.setSilently(DEFAULT_SCOPE, knob, value);
      for (const name of this.interfaceNames()) this.setSilently(name, knob, value);
    }
    return true;
  }

  disabled(iface: string): boolean {
    return this.scoped(iface, 'disable_ipv6') !== 0;
  }

  forwards(iface: string): boolean {
    return this.scoped(iface, 'forwarding') !== 0;
  }

  acceptsRouterAdvertisements(iface: string): boolean {
    const mode = this.scoped(iface, 'accept_ra');
    return this.forwards(iface) ? mode === 2 : mode !== 0;
  }

  learnsDefaultRouter(iface: string): boolean {
    return this.scoped(iface, 'accept_ra_defrtr') !== 0;
  }

  readsPrefixInformation(iface: string): boolean {
    return this.scoped(iface, 'accept_ra_pinfo') !== 0;
  }

  autoconfigures(iface: string): boolean {
    return this.scoped(iface, 'autoconf') !== 0;
  }
}
