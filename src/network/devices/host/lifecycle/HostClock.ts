export class HostClock {
  private ms: number;

  constructor(epochMs = 0) {
    this.ms = epochMs;
  }

  now(): number {
    return this.ms;
  }

  advance(deltaMs: number): number {
    if (deltaMs > 0) this.ms += deltaMs;
    return this.ms;
  }

  advanceTo(target: number): number {
    if (target > this.ms) this.ms = target;
    return this.ms;
  }

  elapsedSince(instant: number): number {
    return Math.max(0, this.ms - instant);
  }

  reset(): void {
    this.ms = 0;
  }
}
