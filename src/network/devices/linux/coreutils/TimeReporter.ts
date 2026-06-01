/**
 * Bash builtin `time` — wall/user/sys reporter.
 *
 * The simulator dispatches commands synchronously, so user/sys are
 * synthetic (we report a small token cost) and `real` is wall-clock
 * elapsed between `dispatch` enter and exit. We emit two output
 * formats:
 *
 *   default  →   `\nreal\t0m0.123s\nuser\t0m0.001s\nsys\t0m0.001s`
 *   posix    →   `\nreal 0.123\nuser 0.001\nsys 0.001`        (TIMEFORMAT=POSIX)
 */

export interface TimeMeasurement {
  realMs: number;
  userMs: number;
  sysMs: number;
}

export type TimeFormat = 'bash' | 'posix';

/** Render `time`'s trailing block for the given measurement. */
export function formatTimes(m: TimeMeasurement, format: TimeFormat = 'bash'): string {
  if (format === 'posix') {
    return [
      '',
      `real ${(m.realMs / 1000).toFixed(2)}`,
      `user ${(m.userMs / 1000).toFixed(2)}`,
      `sys ${(m.sysMs / 1000).toFixed(2)}`,
    ].join('\n');
  }
  const fmt = (ms: number) => {
    const totalSec = ms / 1000;
    const min = Math.floor(totalSec / 60);
    const sec = totalSec - min * 60;
    return `${min}m${sec.toFixed(3)}s`;
  };
  return ['', `real\t${fmt(m.realMs)}`, `user\t${fmt(m.userMs)}`, `sys\t${fmt(m.sysMs)}`].join('\n');
}

/** Measure a synchronous closure and return its result plus timings. */
export function measure<T>(work: () => T): { result: T; timing: TimeMeasurement } {
  const t0 = Date.now();
  const result = work();
  const realMs = Date.now() - t0;
  return { result, timing: { realMs, userMs: 1, sysMs: 1 } };
}

/** Pick the format from the live env (`TIMEFORMAT=POSIX` → posix). */
export function chooseTimeFormat(env: Record<string, string> | undefined): TimeFormat {
  const tf = env?.['TIMEFORMAT'];
  return tf && /posix/i.test(tf) ? 'posix' : 'bash';
}
