const QUANTILE_SCALE = 100;
const REPEATS = 7;
const MODULUS = 2147483647;
const MULTIPLIER = 48271;

interface Estimate { value: number; step: number; sign: number }

export class DelayQuantile {
  private readonly estimates: Estimate[] = [];
  private seed = 1;
  private setCount = 0;

  constructor(private readonly k: number, private readonly minStep: number) {
    this.reset();
  }

  static fromFraction(fraction: number, minStep: number): DelayQuantile {
    const k = Math.round(Math.min(0.95, Math.max(0.05, fraction)) * QUANTILE_SCALE);
    return new DelayQuantile(k, minStep);
  }

  reset(): void {
    this.setCount = 0;
    this.estimates.length = 0;
    for (let i = 0; i < REPEATS; i++) this.estimates.push({ value: 0, step: this.minStep, sign: 1 });
  }

  private random(): number {
    this.seed = (this.seed * MULTIPLIER) % MODULUS;
    return this.seed / (MODULUS - 1);
  }

  accumulate(value: number): void {
    if (this.setCount * REPEATS < this.estimates.length) {
      this.insertInitial(value);
      return;
    }
    const p = this.k / QUANTILE_SCALE;
    for (const estimate of this.estimates) this.update(estimate, value, p, this.random());
  }

  private insertInitial(value: number): void {
    for (const estimate of this.estimates) estimate.value = value;
    this.setCount = 1;
  }

  private update(q: Estimate, value: number, p: number, rand: number): void {
    const minStep = this.minStep;
    if (value > q.value && rand > 1.0 - p) {
      q.step += q.sign > 0 ? minStep : -minStep;
      q.value += q.step > 0.0 ? Math.abs(q.step) : minStep;
      if (q.value > value) { q.step += value - q.value; q.value = value; }
      if (q.sign < 0 && q.step > minStep) q.step = minStep;
      q.sign = 1;
    } else if (value < q.value && rand > p) {
      q.step += q.sign < 0 ? minStep : -minStep;
      q.value -= q.step > 0.0 ? Math.abs(q.step) : minStep;
      if (q.value < value) { q.step += q.value - value; q.value = value; }
      if (q.sign > 0 && q.step > minStep) q.step = minStep;
      q.sign = -1;
    }
  }

  quantile(): number {
    const sorted = this.estimates.map((e) => e.value).sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }
}
