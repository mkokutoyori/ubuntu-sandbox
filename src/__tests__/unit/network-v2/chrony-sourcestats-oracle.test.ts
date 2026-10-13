/**
 * SourceStatistics is a port of chrony 4.5's sourcestats.c and regress.c.
 * The fixture was produced by compiling the real C files into a harness
 * (scripts/oracle/record_chrony_sst.py) and feeding it four synthetic
 * measurement series sample by sample; every sample yields one expected
 * report (sample count, runs, span, offset, offset error, residual frequency,
 * skew, standard deviation and the selection limits).
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
  cases: { series: string; samples: number[][]; expected: string[][] }[];
}

const fixture: Fixture = JSON.parse(readFileSync(
  new URL('../../support/oracle/chrony-sourcestats-4.5.json', import.meta.url), 'utf8'));

function close(actual: number, expected: number): void {
  const tolerance = 1e-7 * Math.max(1e-3, Math.abs(expected));
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
}

describe('SourceStatistics matches the compiled chrony 4.5 sourcestats', () => {
  for (const series of fixture.cases) {
    it(`${series.series}: ${series.samples.length} samples, every report`, () => {
      const statistics = new SourceStatistics(1e-9);
      series.samples.forEach((sample, index) => {
        const [time, offset, peerDelay, peerDispersion, rootDelay, rootDispersion] = sample;
        statistics.accumulate({ time, offset, peerDelay, peerDispersion, rootDelay, rootDispersion });
        const report = statistics.sourcestats(time);
        const selection = statistics.selection(time)!;
        const expected = series.expected[index].map(Number);
        expect(report.samples).toBe(expected[0]);
        expect(report.runs).toBe(expected[1]);
        expect(report.spanSeconds).toBe(expected[2]);
        close(report.estimatedOffset, expected[3]);
        close(report.estimatedOffsetError, expected[4]);
        close(report.residualFrequencyPpm, expected[5]);
        close(report.skewPpm, expected[6]);
        close(report.standardDeviation, expected[7]);
        close(selection.offsetLow, expected[8]);
        close(selection.offsetHigh, expected[9]);
        expect(selection.selectable).toBe(expected[10] === 1);
      });
    });
  }
});
