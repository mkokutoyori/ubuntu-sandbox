import {
  IPV6_REASSEMBLY_HIGH_THRESHOLD_BYTES, IPV6_REASSEMBLY_LOW_THRESHOLD_BYTES, IPV6_REASSEMBLY_TIMEOUT_MS,
} from '@/network/layers/internet/Ipv6Fragmentation';
import { KernelKnobStore, type KernelByteKnob } from './LinuxIpv4Settings';

export const LINUX_IPV6_KNOBS: readonly KernelByteKnob[] = [
  {
    name: 'ip6frag_high_thresh', initial: IPV6_REASSEMBLY_HIGH_THRESHOLD_BYTES,
    minimum: 0, maximum: Number.MAX_SAFE_INTEGER, minimumFrom: 'ip6frag_low_thresh',
  },
  {
    name: 'ip6frag_low_thresh', initial: IPV6_REASSEMBLY_LOW_THRESHOLD_BYTES,
    minimum: 0, maximum: Number.MAX_SAFE_INTEGER, maximumFrom: 'ip6frag_high_thresh',
  },
  { name: 'ip6frag_time', initial: IPV6_REASSEMBLY_TIMEOUT_MS / 1000, minimum: 0, maximum: 2_147_483_647 },
];

export class LinuxIpv6Settings extends KernelKnobStore {
  constructor() {
    super(LINUX_IPV6_KNOBS);
  }

  get fragmentTimeoutMs(): number {
    return this.get('ip6frag_time') * 1000;
  }

  get fragmentHighThresholdBytes(): number {
    return this.get('ip6frag_high_thresh');
  }
}
