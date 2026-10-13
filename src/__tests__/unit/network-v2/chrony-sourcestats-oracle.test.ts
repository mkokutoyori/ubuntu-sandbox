/**
 * SourceStatistics is a port of chrony 4.5's sourcestats.c and regress.c.
 * The fixture was produced by compiling the real C files into a harness
 * (scripts/oracle/record_chrony_sst.py) and feeding it four synthetic
 * measurement series sample by sample; every sample yields one expected
 * report (sample count, runs, span, offset, offset error, residual frequency,
 * skew, standard deviation and the selection limits).
 *
 * The asymmetric series is run with the estimator on (1.0), off (0.0) and
 * fixed (0.3) and also compares the jitter asymmetry and the delay-test data
 * (SST_GetDelayTestData) that ntp_core.c reads.
 *
 * Measured against the previous class: the four original series passed
 * (asymmetry 0 was all it modelled); the three asymmetric runs fall on the
 * jitter asymmetry, and the estimating and fixed runs also on the offsets.
 * The asymmetry-0 run of the asymmetric series is the witness.
 *
 * Before the port existed the class was missing, so the four series fail.
 * Inside each series the first two samples report the worst-case bounds on
 * both sides (no regression below three samples); they are the witness that
 * the harness and the port start from the same state.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { SourceStatistics } from '@/network/ntp/SourceStatistics';

interface Fixture {
  cases: { series: string; asymmetry: number; samples: number[][]; expected: string[][] }[];
}

const fixture: Fixture = JSON.parse(readFileSync(
  new URL('../../support/oracle/chrony-sourcestats-4.5.json', import.meta.url), 'utf8'));

function close(actual: number, expected: number, relative = 1e-7): void {
  const tolerance = relative * Math.max(1e-3, Math.abs(expected));
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
}

describe('SourceStatistics matches the compiled chrony 4.5 sourcestats', () => {
  for (const series of fixture.cases) {
    it(`${series.series} (asymmetry ${series.asymmetry}): ${series.samples.length} samples, every report`, () => {
      const statistics = new SourceStatistics(1e-9, 1, 0, 0, series.asymmetry);
      series.samples.forEach((sample, index) => {
        const [time, offset, peerDelay, peerDispersion, rootDelay, rootDispersion] = sample;
        statistics.accumulate({ time, offset, peerDelay, peerDispersion, rootDelay, rootDispersion });
        const report = statistics.sourcestats(time);
        const selection = statistics.selection(time)!;
        const expected = series.expected[index].map(Number);
        expect(report.samples).toBe(expected[0]);
        expect(report.runs).toBe(expected[1]);
        expect(report.spanSeconds).toBe(expected[2]);
        const relative = series.asymmetry === 1 ? 1e-6 : 1e-7;
        close(report.estimatedOffset, expected[3], relative);
        close(report.estimatedOffsetError, expected[4], relative);
        expect(Math.abs(report.residualFrequencyPpm - expected[5])).toBeLessThanOrEqual(1e-6 * Math.max(1, Math.abs(expected[5])));
        close(report.skewPpm, expected[6]);
        close(report.standardDeviation, expected[7]);
        close(selection.offsetLow, expected[8]);
        close(selection.offsetHigh, expected[9]);
        expect(selection.selectable).toBe(expected[10] === 1);
        close(statistics.jitterAsymmetry(), expected[11]);
        const delayData = statistics.delayTestData(time);
        expect(delayData !== null).toBe(expected[12] === 1);
        if (delayData !== null) {
          close(delayData.predictedOffset, expected[13]);
          close(delayData.minDelay, expected[14]);
          close(delayData.skew, expected[15]);
          close(delayData.standardDeviation, expected[16]);
        }
      });
    });
  }
});
