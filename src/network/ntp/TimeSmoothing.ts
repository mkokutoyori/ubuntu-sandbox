const STAGE_COUNT = 3;
const UNLOCK_SKEW_WANDER_RATIO = 10000;

interface Stage { wander: number; length: number }

export interface SmoothingReport {
  readonly active: boolean;
  readonly leapOnly: boolean;
  readonly offset: number;
  readonly frequencyPpm: number;
  readonly wanderPpm: number;
  readonly lastUpdateAgo: number;
  readonly remainingTime: number;
}

export class TimeSmoothing {
  private readonly stages: Stage[] = Array.from({ length: STAGE_COUNT }, () => ({ wander: 0, length: 0 }));
  private locked = true;
  private frequency = 0;
  private offset = 0;
  private lastUpdate = 0;
  private readonly maxFrequency: number;
  private readonly maxWander: number;

  constructor(maxFrequencyPpm: number, maxWanderPpm: number, private readonly leapOnly: boolean) {
    this.maxFrequency = maxFrequencyPpm * 1e-6;
    this.maxWander = maxWanderPpm * 1e-6;
  }

  private current(now: number): { offset: number; frequency: number; wander: number } {
    let elapsed = now - this.lastUpdate;
    let offset = this.offset;
    let frequency = this.frequency;
    let wander = 0;
    for (let i = 0; i < STAGE_COUNT; i++) {
      if (elapsed <= 0) break;
      let length = this.stages[i].length;
      if (length >= elapsed) length = elapsed;
      wander = this.stages[i].wander;
      offset -= length * (2.0 * frequency + wander * length) / 2.0;
      frequency += wander * length;
      elapsed -= length;
    }
    if (elapsed > 0) {
      wander = 0;
      offset -= elapsed * frequency;
    }
    return { offset, frequency, wander };
  }

  private updateStages(): void {
    const s1 = this.offset / this.maxWander;
    const s2 = this.frequency ** 2 / (2.0 * this.maxWander ** 2);
    const l1t = [0, 0];
    const l3t = [0, 0];
    const err = [0, 0];
    for (let i = 0, dir = -1; i <= 1; i++, dir += 2) {
      let s = dir * s1 + s2;
      if (s < 0) { err[i] += -s; s = 0; }
      l3t[i] = Math.sqrt(s);
      l1t[i] = l3t[i] - dir * this.frequency / this.maxWander;
      if (l1t[i] < 0) { err[i] += l1t[i] * l1t[i]; l1t[i] = 0; }
    }
    let l1: number;
    let l3: number;
    let dir: number;
    if (err[0] < err[1]) { l1 = l1t[0]; l3 = l3t[0]; dir = -1; } else { l1 = l1t[1]; l3 = l3t[1]; dir = 1; }
    let l2 = 0;
    const f = dir * this.frequency + l1 * this.maxWander - this.maxFrequency;
    if (f > 0) {
      let lc = f / this.maxWander;
      let f2: number;
      if (lc > l1) { lc = l1; f2 = dir * this.frequency; } else { f2 = this.maxFrequency; }
      l2 = lc * (2.0 + f / f2);
      l1 -= lc;
      l3 -= lc;
    }
    this.stages[0] = { wander: dir * this.maxWander, length: l1 };
    this.stages[1] = { wander: 0, length: l2 };
    this.stages[2] = { wander: -dir * this.maxWander, length: l3 };
  }

  private update(now: number, offset: number, frequency: number, skew: number): void {
    if (this.locked) {
      if (skew / this.maxWander < UNLOCK_SKEW_WANDER_RATIO || this.leapOnly) this.activate(now);
      return;
    }
    const current = this.current(now);
    this.offset = current.offset + offset;
    this.frequency = (current.frequency - frequency) / (1.0 - frequency);
    this.lastUpdate = now;
    this.updateStages();
  }

  adjust(now: number, offset: number, frequency: number, skew: number): void {
    if (this.leapOnly) this.update(now, 0, 0, skew);
    else this.update(now, offset, frequency, skew);
    this.shiftLastUpdate(now, offset, frequency);
  }

  stepped(now: number, offset: number): void {
    this.reset(now);
    this.shiftLastUpdate(now, offset, 0);
  }

  private shiftLastUpdate(now: number, offset: number, frequency: number): void {
    if (this.lastUpdate !== 0) this.lastUpdate += (now - this.lastUpdate) * frequency - offset;
  }

  leap(now: number, leap: number, skew: number): void {
    if (!this.leapOnly) return;
    this.update(now, leap, 0, skew);
  }

  offsetAt(now: number): number { return this.current(now).offset; }

  activate(now: number): void {
    if (!this.locked) return;
    this.locked = false;
    this.lastUpdate = now;
  }

  reset(now: number): void {
    this.offset = 0;
    this.frequency = 0;
    this.lastUpdate = now;
    for (const stage of this.stages) { stage.wander = 0; stage.length = 0; }
  }

  report(now: number): SmoothingReport {
    const current = this.current(now);
    const elapsed = now - this.lastUpdate;
    let lastUpdateAgo = 0;
    let remainingTime = 0;
    if (!this.locked && elapsed >= 0) {
      const length = this.stages.reduce((sum, stage) => sum + stage.length, 0);
      lastUpdateAgo = elapsed;
      remainingTime = elapsed < length ? length - elapsed : 0;
    }
    return {
      active: !this.locked,
      leapOnly: this.leapOnly,
      offset: current.offset,
      frequencyPpm: current.frequency * -1.0e6,
      wanderPpm: current.wander * -1.0e6,
      lastUpdateAgo,
      remainingTime,
    };
  }
}
