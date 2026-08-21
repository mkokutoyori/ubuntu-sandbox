export class SystemClock {
  private overrideMs: number | null = null;
  private setAtMs = 0;

  constructor(private readonly source: () => number = () => Date.now()) {}

  now(): number {
    if (this.overrideMs === null) return this.source();
    return this.overrideMs + (this.source() - this.setAtMs);
  }

  set(epochMs: number): void {
    this.overrideMs = epochMs;
    this.setAtMs = this.source();
  }

  isSetManually(): boolean { return this.overrideMs !== null; }

  release(): void { this.overrideMs = null; }
}
