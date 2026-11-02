import { DEFAULT_NEIGHBOR_PARAMETERS, type NeighborParameters } from '../host/NeighborCache';
import { DeviceConfScopes, type DeviceConfKnob } from './DeviceConfScopes';

export const IPV6_NEIGHBOR_CONF_KNOBS: readonly DeviceConfKnob[] = [
  { name: 'base_reachable_time_ms', initial: DEFAULT_NEIGHBOR_PARAMETERS.reachableTimeMs },
  { name: 'retrans_time_ms', initial: DEFAULT_NEIGHBOR_PARAMETERS.retransTimerMs },
];

const LOWEST_ADVERTISED_MS = 1;

export class Ipv6NeighborConf extends DeviceConfScopes {
  constructor(interfaces: readonly string[]) {
    super(interfaces, IPV6_NEIGHBOR_CONF_KNOBS);
  }

  protected defaultReachesExistingInterfaces(): boolean {
    return false;
  }

  parameters(iface: string): NeighborParameters {
    return {
      reachableTimeMs: this.scoped(iface, 'base_reachable_time_ms'),
      retransTimerMs: this.scoped(iface, 'retrans_time_ms'),
    };
  }

  adoptAdvertised(iface: string, reachableTimeMs: number, retransTimerMs: number): void {
    if (reachableTimeMs >= LOWEST_ADVERTISED_MS) this.setSilently(iface, 'base_reachable_time_ms', reachableTimeMs);
    if (retransTimerMs >= LOWEST_ADVERTISED_MS) this.setSilently(iface, 'retrans_time_ms', retransTimerMs);
  }
}
