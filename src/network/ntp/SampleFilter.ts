import { chi2Coefficient, weightedRegression } from './Regression';
import type { MeasurementSample } from './SourceStatistics';

const MIN_SAMPLES = 1;
const MAX_SAMPLES = 256;

export class SampleFilter {
  private readonly maxSamples: number;
  private samples: MeasurementSample[] = [];
  private last: MeasurementSample | null = null;
  private averageVariance: number;
  private averageVarianceCount = 0;
  private readonly maxVariance: number;

  constructor(
    private readonly minSamples: number,
    maxSamples: number,
    maxDispersion: number,
    private readonly combineRatio: number,
    precisionQuantum: number,
  ) {
    this.maxSamples = Math.max(minSamples, Math.min(MAX_SAMPLES, Math.max(MIN_SAMPLES, maxSamples)));
    this.minSamples = Math.min(MAX_SAMPLES, Math.max(MIN_SAMPLES, minSamples));
    this.averageVariance = precisionQuantum ** 2;
    this.maxVariance = maxDispersion ** 2;
  }

  getMaxSamples(): number { return this.maxSamples; }

  getUsed(): number { return this.samples.length; }

  lastSample(): MeasurementSample | null { return this.last; }

  accumulate(sample: MeasurementSample): boolean {
    if (this.samples.length > 0 && this.last !== null && this.last.time >= sample.time) return false;
    if (this.samples.length >= this.maxSamples) this.samples.shift();
    this.samples.push(sample);
    this.last = sample;
    return true;
  }

  drop(): void {
    this.samples = [];
    this.last = null;
  }

  private select(): number[] {
    const used = this.samples.length;
    if (used < this.minSamples) return [];
    let selected: number[] = [];
    if (used > 4) {
      const minimum = Math.min(...this.samples.map((s) => s.peerDispersion));
      selected = this.samples.map((_, i) => i).filter((i) => this.samples[i].peerDispersion <= 1.5 * minimum);
    }
    if (selected.length < 4) selected = this.samples.map((_, i) => i);
    selected.sort((a, b) => this.samples[a].offset - this.samples[b].offset);
    const count = selected.length;
    let from = 0;
    if (count > 2) {
      from = Math.trunc(count * (1.0 - this.combineRatio) / 2.0);
      from = Math.min(Math.max(1, from), Math.trunc((count - 1) / 2));
    }
    const to = count - from;
    return selected.slice(from, to).sort((a, b) => a - b);
  }

  filtered(): MeasurementSample | null {
    const chosen = this.select();
    if (chosen.length < 1) return null;
    const result = this.combine(chosen);
    if (result === null) return null;
    const lastSample = this.last;
    this.samples = [];
    this.last = lastSample;
    return result;
  }

  private combine(chosen: readonly number[]): MeasurementSample | null {
    const picked = chosen.map((i) => this.samples[i]);
    const n = picked.length;
    const lastSample = picked[n - 1];
    const x = picked.map((s) => s.time - lastSample.time);
    const y = picked.map((s) => s.offset);
    const w = picked.map((s) => s.peerDispersion);
    let meanX = 0;
    let meanY = 0;
    for (let i = 0; i < n; i++) { meanX += x[i]; meanY += y[i]; }
    meanX /= n;
    meanY /= n;
    let variance: number;
    let dispersion: number;
    let dof: number;
    if (n >= 4) {
      const centred = x.map((value) => value - meanX);
      const fit = weightedRegression(centred, y, w, n);
      variance = fit.variance;
      dispersion = fit.interceptDeviation;
      dof = n - 2;
    } else if (n >= 2) {
      let sum = 0;
      for (let i = 0; i < n; i++) sum += (y[i] - meanY) * (y[i] - meanY);
      variance = sum / (n - 1);
      dispersion = Math.sqrt(variance);
      dof = n - 1;
    } else {
      variance = this.averageVariance;
      dispersion = Math.sqrt(variance);
      dof = 1;
    }
    if (variance < 1e-20) { variance = 1e-20; dispersion = Math.sqrt(variance); }
    if (this.maxVariance > 0.0 && variance > this.maxVariance) return null;
    let previousAverage = this.averageVariance;
    if (this.averageVarianceCount > 50) {
      this.averageVariance += dof / (dof + 50.0) * (variance - this.averageVariance);
    } else {
      this.averageVariance = (this.averageVariance * this.averageVarianceCount + variance * dof) / (dof + this.averageVarianceCount);
      if (this.averageVarianceCount === 0) previousAverage = this.averageVariance;
      this.averageVarianceCount += dof;
    }
    if (variance * dof / chi2Coefficient(dof) < previousAverage) {
      dispersion = Math.sqrt(this.averageVariance) * dispersion / Math.sqrt(variance);
    }
    const mean = (pick: (s: MeasurementSample) => number): number => picked.reduce((sum, s) => sum + pick(s), 0) / n;
    return {
      time: lastSample.time + meanX,
      offset: meanY,
      peerDispersion: Math.max(dispersion, mean((s) => s.peerDispersion)),
      rootDispersion: Math.max(dispersion, mean((s) => s.rootDispersion)),
      peerDelay: mean((s) => s.peerDelay),
      rootDelay: mean((s) => s.rootDelay),
    };
  }
}
