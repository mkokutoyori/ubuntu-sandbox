/**
 * GNU `sleep` — duration parser and (simulated) non-blocking wait.
 *
 * The simulator is synchronous so we never actually sleep, but we do
 * fully parse the duration so scripts using arithmetic or multi-arg
 * forms exit with the right code and the requested-wait-time is
 * observable for telemetry/tests.
 *
 * Accepts: `NUMBER[SUFFIX]…` where SUFFIX ∈ {s, m, h, d}. Multiple
 * operands are summed (`sleep 1 0.5 2m` → 121.5s).
 */

export interface SleepResult {
  output: string;
  exitCode: number;
  /** Total requested wait in seconds; never blocked on. */
  seconds: number;
}

const FACTORS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

/**
 * Parse a single `NUMBER[SUFFIX]` operand. Throws `SleepError` on
 * malformed input so the executor can render the canonical
 * `sleep: invalid time interval ‘x’` message and exit 1.
 */
export function parseSleepOperand(token: string): number {
  const m = /^(\d+(?:\.\d+)?|\.\d+)([smhd]?)$/.exec(token);
  if (!m) throw new SleepError(token);
  const n = Number.parseFloat(m[1]);
  const factor = FACTORS[m[2] || 's'];
  return n * factor;
}

export class SleepError extends Error {
  constructor(public readonly badToken: string) { super(`invalid time interval '${badToken}'`); }
}

export function runSleep(args: readonly string[]): SleepResult {
  const ops = args.filter(a => !a.startsWith('-'));
  if (ops.length === 0) {
    return { output: 'sleep: missing operand', exitCode: 1, seconds: 0 };
  }
  let total = 0;
  for (const op of ops) {
    try { total += parseSleepOperand(op); }
    catch (e) {
      const msg = e instanceof SleepError
        ? `sleep: invalid time interval '${e.badToken}'`
        : 'sleep: invalid time interval';
      return { output: msg, exitCode: 1, seconds: 0 };
    }
  }
  return { output: '', exitCode: 0, seconds: total };
}
