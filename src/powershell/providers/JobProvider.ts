import { JobTable } from './JobTable';
import type { Job } from './JobTable';
import type { IJobProvider, JobInfo } from './PSProviders';

export interface JobClock {
  now(): number;
  advance(ms: number): void;
}

class InternalJobClock implements JobClock {
  private ms = 0;
  now(): number { return this.ms; }
  advance(ms: number): void { if (ms > 0) this.ms += ms; }
}

export class JobProvider implements IJobProvider {
  private readonly table = new JobTable();
  private readonly clock: JobClock;

  constructor(clock?: JobClock) {
    this.clock = clock ?? new InternalJobClock();
  }

  private toInfo(job: Job): JobInfo {
    const completed = this.clock.now() >= job.completesAt;
    return {
      id: job.id,
      name: job.name,
      state: completed ? 'Completed' : 'Running',
      hasMoreData: completed,
      output: job.output,
    };
  }

  private resolve(idOrName: string | number): Job | undefined {
    if (typeof idOrName === 'number') return this.table.get(idOrName);
    const n = Number(idOrName);
    return Number.isFinite(n) && String(n) === String(idOrName).trim()
      ? this.table.get(n)
      : this.table.getByName(idOrName);
  }

  beginRecording(): void { this.table.beginRecording(); }
  recordSleep(ms: number): void { this.table.recordSleep(ms); }
  endRecording(): number { return this.table.endRecording(); }

  startJob(name: string | undefined, output: unknown[], durationMs: number): JobInfo {
    return this.toInfo(this.table.add(name, output, durationMs, this.clock.now()));
  }
  listJobs(): JobInfo[] {
    return this.table.list().map((j) => this.toInfo(j));
  }
  getJob(idOrName: string | number): JobInfo | null {
    const job = this.resolve(idOrName);
    return job ? this.toInfo(job) : null;
  }
  receiveJob(idOrName: string | number): unknown[] {
    const job = this.resolve(idOrName);
    return job ? job.output : [];
  }
  waitJob(idOrName: string | number): JobInfo | null {
    const job = this.resolve(idOrName);
    if (!job) return null;
    const delta = job.completesAt - this.clock.now();
    if (delta > 0) this.clock.advance(delta);
    return this.toInfo(job);
  }
}
