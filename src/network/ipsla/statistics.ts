import type { SlaJitterMeasurement, SlaReturnCode } from './types';

export interface RttAggregate {
  numRtts: number;
  sumRtt: number;
  minRtt: number | null;
  maxRtt: number | null;
}

export function createRttAggregate(): RttAggregate {
  return { numRtts: 0, sumRtt: 0, minRtt: null, maxRtt: null };
}

export function recordRtt(agg: RttAggregate, rttMs: number): void {
  agg.numRtts++;
  agg.sumRtt += rttMs;
  agg.minRtt = agg.minRtt === null ? rttMs : Math.min(agg.minRtt, rttMs);
  agg.maxRtt = agg.maxRtt === null ? rttMs : Math.max(agg.maxRtt, rttMs);
}

export function averageRtt(agg: RttAggregate): number {
  return agg.numRtts === 0 ? 0 : agg.sumRtt / agg.numRtts;
}

export interface ErrorCounters {
  successes: number;
  failures: number;
  timeouts: number;
  connectionLosses: number;
  overThresholds: number;
  verifyErrors: number;
  sequenceErrors: number;
  dropped: number;
  applicationErrors: number;
}

export function createErrorCounters(): ErrorCounters {
  return {
    successes: 0, failures: 0, timeouts: 0, connectionLosses: 0,
    overThresholds: 0, verifyErrors: 0, sequenceErrors: 0,
    dropped: 0, applicationErrors: 0,
  };
}

export function recordReturnCode(counters: ErrorCounters, code: SlaReturnCode): void {
  switch (code) {
    case 'ok':
      counters.successes++;
      break;
    case 'overThreshold':
      counters.successes++;
      counters.overThresholds++;
      break;
    case 'timeout':
      counters.failures++;
      counters.timeouts++;
      break;
    case 'notConnected':
      counters.failures++;
      counters.connectionLosses++;
      break;
    case 'dropped':
      counters.failures++;
      counters.dropped++;
      break;
    case 'sequenceError':
      counters.failures++;
      counters.sequenceErrors++;
      break;
    case 'verifyError':
      counters.failures++;
      counters.verifyErrors++;
      break;
    case 'applicationSpecific':
      counters.failures++;
      counters.applicationErrors++;
      break;
  }
}

export interface DistributionBucket {
  lowerBoundMs: number;
  upperBoundMs: number | null;
  count: number;
  sumRtt: number;
  sumRttSquared: number;
}

export function createDistribution(buckets: number, intervalMs: number): DistributionBucket[] {
  const out: DistributionBucket[] = [];
  for (let i = 0; i < Math.max(1, buckets); i++) {
    const last = i === Math.max(1, buckets) - 1;
    out.push({
      lowerBoundMs: i * intervalMs,
      upperBoundMs: last ? null : (i + 1) * intervalMs,
      count: 0,
      sumRtt: 0,
      sumRttSquared: 0,
    });
  }
  return out;
}

export function recordDistribution(buckets: DistributionBucket[], rttMs: number): void {
  for (const bucket of buckets) {
    if (bucket.upperBoundMs === null || rttMs < bucket.upperBoundMs) {
      bucket.count++;
      bucket.sumRtt += rttMs;
      bucket.sumRttSquared += rttMs * rttMs;
      return;
    }
  }
}

export interface HistoryEntry {
  sampleTimeMs: number;
  returnCode: SlaReturnCode;
  rttMs: number | null;
  respondingAddress: string | null;
}

export interface DirectionalJitterStats {
  numSamples: number;
  min: number | null;
  max: number | null;
  sum: number;
  numOfPositives: number;
  sumOfPositives: number;
  minPositive: number | null;
  maxPositive: number | null;
  numOfNegatives: number;
  sumOfNegatives: number;
  minNegative: number | null;
  maxNegative: number | null;
  interarrival: number;
}

export function createDirectionalJitterStats(): DirectionalJitterStats {
  return {
    numSamples: 0, min: null, max: null, sum: 0,
    numOfPositives: 0, sumOfPositives: 0, minPositive: null, maxPositive: null,
    numOfNegatives: 0, sumOfNegatives: 0, minNegative: null, maxNegative: null,
    interarrival: 0,
  };
}

export function recordJitterDelta(stats: DirectionalJitterStats, delta: number): void {
  const magnitude = Math.abs(delta);
  stats.numSamples++;
  stats.sum += magnitude;
  stats.min = stats.min === null ? magnitude : Math.min(stats.min, magnitude);
  stats.max = stats.max === null ? magnitude : Math.max(stats.max, magnitude);
  if (delta > 0) {
    stats.numOfPositives++;
    stats.sumOfPositives += delta;
    stats.minPositive = stats.minPositive === null ? delta : Math.min(stats.minPositive, delta);
    stats.maxPositive = stats.maxPositive === null ? delta : Math.max(stats.maxPositive, delta);
  } else if (delta < 0) {
    stats.numOfNegatives++;
    stats.sumOfNegatives += magnitude;
    stats.minNegative = stats.minNegative === null ? magnitude : Math.min(stats.minNegative, magnitude);
    stats.maxNegative = stats.maxNegative === null ? magnitude : Math.max(stats.maxNegative, magnitude);
  }
  stats.interarrival += (magnitude - stats.interarrival) / 16;
}

export function averageJitter(stats: DirectionalJitterStats): number {
  return stats.numSamples === 0 ? 0 : stats.sum / stats.numSamples;
}

export interface OneWayStats {
  numSamples: number;
  min: number | null;
  max: number | null;
  sum: number;
}

export function createOneWayStats(): OneWayStats {
  return { numSamples: 0, min: null, max: null, sum: 0 };
}

export function recordOneWay(stats: OneWayStats, valueMs: number): void {
  stats.numSamples++;
  stats.sum += valueMs;
  stats.min = stats.min === null ? valueMs : Math.min(stats.min, valueMs);
  stats.max = stats.max === null ? valueMs : Math.max(stats.max, valueMs);
}

export function averageOneWay(stats: OneWayStats): number {
  return stats.numSamples === 0 ? 0 : stats.sum / stats.numSamples;
}

export interface JitterAccumulator {
  sourceToDestination: DirectionalJitterStats;
  destinationToSource: DirectionalJitterStats;
  oneWaySD: OneWayStats;
  oneWayDS: OneWayStats;
  packetsSent: number;
  packetsReceived: number;
  packetLossSD: number;
  packetLossDS: number;
  packetMIA: number;
  packetOutOfSequence: number;
  packetLateArrival: number;
}

export function createJitterAccumulator(): JitterAccumulator {
  return {
    sourceToDestination: createDirectionalJitterStats(),
    destinationToSource: createDirectionalJitterStats(),
    oneWaySD: createOneWayStats(),
    oneWayDS: createOneWayStats(),
    packetsSent: 0,
    packetsReceived: 0,
    packetLossSD: 0,
    packetLossDS: 0,
    packetMIA: 0,
    packetOutOfSequence: 0,
    packetLateArrival: 0,
  };
}

function deltasOf(series: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < series.length; i++) out.push(series[i] - series[i - 1]);
  return out;
}

export function accumulateJitter(acc: JitterAccumulator, measurement: SlaJitterMeasurement): void {
  acc.packetsSent += measurement.packetsSent;
  acc.packetsReceived += measurement.rtts.length;
  acc.packetLossSD += measurement.packetLossSD;
  acc.packetLossDS += measurement.packetLossDS;
  acc.packetMIA += measurement.packetMIA;
  acc.packetOutOfSequence += measurement.packetOutOfSequence;
  acc.packetLateArrival += measurement.packetLateArrival;

  if (measurement.oneWayValid) {
    for (const value of measurement.sourceToDestination) recordOneWay(acc.oneWaySD, value);
    for (const value of measurement.destinationToSource) recordOneWay(acc.oneWayDS, value);
    for (const delta of deltasOf(measurement.sourceToDestination)) {
      recordJitterDelta(acc.sourceToDestination, delta);
    }
    for (const delta of deltasOf(measurement.destinationToSource)) {
      recordJitterDelta(acc.destinationToSource, delta);
    }
    return;
  }

  for (const delta of deltasOf(measurement.rtts)) {
    recordJitterDelta(acc.sourceToDestination, delta);
    recordJitterDelta(acc.destinationToSource, delta);
  }
}

export function totalPacketLoss(acc: JitterAccumulator): number {
  return acc.packetLossSD + acc.packetLossDS + acc.packetMIA;
}

export function packetLossPercent(acc: JitterAccumulator): number {
  if (acc.packetsSent === 0) return 0;
  return (totalPacketLoss(acc) / acc.packetsSent) * 100;
}
