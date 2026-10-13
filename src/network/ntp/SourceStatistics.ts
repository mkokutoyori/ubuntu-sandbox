const MAX_SAMPLES = 64;
const RUNS_RATIO = 2;
const MIN_SAMPLES_FOR_REGRESSION = 3;
const WORST_CASE_FREQUENCY_BOUND = 2000 / 1e6;
const MIN_SKEW = 1e-12;
const MAX_SKEW = 1e2;
const MIN_STANDARD_DEVIATION = 1e-9;
const WORST_CASE_STANDARD_DEVIATION = 4;
const SD_TO_DISTANCE_RATIO = 0.7;

const CRITICAL_RUNS: readonly number[] = [
  0, 0, 0, 0, 0, 0, 0, 0, 2, 3,
  3, 3, 4, 4, 5, 5, 5, 6, 6, 7,
  7, 7, 8, 8, 9, 9, 9, 10, 10, 11,
  11, 11, 12, 12, 13, 13, 14, 14, 14, 15,
  15, 16, 16, 17, 17, 18, 18, 18, 19, 19,
  20, 20, 21, 21, 21, 22, 22, 23, 23, 24,
  24, 25, 25, 26, 26, 26, 27, 27, 28, 28,
  29, 29, 30, 30, 30, 31, 31, 32, 32, 33,
  33, 34, 34, 35, 35, 35, 36, 36, 37, 37,
  38, 38, 39, 39, 40, 40, 40, 41, 41, 42,
  42, 43, 43, 44, 44, 45, 45, 46, 46, 46,
  47, 47, 48, 48, 49, 49, 50, 50, 51, 51,
  52, 52, 52, 53, 53, 54, 54, 55, 55, 56,
];

const STUDENT_T_QUANTILES: readonly number[] = [
  636.6, 31.6, 12.92, 8.61, 6.869,
  5.959, 5.408, 5.041, 4.781, 4.587,
  4.437, 4.318, 4.221, 4.140, 4.073,
  4.015, 3.965, 3.922, 3.883, 3.850,
  3.819, 3.792, 3.768, 3.745, 3.725,
  3.707, 3.690, 3.674, 3.659, 3.646,
  3.633, 3.622, 3.611, 3.601, 3.591,
  3.582, 3.574, 3.566, 3.558, 3.551,
];

export interface MeasurementSample {
  readonly time: number;
  readonly offset: number;
  readonly peerDelay: number;
  readonly peerDispersion: number;
  readonly rootDelay: number;
  readonly rootDispersion: number;
}

export interface StoredSample {
  time: number;
  offset: number;
  original: number;
  peerDelay: number;
  peerDispersion: number;
  rootDelay: number;
  rootDispersion: number;
}

export interface SourcestatsReport {
  readonly samples: number;
  readonly runs: number;
  readonly spanSeconds: number;
  readonly estimatedOffset: number;
  readonly estimatedOffsetError: number;
  readonly residualFrequencyPpm: number;
  readonly skewPpm: number;
  readonly standardDeviation: number;
}

export interface SelectionData {
  readonly offsetLow: number;
  readonly offsetHigh: number;
  readonly rootDistance: number;
  readonly standardDeviation: number;
  readonly firstSampleAgo: number;
  readonly lastSampleAgo: number;
  readonly selectable: boolean;
}

export interface TrackingData {
  readonly referenceTime: number;
  readonly averageOffset: number;
  readonly offsetStandardDeviation: number;
  readonly frequency: number;
  readonly frequencyStandardDeviation: number;
  readonly skew: number;
  readonly rootDelay: number;
  readonly rootDispersion: number;
}

function clamp(low: number, value: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length & 1 ? sorted[middle] : 0.5 * (sorted[middle] + sorted[middle - 1]);
}

function studentCoefficient(degreesOfFreedom: number): number {
  return degreesOfFreedom <= 40 ? Math.fround(STUDENT_T_QUANTILES[degreesOfFreedom - 1]) : 3.5;
}

function countRuns(residuals: readonly number[]): number {
  let runs = 1;
  for (let i = 1; i < residuals.length; i++) {
    const sameSign = (residuals[i - 1] < 0 && residuals[i] < 0) || (residuals[i - 1] > 0 && residuals[i] > 0);
    if (!sameSign) runs++;
  }
  return runs;
}

interface Regression {
  readonly intercept: number;
  readonly slope: number;
  readonly variance: number;
  readonly interceptDeviation: number;
  readonly slopeDeviation: number;
  readonly newStart: number;
  readonly runs: number;
  readonly degreesOfFreedom: number;
}

function findBestRegression(
  x: readonly number[], y: readonly number[], w: readonly number[], n: number, extra: number, minSamples: number,
): Regression | null {
  if (n < MIN_SAMPLES_FOR_REGRESSION) return null;
  const at = (array: readonly number[], index: number): number => array[index + extra];
  let start = 0;
  let a = 0;
  let b = 0;
  let u = 0;
  let totalWeight = 0;
  let totalV = 0;
  let residuals: number[] = [];
  let residualStart = 0;
  let runs = 0;
  for (;;) {
    let sumXw = 0;
    totalWeight = 0;
    for (let i = start; i < n; i++) {
      sumXw += at(x, i) / w[i];
      totalWeight += 1 / w[i];
    }
    u = sumXw / totalWeight;
    let p = 0;
    let q = 0;
    totalV = 0;
    for (let i = start; i < n; i++) {
      const ui = at(x, i) - u;
      p += at(y, i) / w[i];
      q += at(y, i) * ui / w[i];
      totalV += ui * ui / w[i];
    }
    b = q / totalV;
    a = p / totalWeight - b * u;
    residualStart = n - (n - start) * RUNS_RATIO;
    if (residualStart < -extra) residualStart = -extra;
    residuals = [];
    for (let i = residualStart; i < n; i++) residuals.push(at(y, i) - a - b * at(x, i));
    runs = countRuns(residuals);
    if (runs > CRITICAL_RUNS[n - residualStart] || n - start <= MIN_SAMPLES_FOR_REGRESSION || n - start <= minSamples) {
      if (start !== residualStart) runs = countRuns(residuals.slice(start - residualStart));
      break;
    }
    start++;
  }
  let ss = 0;
  for (let i = start; i < n; i++) ss += residuals[i - residualStart] ** 2 / w[i];
  const points = n - start;
  ss /= points - 2;
  const slopeDeviation = Math.sqrt(ss / totalV);
  const aa = u * slopeDeviation;
  return {
    intercept: a,
    slope: b,
    variance: ss * points / totalWeight,
    interceptDeviation: Math.sqrt(ss / totalWeight + aa * aa),
    slopeDeviation,
    newStart: start,
    runs,
    degreesOfFreedom: points - 2,
  };
}

export class SourceStatistics {
  private records: StoredSample[] = [];
  private count = 0;
  private runsSamples = 0;
  private regressionOk = false;
  private bestSingleSample = 0;
  private estimatedOffset = 0;
  private estimatedOffsetDeviation = WORST_CASE_STANDARD_DEVIATION;
  private offsetTime = 0;
  private runs = 0;
  private frequency = 0;
  private frequencyDeviation = WORST_CASE_FREQUENCY_BOUND;
  private skew = WORST_CASE_FREQUENCY_BOUND;
  private standardDeviation = WORST_CASE_STANDARD_DEVIATION;

  private readonly minSamples: number;
  private readonly maxSamples: number;

  constructor(
    private readonly precisionQuantum: number,
    minSamples = 1,
    maxSamples = 0,
    private readonly fixedMinDelay = 0,
  ) {
    this.maxSamples = maxSamples > 0 ? clamp(1, maxSamples, MAX_SAMPLES) : MAX_SAMPLES;
    this.minSamples = clamp(1, minSamples, this.maxSamples);
  }

  reset(): void {
    this.records = [];
    this.count = 0;
    this.runsSamples = 0;
    this.regressionOk = false;
    this.bestSingleSample = 0;
    this.estimatedOffset = 0;
    this.estimatedOffsetDeviation = WORST_CASE_STANDARD_DEVIATION;
    this.offsetTime = 0;
    this.runs = 0;
    this.frequency = 0;
    this.frequencyDeviation = WORST_CASE_FREQUENCY_BOUND;
    this.skew = WORST_CASE_FREQUENCY_BOUND;
    this.standardDeviation = WORST_CASE_STANDARD_DEVIATION;
  }

  getSampleCount(): number { return this.count; }

  private record(index: number): StoredSample { return this.records[this.runsSamples + index]; }

  private prune(newOldest: number): void {
    if (newOldest === 0) return;
    this.count -= newOldest;
    this.runsSamples += newOldest;
    const limit = this.count * (RUNS_RATIO - 1);
    if (this.runsSamples > limit) {
      this.records.splice(0, this.runsSamples - limit);
      this.runsSamples = limit;
    }
  }

  accumulate(sample: MeasurementSample): void {
    if (this.count > 0 && (this.count === MAX_SAMPLES || this.count === this.maxSamples)) this.prune(1);
    if (this.count > 0 && this.record(this.count - 1).time >= sample.time) this.reset();
    this.records.push({
      time: sample.time,
      offset: -sample.offset,
      original: -sample.offset,
      peerDelay: sample.peerDelay < this.fixedMinDelay ? 2 * this.fixedMinDelay - sample.peerDelay : sample.peerDelay,
      peerDispersion: sample.peerDispersion,
      rootDelay: sample.rootDelay,
      rootDispersion: sample.rootDispersion,
    });
    this.count++;
    this.regress();
  }

  private regress(): void {
    const n = this.count;
    const extra = this.runsSamples;
    const lastTime = this.record(n - 1).time;
    const timesBack: number[] = [];
    const offsets: number[] = [];
    for (let i = -extra; i < n; i++) {
      timesBack.push(this.record(i).time - lastTime);
      offsets.push(this.record(i).offset);
    }
    const peerDistances: number[] = [];
    let minDistance = Number.MAX_VALUE;
    for (let i = 0; i < n; i++) {
      const distance = 0.5 * this.record(i).peerDelay + this.record(i).peerDispersion;
      peerDistances.push(distance);
      if (distance < minDistance) minDistance = distance;
    }
    const medianDistance = median(peerDistances);
    const sd = clamp(this.precisionQuantum, (medianDistance - minDistance) / SD_TO_DISTANCE_RATIO, minDistance);
    minDistance += this.precisionQuantum;
    const weights = peerDistances.map((distance) => {
      const weight = distance > minDistance ? 1 + (distance - minDistance) / sd : 1;
      return weight * weight;
    });
    const result = findBestRegression(timesBack, offsets, weights, n, extra, this.minSamples);
    this.regressionOk = result !== null;
    let timesBackStart = 0;
    if (result !== null) {
      this.frequency = result.slope;
      this.frequencyDeviation = clamp(MIN_SKEW, result.slopeDeviation, MAX_SKEW);
      this.skew = clamp(MIN_SKEW, result.slopeDeviation * studentCoefficient(result.degreesOfFreedom), MAX_SKEW);
      this.estimatedOffset = result.intercept;
      this.offsetTime = lastTime;
      this.estimatedOffsetDeviation = result.interceptDeviation;
      this.standardDeviation = Math.max(MIN_STANDARD_DEVIATION, Math.sqrt(result.variance));
      this.runs = result.runs;
      timesBackStart = extra + result.newStart;
      this.prune(result.newStart);
    } else {
      this.frequencyDeviation = WORST_CASE_FREQUENCY_BOUND;
      this.skew = WORST_CASE_FREQUENCY_BOUND;
      this.estimatedOffsetDeviation = WORST_CASE_STANDARD_DEVIATION;
      this.standardDeviation = WORST_CASE_STANDARD_DEVIATION;
      this.runs = 0;
      this.estimatedOffset = this.record(n - 1).offset;
      this.offsetTime = lastTime;
    }
    this.findBestSample(timesBack.slice(timesBackStart));
  }

  private findBestSample(timesBack: readonly number[]): void {
    let best = -1;
    let bestDistance = Number.MAX_VALUE;
    for (let i = 0; i < this.count; i++) {
      const elapsed = -timesBack[i];
      const sample = this.record(i);
      const distance = sample.rootDispersion + elapsed * this.skew + 0.5 * sample.rootDelay;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    }
    this.bestSingleSample = best;
  }

  sourcestats(now: number): SourcestatsReport {
    if (this.count === 0) {
      return {
        samples: 0, runs: this.runs, spanSeconds: 0, estimatedOffset: 0, estimatedOffsetError: 0,
        residualFrequencyPpm: 1e6 * this.frequency, skewPpm: 1e6 * this.skew, standardDeviation: this.standardDeviation,
      };
    }
    const best = this.record(this.bestSingleSample);
    const span = this.record(this.count - 1).time - this.record(0).time;
    return {
      samples: this.count,
      runs: this.runs,
      spanSeconds: Math.round(span),
      estimatedOffset: this.estimatedOffset + (now - this.offsetTime) * this.frequency,
      estimatedOffsetError: this.estimatedOffsetDeviation + (now - best.time) * this.skew
        + 0.5 * best.rootDelay + best.rootDispersion,
      residualFrequencyPpm: 1e6 * this.frequency,
      skewPpm: 1e6 * this.skew,
      standardDeviation: this.standardDeviation,
    };
  }

  selection(now: number): SelectionData | null {
    if (this.count === 0) return null;
    const best = this.record(this.bestSingleSample);
    const elapsed = Math.abs(now - best.time);
    const offset = best.offset + elapsed * this.frequency;
    const rootDistance = 0.5 * best.rootDelay + best.rootDispersion + elapsed * this.skew;
    return {
      offsetLow: offset - rootDistance,
      offsetHigh: offset + rootDistance,
      rootDistance,
      standardDeviation: this.standardDeviation,
      firstSampleAgo: now - this.record(0).time,
      lastSampleAgo: now - this.record(this.count - 1).time,
      selectable: this.regressionOk,
    };
  }

  tracking(): TrackingData | null {
    if (this.count === 0) return null;
    const best = this.record(this.bestSingleSample);
    return {
      referenceTime: this.offsetTime,
      averageOffset: this.estimatedOffset,
      offsetStandardDeviation: this.estimatedOffsetDeviation,
      frequency: this.frequency,
      frequencyStandardDeviation: this.frequencyDeviation,
      skew: this.skew,
      rootDelay: best.rootDelay,
      rootDispersion: best.rootDispersion + this.skew * (this.offsetTime - best.time) + this.estimatedOffsetDeviation,
    };
  }

  predictOffset(time: number): number {
    if (this.count < MIN_SAMPLES_FOR_REGRESSION) return this.count > 0 ? this.record(this.count - 1).offset : 0;
    return this.estimatedOffset + (time - this.offsetTime) * this.frequency;
  }

  correctOffset(delta: number): void {
    if (this.count === 0) return;
    for (const record of this.records) record.offset += delta;
    this.estimatedOffset += delta;
  }

  peerDelays(): number[] {
    return this.records.slice(this.runsSamples).map((sample) => sample.peerDelay);
  }

  latest(): StoredSample | null {
    return this.count === 0 ? null : this.record(this.count - 1);
  }

  latestMeasurementError(): number {
    const last = this.latest();
    return last === null ? 0 : 0.5 * last.rootDelay + last.rootDispersion;
  }
}
