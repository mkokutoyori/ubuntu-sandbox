/**
 * SshConnectionThrottler — per-host counter that enforces OpenSSH's
 * `MaxStartups <start>:<rate>:<full>` directive.
 *
 * Real sshd tracks "unauthenticated connections in progress" and:
 *   • below `start`           — every new connection is accepted
 *   • between `start` and `full` — accepts with probability decreasing
 *                                  with the count (the `rate` percent)
 *   • at or above `full`      — every new connection is dropped
 *
 * The simulator's audit is per-source-IP rapid-fire failure counter:
 * after `full` consecutive failed attempts inside the observation
 * window, subsequent attempts are dropped before authentication. The
 * model still surfaces the OpenSSH "drop" semantics the test suite
 * checks for ("Connection refused", "drop", "too many").
 */

export interface MaxStartupsCfg {
  readonly start: number;
  readonly rate: number;
  readonly full: number;
}

const OBSERVATION_WINDOW_MS = 60_000;

export class SshConnectionThrottler {
  private readonly failuresByIp = new Map<string, number[]>();

  /** Record one failed auth attempt for an originating IP. */
  recordFailure(ip: string, now: number): void {
    const arr = this.failuresByIp.get(ip) ?? [];
    arr.push(now);
    this.prune(arr, now);
    this.failuresByIp.set(ip, arr);
  }

  /** Drop all remembered attempts for an IP (typically after a success). */
  reset(ip: string): void {
    this.failuresByIp.delete(ip);
  }

  /**
   * Whether sshd would drop this connection right now under the given
   * MaxStartups configuration. We model the "full" threshold as a hard
   * cap on recent failed attempts inside the observation window.
   */
  shouldDrop(ip: string, cfg: MaxStartupsCfg, now: number): boolean {
    const arr = this.failuresByIp.get(ip);
    if (!arr) return false;
    this.prune(arr, now);
    return arr.length >= cfg.full;
  }

  private prune(arr: number[], now: number): void {
    while (arr.length > 0 && now - arr[0] > OBSERVATION_WINDOW_MS) arr.shift();
  }
}
