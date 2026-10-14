import { CarPolicer, type CarRule } from '../../../qos/CarPolicer';

export type ShaperBand = 'guaranteed' | 'exceed' | 'maximum' | 'dropped';
export type BandwidthUnit = 'kbps' | 'mbps' | 'gbps';

export interface TrafficShaper {
  readonly name: string;
  readonly unit: BandwidthUnit;
  readonly guaranteed: number;
  readonly exceed: number;
  readonly maximum: number;
  readonly overheadBytes: number;
  readonly perPolicy: boolean;
  readonly diffserv?: number;
  readonly multiStageDscp?: { guaranteedExceed?: number; exceedMaximum?: number };
}

const UNIT_BITS: Readonly<Record<BandwidthUnit, number>> = { kbps: 1_000, mbps: 1_000_000, gbps: 1_000_000_000 };

export function bitsPerSecond(amount: number, unit: BandwidthUnit): number {
  return amount * UNIT_BITS[unit];
}

function bucket(bps: number, now: number): CarPolicer {
  const policer = new CarPolicer();
  const burst = Math.max(1, Math.round(bps / 8 / 8));
  const rule: CarRule = {
    direction: 'input', bitsPerSecond: bps, normalBurstBytes: burst, maxBurstBytes: burst * 2,
    conformAction: 'transmit', exceedAction: 'drop', raw: '',
    tokens: burst, lastRefillMs: now,
    conformedPackets: 0, conformedBytes: 0, exceededPackets: 0, exceededBytes: 0, lastPacketMs: null,
  };
  policer.add(rule);
  return policer;
}

interface Meters {
  readonly guaranteed?: CarPolicer;
  readonly exceed?: CarPolicer;
  readonly maximum?: CarPolicer;
}

export class ShaperMeter {
  private readonly meters = new Map<string, Meters>();
  readonly bandBytes: Record<ShaperBand, number> = { guaranteed: 0, exceed: 0, maximum: 0, dropped: 0 };

  constructor(private readonly shaper: TrafficShaper) {}

  measure(key: string, bytes: number, now: number): ShaperBand {
    const shaper = this.shaper;
    const meters = this.metersFor(shaper.perPolicy ? key : '*', now);
    const size = bytes + shaper.overheadBytes;
    const band = this.classify(meters, size, now);
    this.bandBytes[band] += size;
    return band;
  }

  private classify(meters: Meters, size: number, now: number): ShaperBand {
    if (meters.maximum && !meters.maximum.police('input', size, now)) return 'dropped';
    if (meters.guaranteed?.police('input', size, now)) return 'guaranteed';
    if (meters.exceed?.police('input', size, now)) return 'exceed';
    return 'maximum';
  }

  private metersFor(key: string, now: number): Meters {
    const known = this.meters.get(key);
    if (known) return known;
    const shaper = this.shaper;
    const rate = (amount: number): CarPolicer | undefined =>
      amount > 0 ? bucket(bitsPerSecond(amount, shaper.unit), now) : undefined;
    const created: Meters = {
      guaranteed: rate(shaper.guaranteed), exceed: rate(shaper.exceed), maximum: rate(shaper.maximum),
    };
    this.meters.set(key, created);
    return created;
  }
}

export interface PerIpShaper {
  readonly name: string;
  readonly unit: BandwidthUnit;
  readonly maximum: number;
  readonly forwardDscp?: number;
  readonly reverseDscp?: number;
  readonly maxSessions: number;
  readonly maxTcpSessions: number;
  readonly maxUdpSessions: number;
}

export class ShaperStore {
  private readonly shapers = new Map<string, TrafficShaper>();
  private readonly meters = new Map<string, ShaperMeter>();
  private readonly perIp = new Map<string, { shaper: PerIpShaper; meter: ShaperMeter }>();

  upsertPerIp(shaper: PerIpShaper): void {
    const meter = new ShaperMeter({
      name: shaper.name, unit: shaper.unit, guaranteed: 0, exceed: 0, maximum: shaper.maximum,
      overheadBytes: 0, perPolicy: true,
    });
    this.perIp.set(shaper.name, { shaper, meter });
  }

  removePerIp(name: string): void { this.perIp.delete(name); }

  perIpShaper(name: string): { shaper: PerIpShaper; meter: ShaperMeter } | undefined {
    return this.perIp.get(name);
  }

  upsert(shaper: TrafficShaper): void {
    this.shapers.set(shaper.name, shaper);
    this.meters.set(shaper.name, new ShaperMeter(shaper));
  }

  remove(name: string): void {
    this.shapers.delete(name);
    this.meters.delete(name);
  }

  get(name: string): TrafficShaper | undefined { return this.shapers.get(name); }

  meterOf(name: string): ShaperMeter | undefined { return this.meters.get(name); }

  names(): readonly string[] { return [...this.shapers.keys()]; }
}
