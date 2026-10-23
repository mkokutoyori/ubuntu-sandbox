import { IPAddress } from '@/network/core/types';

export const LINK_LOCAL_PROBE_NUM = 3;
export const LINK_LOCAL_ANNOUNCE_NUM = 2;
export const LINK_LOCAL_ANNOUNCE_INTERVAL_MS = 2000;
export const LINK_LOCAL_MAX_CONFLICTS = 10;
export const LINK_LOCAL_RATE_LIMIT_INTERVAL_MS = 60000;
export const LINK_LOCAL_DEFEND_INTERVAL_MS = 10000;

const FIRST_THIRD_OCTET = 1;
const THIRD_OCTET_SPAN = 254;
const FOURTH_OCTET_SPAN = 256;

export class LinkLocalCandidates {
  private state: number;
  private issued = 0;

  constructor(private readonly mac: string) {
    this.state = LinkLocalCandidates.seed(mac);
  }

  private static seed(mac: string): number {
    let hash = 0x811c9dc5;
    for (const byte of mac.split(':')) {
      hash = Math.imul(hash ^ (parseInt(byte, 16) || 0), 0x01000193) >>> 0;
    }
    return hash === 0 ? 0x9e3779b9 : hash;
  }

  private nextRandom(): number {
    let x = this.state;
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    this.state = x;
    return x;
  }

  next(): IPAddress {
    if (this.issued++ === 0) return this.stableFirst();
    const index = this.nextRandom() % (THIRD_OCTET_SPAN * FOURTH_OCTET_SPAN);
    return new IPAddress([169, 254, FIRST_THIRD_OCTET + Math.floor(index / FOURTH_OCTET_SPAN), index % FOURTH_OCTET_SPAN]);
  }

  private stableFirst(): IPAddress {
    const parts = this.mac.split(':');
    const third = (parseInt(parts[4] || '01', 16) % THIRD_OCTET_SPAN) + FIRST_THIRD_OCTET;
    const fourth = parseInt(parts[5] || '02', 16);
    return new IPAddress([169, 254, third, fourth]);
  }
}
