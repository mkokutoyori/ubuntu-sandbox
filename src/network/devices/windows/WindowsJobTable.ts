export interface WindowsJob {
  id: number;
  name: string;
  output: unknown[];
  durationMs: number;
  startedAt: number;
  completesAt: number;
}

export class WindowsJobTable {
  private readonly jobs = new Map<number, WindowsJob>();
  private nextId = 1;
  private recording = false;
  private recordedMs = 0;

  beginRecording(): void {
    this.recording = true;
    this.recordedMs = 0;
  }

  recordSleep(ms: number): void {
    if (this.recording && ms > 0) this.recordedMs += ms;
  }

  endRecording(): number {
    const total = this.recordedMs;
    this.recording = false;
    this.recordedMs = 0;
    return total;
  }

  add(name: string | undefined, output: unknown[], durationMs: number, now: number): WindowsJob {
    const id = this.nextId++;
    const job: WindowsJob = {
      id,
      name: name && name.length > 0 ? name : `Job${id}`,
      output,
      durationMs,
      startedAt: now,
      completesAt: now + durationMs,
    };
    this.jobs.set(id, job);
    return job;
  }

  list(): WindowsJob[] {
    return [...this.jobs.values()].sort((a, b) => a.id - b.id);
  }

  get(id: number): WindowsJob | undefined {
    return this.jobs.get(id);
  }

  getByName(name: string): WindowsJob | undefined {
    const lc = name.toLowerCase();
    return this.list().find((j) => j.name.toLowerCase() === lc);
  }

  remove(id: number): boolean {
    return this.jobs.delete(id);
  }
}
