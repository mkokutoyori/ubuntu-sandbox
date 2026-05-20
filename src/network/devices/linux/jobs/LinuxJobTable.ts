/**
 * LinuxJobTable — per-shell job control table.
 *
 * Tracks background jobs spawned with `cmd &`. Mirrors bash semantics:
 *   - Each job has a monotonically incremented id (1, 2, 3...).
 *   - The most recently spawned (or fg'd → bg'd) job is "current" (%+),
 *     the previous one is "previous" (%-).
 *   - Jobs are removed when killed, fg'd to completion, or disowned.
 *
 * The table does NOT execute commands itself; it is a registry. The
 * shell decides what to actually run and when to remove entries.
 */
import { LinuxJob, type JobState, type LinuxJobInit } from './LinuxJob';

export { LinuxJob };
export type { JobState };

/**
 * Backwards-compatible alias: external consumers used to import
 * `JobEntry` from this module. The rich {@link LinuxJob} class now
 * fills the role; keep the name as a structural type export.
 */
export type JobEntry = LinuxJob;

export class LinuxJobTable {
  private jobs = new Map<number, LinuxJob>();
  private nextId = 1;
  private currentId: number | null = null;
  private previousId: number | null = null;

  /** Register a freshly spawned background job. Returns the LinuxJob. */
  add(pid: number, command: string, state: JobState = 'Running', extra: Partial<LinuxJobInit> = {}): LinuxJob {
    const id = this.nextId++;
    const job = new LinuxJob({ id, pid, command, state, ...extra });
    this.jobs.set(id, job);
    this.previousId = this.currentId;
    this.currentId = id;
    return job;
  }

  get(id: number): LinuxJob | undefined {
    return this.jobs.get(id);
  }

  /** All jobs ordered by id. */
  list(): LinuxJob[] {
    return Array.from(this.jobs.values()).sort((a, b) => a.id - b.id);
  }

  /** Remove a job by id; updates current/previous. */
  remove(id: number): boolean {
    if (!this.jobs.delete(id)) return false;
    if (this.currentId === id) {
      this.currentId = this.previousId;
      this.previousId = this.peekPrevious();
    } else if (this.previousId === id) {
      this.previousId = this.peekPrevious();
    }
    if (this.jobs.size === 0) this.nextId = 1;
    return true;
  }

  /** Make `id` the current job (used by fg/bg). */
  promote(id: number): void {
    if (!this.jobs.has(id) || this.currentId === id) return;
    this.previousId = this.currentId;
    this.currentId = id;
  }

  isCurrent(id: number): boolean { return this.currentId === id; }
  isPrevious(id: number): boolean { return this.previousId === id; }

  /**
   * Resolve a bash jobspec — %N, %+, %-, %% — to a job entry. Returns
   * null when no match (caller emits "no such job").
   */
  resolve(spec: string): JobEntry | null {
    if (!spec.startsWith('%')) return null;
    const rest = spec.slice(1);
    if (rest === '' || rest === '+' || rest === '%') {
      return this.currentId !== null ? this.jobs.get(this.currentId) ?? null : null;
    }
    if (rest === '-') {
      return this.previousId !== null ? this.jobs.get(this.previousId) ?? null : null;
    }
    if (/^\d+$/.test(rest)) {
      return this.jobs.get(parseInt(rest, 10)) ?? null;
    }
    return null;
  }

  private peekPrevious(): number | null {
    // Pick the highest id that isn't the current one.
    const ids = Array.from(this.jobs.keys())
      .filter(i => i !== this.currentId)
      .sort((a, b) => b - a);
    return ids[0] ?? null;
  }
}
