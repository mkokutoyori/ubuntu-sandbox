/**
 * SampleFilter is a port of chrony 4.5's samplefilt.c (the `filter` source
 * option). The fixture was produced by compiling the real samplefilt.c,
 * regress.c, util.c and memory.c into a harness
 * (scripts/oracle/record_chrony_spf.py) that feeds two synthetic series
 * through filters of several lengths and prints every filtered sample.
 *
 * Measured against nothing: the class did not exist before (the `filter`
 * option was accepted and ignored), so all nine runs fall without it. The
 * length-1 run is the witness that needs no regression: a one-sample filter
 * returns the sample itself, in the harness and in the port.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { SampleFilter } from '@/network/ntp/SampleFilter';
import type { MeasurementSample } from '@/network/ntp/SourceStatistics';

interface Fixture {
  cases: { series: string; length: number; samples: number[][]; expected: string[][] }[];
}

const fixture: Fixture = JSON.parse(readFileSync(
  new URL('../../support/oracle/chrony-samplefilt-4.5.json', import.meta.url), 'utf8'));

function close(actual: number, expected: number, relative = 1e-6): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(relative * Math.max(1e-6, Math.abs(expected)));
}

describe('SampleFilter matches the compiled chrony 4.5 samplefilt', () => {
  for (const run of fixture.cases) {
    it(`${run.series}: filter ${run.length}`, () => {
      const filter = new SampleFilter(1, run.length, 16.0, 0.0, 1e-9);
      const produced: (MeasurementSample | null)[] = [];
      let count = 0;
      for (const [time, offset, peerDelay, peerDispersion, rootDelay, rootDispersion] of run.samples) {
        filter.accumulate({ time, offset, peerDelay, peerDispersion, rootDelay, rootDispersion });
        if (++count < filter.getMaxSamples()) continue;
        const out = filter.filtered();
        produced.push(out);
        if (out !== null) count = 0;
      }
      expect(produced.length).toBe(run.expected.length);
      run.expected.forEach((expected, index) => {
        const out = produced[index];
        if (expected[0] === 'none') { expect(out).toBeNull(); return; }
        expect(out).not.toBeNull();
        close(out!.time, Number(expected[0]), 1e-12);
        close(out!.offset, Number(expected[1]));
        close(out!.peerDelay, Number(expected[2]));
        close(out!.peerDispersion, Number(expected[3]));
        close(out!.rootDelay, Number(expected[4]));
        close(out!.rootDispersion, Number(expected[5]));
      });
    });
  }
});
