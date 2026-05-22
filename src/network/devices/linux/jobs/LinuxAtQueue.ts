/**
 * LinuxAtQueue — the `at` deferred-job spool and its query commands.
 *
 * `at` schedules a one-shot command for later execution; `atd` is the daemon
 * that runs due jobs. This models the spool (`/var/spool/cron/atjobs`): each
 * job carries the full record a real `atq` line shows — id, run time, queue
 * letter and owner — even though the simulator does not fire jobs on a timer.
 *
 * `at` refuses to queue anything while `atd` is stopped, exactly as on a
 * real host (it cannot signal the daemon's pidfile).
 */

/** One spooled `at` job. */
export interface AtJob {
  readonly id: number;
  readonly runAt: Date;
  readonly command: string;
  readonly user: string;
  /** Queue letter — `a` for `at`, `b` for `batch` (lower = higher priority). */
  readonly queue: string;
}

export class LinuxAtQueue {
  private readonly jobs = new Map<number, AtJob>();
  private nextId = 1;

  /** Spool a new job, returning the assigned record. */
  enqueue(command: string, user: string, runAt: Date, queue = 'a'): AtJob {
    const job: AtJob = { id: this.nextId++, runAt, command, user, queue };
    this.jobs.set(job.id, job);
    return job;
  }

  /** Every spooled job, ordered by run time. */
  list(): AtJob[] {
    return [...this.jobs.values()].sort((a, b) => a.runAt.getTime() - b.runAt.getTime());
  }

  get(id: number): AtJob | undefined {
    return this.jobs.get(id);
  }

  /** Remove a job by id. Returns true when it existed. */
  remove(id: number): boolean {
    return this.jobs.delete(id);
  }
}

/** Daemon-down diagnostic — the exact line real `at` prints. */
const ATD_DOWN = "Can't open /var/run/atd.pid to signal atd. No atd running?";

/**
 * Parse an `at` time specification. Supports `now`, `now + N unit` and a bare
 * `HH:MM`. Falls back to "now" for anything unrecognised — `at` is lenient.
 */
export function parseAtTime(spec: string, base: Date = new Date()): Date {
  const text = spec.trim().toLowerCase();
  const rel = text.match(/now\s*\+\s*(\d+)\s*(minute|minutes|hour|hours|day|days)/);
  if (rel) {
    const n = Number(rel[1]);
    const unitMs =
      rel[2].startsWith('minute') ? 60_000 :
      rel[2].startsWith('hour') ? 3_600_000 : 86_400_000;
    return new Date(base.getTime() + n * unitMs);
  }
  const hhmm = text.match(/^(\d{1,2}):(\d{2})$/);
  if (hhmm) {
    const d = new Date(base);
    d.setHours(Number(hhmm[1]), Number(hhmm[2]), 0, 0);
    if (d.getTime() <= base.getTime()) d.setDate(d.getDate() + 1);
    return d;
  }
  return new Date(base);
}

/** Format a job run time the way `atq` does (`Wed May 22 10:05:00 2026`). */
function fmtAtqDate(d: Date): string {
  return d.toDateString().replace(/(\w{3}) (\w{3}) (\d+) (\d{4})/, '$1 $2 $3') +
    ` ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:00 ${d.getFullYear()}`;
}

/**
 * `at` — schedule the command read from stdin. Refuses when `atd` is down.
 */
export function cmdAt(
  queue: LinuxAtQueue,
  args: string[],
  stdin: string,
  user: string,
  atdRunning: boolean,
): string {
  if (!atdRunning) return ATD_DOWN;

  const command = stdin.trim();
  if (!command) return 'at: no command to schedule';

  const timeSpec = args.filter((a) => !a.startsWith('-')).join(' ') || 'now';
  const runAt = parseAtTime(timeSpec);
  const job = queue.enqueue(command, user, runAt);
  return `job ${job.id} at ${fmtAtqDate(runAt)}`;
}

/** `atq` — list the spooled jobs (`id  date  queue  user`). */
export function cmdAtq(queue: LinuxAtQueue): string {
  return queue.list()
    .map((j) => `${j.id}\t${fmtAtqDate(j.runAt)} ${j.queue} ${j.user}`)
    .join('\n');
}

/** `atrm` — remove one or more spooled jobs by id. */
export function cmdAtrm(queue: LinuxAtQueue, args: string[]): string {
  const errors: string[] = [];
  for (const arg of args) {
    const id = parseInt(arg, 10);
    if (Number.isNaN(id)) continue;
    if (!queue.remove(id)) errors.push(`Cannot find jobid ${id}`);
  }
  return errors.join('\n');
}
