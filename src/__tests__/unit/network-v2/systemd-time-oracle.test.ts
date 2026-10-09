/*
 * Oracle: systemd 255.4 time parsing (Ubuntu 24.04 binary).  scripts/oracle/record_systemd_time.py runs
 * `systemd-analyze timestamp` (parse_timestamp then format_timestamp_style PRETTY) under scripts/oracle/last_shim.c with
 * the clock and TZ pinned, and `systemd-analyze timespan` (parse_sec).  The same inputs are replayed through
 * parseTimestamp / formatTimestamp / parseSec.  Measured before the port (module absent, git stash push -u -- src/network):
 * every case falls.  Not covered: a trailing zone-file name (Europe/Paris, CET...).  parse_timestamp forks a child that
 * sets TZ and the binary of this recording VM answers EINVAL for every such input, even with TZ set to the same zone, so
 * that branch is implemented from the source and has no witness here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { formatTimespan, parseSec, parseTimestamp, formatTimestamp, systemdClock } from '@/network/devices/linux/systemd/SystemdTime';

interface Recorded {
  stdout: string;
  stderr: string;
  exitCode: number;
}
interface StampCase extends Recorded {
  zone: string;
  text: string;
}
interface SpanCase extends Recorded {
  text: string;
}

const fixture = JSON.parse(readFileSync('src/__tests__/support/oracle/audit-tools/systemd-time-255.4.json', 'utf8')) as { now: number; timestamps: StampCase[]; timespans: SpanCase[] };
const text = (value: string): string => Buffer.from(value, 'base64').toString('utf8');

function endsWithZoneFile(input: string, zone: string): boolean {
  const space = input.lastIndexOf(' ');
  if (space < 0) return false;
  const last = input.slice(space + 1);
  const clock = systemdClock(zone);
  return last !== 'UTC' && clock.zoneByName(last) !== null && !/^[+-]\d/.test(last) && last !== 'Z';
}

describe('parse_timestamp and format_timestamp_style against systemd-analyze timestamp', () => {
  const nowUsec = fixture.now * 1_000_000;
  const cases = fixture.timestamps.filter(c => !endsWithZoneFile(c.text, c.zone));
  it('covers a witness set', () => {
    expect(cases.length).toBeGreaterThan(700);
    expect(cases.filter(c => c.exitCode === 0).length).toBeGreaterThan(400);
    expect(cases.filter(c => c.exitCode !== 0).length).toBeGreaterThan(60);
  });
  for (const recorded of cases) {
    it(`${recorded.zone} ${JSON.stringify(recorded.text)}`, () => {
      const clock = systemdClock(recorded.zone);
      const parsed = parseTimestamp(recorded.text, nowUsec, clock);
      if (recorded.exitCode !== 0) {
        expect(parsed).toBeNull();
        return;
      }
      const unix = /UNIX seconds: @(\d+)(?:\.(\d{6}))?/.exec(text(recorded.stdout));
      const expectedUsec = Number(unix![1]) * 1_000_000 + (unix![2] ? Number(unix![2]) : 0);
      expect(parsed).toBe(expectedUsec);
      const normalized = /Normalized form: (.*)/.exec(text(recorded.stdout))![1];
      const formatted = formatTimestamp(parsed!, 'pretty', clock);
      expect(formatted === null ? '-' : formatted.replace(/\.\d{6}/, '')).toBe(normalized);
    });
  }
});

describe('parse_sec against systemd-analyze timespan', () => {
  for (const recorded of fixture.timespans) {
    it(JSON.stringify(recorded.text), () => {
      const parsed = parseSec(recorded.text);
      if (recorded.exitCode !== 0) {
        expect(parsed.ok).toBe(false);
        return;
      }
      const expected = /us: (\d+)/.exec(text(recorded.stdout))![1];
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.usec === Number.POSITIVE_INFINITY ? '18446744073709551615' : String(parsed.usec)).toBe(expected);
        expect(formatTimespan(parsed.usec, 0)).toBe(/Human: (.*)/.exec(text(recorded.stdout))![1]);
      }
    });
  }
});
