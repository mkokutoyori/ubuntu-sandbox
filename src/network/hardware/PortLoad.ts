export const DEFAULT_LOAD_INTERVAL_SEC = 300;
export const LOAD_SAMPLE_PERIOD_SEC = 5;

export interface LoadRates {
  intervalSec: number;
  inBitsPerSec: number;
  inPacketsPerSec: number;
  outBitsPerSec: number;
  outPacketsPerSec: number;
}

interface Sample {
  atMs: number;
  bytesIn: number;
  framesIn: number;
  bytesOut: number;
  framesOut: number;
}

export class PortLoad {
  private intervalSec = DEFAULT_LOAD_INTERVAL_SEC;
  private last: Sample | null = null;
  private inBps = 0;
  private inPps = 0;
  private outBps = 0;
  private outPps = 0;

  setIntervalSec(sec: number): boolean {
    if (!Number.isInteger(sec) || sec < 30 || sec > 600 || sec % 30 !== 0) return false;
    this.intervalSec = sec;
    return true;
  }

  getIntervalSec(): number { return this.intervalSec; }

  reset(): void {
    this.last = null;
    this.inBps = this.inPps = this.outBps = this.outPps = 0;
  }

  sample(nowMs: number, counters: Omit<Sample, 'atMs'>): void {
    const previous = this.last;
    this.last = { atMs: nowMs, ...counters };
    if (!previous) return;
    const elapsedSec = (nowMs - previous.atMs) / 1000;
    if (elapsedSec < LOAD_SAMPLE_PERIOD_SEC) { this.last = previous; return; }
    const decay = Math.exp(-elapsedSec / this.intervalSec);
    const perSec = (delta: number) => delta / elapsedSec;
    this.inBps = this.blend(this.inBps, perSec((counters.bytesIn - previous.bytesIn) * 8), decay);
    this.inPps = this.blend(this.inPps, perSec(counters.framesIn - previous.framesIn), decay);
    this.outBps = this.blend(this.outBps, perSec((counters.bytesOut - previous.bytesOut) * 8), decay);
    this.outPps = this.blend(this.outPps, perSec(counters.framesOut - previous.framesOut), decay);
  }

  private blend(average: number, instant: number, decay: number): number {
    return average * decay + instant * (1 - decay);
  }

  rates(): LoadRates {
    return {
      intervalSec: this.intervalSec,
      inBitsPerSec: Math.round(this.inBps),
      inPacketsPerSec: Math.round(this.inPps),
      outBitsPerSec: Math.round(this.outBps),
      outPacketsPerSec: Math.round(this.outPps),
    };
  }
}

/** How IOS names the load interval in `show interfaces`. */
export function loadIntervalLabel(sec: number): string {
  if (sec % 60 === 0) return `${sec / 60} minute`;
  return `${sec} second`;
}
