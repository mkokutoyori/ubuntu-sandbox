export interface Footprint {
  readonly vsize: number;
  readonly rss: number;
  readonly text?: number;
  readonly pss?: number;
  readonly uss?: number;
  readonly minorFaults?: number;
  readonly readChars?: number;
}

const MEASURED: Readonly<Record<string, Footprint>> = {
  bash: { vsize: 4336, rss: 3400, text: 952, pss: 800, uss: 330, minorFaults: 190, readChars: 13998 },
  sleep: { vsize: 2708, rss: 1670, text: 13, pss: 185, uss: 96, minorFaults: 110, readChars: 4092 },
  nc: { vsize: 3444, rss: 1788, text: 18, pss: 387, uss: 312, minorFaults: 92, readChars: 6588 },
  ps: { vsize: 7908, rss: 4076, text: 63, minorFaults: 413 },
};

export const DEFAULT_FOOTPRINT: Footprint = { vsize: 10240, rss: 4096 };

export function measuredFootprintOf(comm: string): Footprint | undefined {
  return MEASURED[comm.replace(/^-/, '')];
}

export function footprintOf(comm: string): Footprint {
  return measuredFootprintOf(comm) ?? DEFAULT_FOOTPRINT;
}
