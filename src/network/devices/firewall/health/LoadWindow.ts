const BUCKET_MS = 10_000;

export const WINDOW_MINUTES: readonly number[] = Object.freeze([1, 10, 30]);

const LONGEST_MS = 30 * 60_000;

export class CounterWindow {
  private readonly buckets = new Map<number, number>();

  constructor(private readonly now: () => number) {}

  add(amount: number): void {
    const slot = Math.floor(this.now() / BUCKET_MS);
    this.buckets.set(slot, (this.buckets.get(slot) ?? 0) + amount);
    this.forget();
  }

  total(withinMs: number): number {
    const oldest = Math.floor((this.now() - withinMs) / BUCKET_MS);
    let sum = 0;
    for (const [slot, amount] of this.buckets) {
      if (slot >= oldest) sum += amount;
    }
    return sum;
  }

  ratePerSecond(withinMs: number): number {
    return this.total(withinMs) / (withinMs / 1000);
  }

  private forget(): void {
    const oldest = Math.floor((this.now() - LONGEST_MS) / BUCKET_MS);
    for (const slot of this.buckets.keys()) {
      if (slot < oldest) this.buckets.delete(slot);
    }
  }
}

interface GaugeStep {
  readonly at: number;
  readonly value: number;
}

export class GaugeWindow {
  private readonly steps: GaugeStep[] = [];

  constructor(private readonly now: () => number, initial = 0) {
    this.steps.push({ at: this.now(), value: initial });
  }

  observe(value: number): void {
    const at = this.now();
    const last = this.steps[this.steps.length - 1];
    if (last && last.value === value) return;
    if (last && last.at === at) this.steps.pop();
    this.steps.push({ at, value });
    this.forget(at);
  }

  average(withinMs: number): number {
    const end = this.now();
    const start = end - withinMs;
    if (end === start) return this.steps[this.steps.length - 1]?.value ?? 0;

    let weighted = 0;
    for (let index = 0; index < this.steps.length; index++) {
      const step = this.steps[index]!;
      const until = this.steps[index + 1]?.at ?? end;
      const from = Math.max(step.at, start);
      const to = Math.min(until, end);
      if (to > from) weighted += step.value * (to - from);
    }
    return weighted / (end - start);
  }

  private forget(at: number): void {
    const horizon = at - LONGEST_MS;
    while (this.steps.length > 1 && (this.steps[1]?.at ?? at) <= horizon) {
      this.steps.shift();
    }
  }
}
