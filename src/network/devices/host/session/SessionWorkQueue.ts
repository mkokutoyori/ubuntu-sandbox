/**
 * SessionWorkQueue — per-device FIFO serialising session-scoped work.
 *
 * Both LinuxMachine and WindowsPC briefly pin a terminal session's state
 * onto device-wide mutable fields (cwd/env/user…) while a command runs.
 * Two terminals doing this concurrently would race on the swap window,
 * so every session-scoped task goes through this queue: tasks run one
 * at a time, in arrival order, and a failed task never blocks the next.
 */
export class SessionWorkQueue {
  private tail: Promise<unknown> = Promise.resolve();

  /**
   * Enqueue a task behind every previously enqueued one.
   * Returns the task's own promise (rejections propagate to the caller
   * but are swallowed on the internal chain so the queue keeps draining).
   */
  run<T>(task: () => Promise<T> | T): Promise<T> {
    const next = this.tail.then(task, task) as Promise<T>;
    this.tail = next.catch(() => undefined);
    return next;
  }
}
