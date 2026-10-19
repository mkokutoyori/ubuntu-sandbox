import type { SourceStatistics } from './SourceStatistics';
import type { DelayQuantile } from './DelayQuantile';

export const MAX_SERVER_INTERVAL_SECONDS = 4.0;
export const DEFAULT_MAX_DELAY_SECONDS = 3.0;
export const DEFAULT_MAX_DELAY_DEV_RATIO = 10.0;
export const MAX_CLOCK_ERROR = 1e-6;

export interface SampleTestInput {
  readonly peerDelay: number;
  readonly peerDispersion: number;
  readonly offset: number;
  readonly sampleTime: number;
  readonly precision: number;
  readonly responseTime: number;
  readonly presendDone: number;
  readonly maxDelay: number | undefined;
  readonly maxDelayRatio: number | undefined;
  readonly maxDelayDevRatio: number | undefined;
  readonly statistics: SourceStatistics;
  readonly quantile: DelayQuantile | undefined;
}

export interface SampleTestResult {
  readonly a: boolean;
  readonly b: boolean;
  readonly c: boolean;
}

function checkDelayRatio(input: SampleTestInput): boolean {
  const ratio = input.maxDelayRatio ?? 0;
  if (ratio < 1.0) return true;
  const data = input.statistics.delayTestData(input.sampleTime);
  if (data === null) return true;
  const maxDelay = data.minDelay * ratio + data.lastSampleAgo * (data.skew + MAX_CLOCK_ERROR);
  return input.peerDelay <= maxDelay;
}

function checkDelayDevRatio(input: SampleTestInput): boolean {
  const data = input.statistics.delayTestData(input.sampleTime);
  if (data === null) return true;
  const devRatio = input.maxDelayDevRatio ?? DEFAULT_MAX_DELAY_DEV_RATIO;
  const maxDelta = data.standardDeviation * devRatio + data.lastSampleAgo * (data.skew + MAX_CLOCK_ERROR);
  const delta = (input.peerDelay - data.minDelay) / 2.0;
  if (delta <= maxDelta) return true;
  const errorInEstimate = input.offset + data.predictedOffset;
  return Math.abs(errorInEstimate) - delta > maxDelta;
}

export function evaluateSampleTests(input: SampleTestInput): SampleTestResult {
  const maxDelay = input.maxDelay ?? DEFAULT_MAX_DELAY_SECONDS;
  const a = input.peerDelay - input.peerDispersion <= maxDelay
    && input.precision <= maxDelay
    && input.presendDone <= 0
    && !(input.responseTime > MAX_SERVER_INTERVAL_SECONDS);
  const b = checkDelayRatio(input);
  const c = input.quantile !== undefined
    ? input.peerDelay <= input.quantile.quantile()
    : checkDelayDevRatio(input);
  return { a, b, c };
}
