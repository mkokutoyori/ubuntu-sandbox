/**
 * TimeSmoothing is a port of chrony 4.5's smooth.c (the `smoothtime`
 * directive and `chronyc smoothing`). The fixture was produced by compiling
 * the real smooth.c, util.c and memory.c into a harness
 * (scripts/oracle/record_chrony_smt.py) and replaying five scripted
 * scenarios: the default limits, a frequency limit that creates the second
 * stage, a negative offset with a frequency change, leap-only mode, and a
 * clock whose skew keeps the smoothing locked.
 *
 * Measured against nothing: the class did not exist (`smoothtime` was
 * accepted and `chronyc smoothing` answered 506), so every scenario falls
 * without it. The locked-by-skew scenario is the witness that a locked
 * smoother ignores offsets: it reports zero in the harness and in the port
 * before and after the sole difference between runs, the activation.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { TimeSmoothing } from '@/network/ntp/TimeSmoothing';

interface Scenario { name: string; env: Record<string, string>; commands: string[]; outputs: string[][] }

const fixture: { cases: Scenario[] } = JSON.parse(readFileSync(
  new URL('../../support/oracle/chrony-smooth-4.5.json', import.meta.url), 'utf8'));

function close(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(expected)));
}

describe('TimeSmoothing matches the compiled chrony 4.5 smooth.c', () => {
  for (const scenario of fixture.cases) {
    it(scenario.name, () => {
      const smoothing = new TimeSmoothing(
        Number(scenario.env.SMT_MAXFREQ ?? 400), Number(scenario.env.SMT_MAXWANDER ?? 0.5), scenario.env.SMT_LEAPONLY === '1');
      let skew = 1e-9;
      let answered = 0;
      for (const command of scenario.commands) {
        const [verb, a, b, c] = command.split(' ');
        const time = Number(a);
        switch (verb) {
          case 'skew': skew = time; break;
          case 'adjust': smoothing.adjust(time, Number(b), Number(c), skew); break;
          case 'activate': smoothing.activate(time); break;
          case 'reset': smoothing.reset(time); break;
          case 'leap': smoothing.leap(time, Number(b), skew); break;
          case 'offset': {
            close(smoothing.offsetAt(time), Number(scenario.outputs[answered++][0]));
            break;
          }
          case 'report': {
            const expected = scenario.outputs[answered++].map(Number);
            const report = smoothing.report(time);
            expect(report.active).toBe(expected[0] === 1);
            expect(report.leapOnly).toBe(expected[1] === 1);
            close(report.offset, expected[2]);
            close(report.frequencyPpm, expected[3]);
            close(report.wanderPpm, expected[4]);
            close(report.lastUpdateAgo, expected[5]);
            close(report.remainingTime, expected[6]);
            break;
          }
        }
      }
      expect(answered).toBe(scenario.outputs.length);
    });
  }
});
