import { Process, TerminalState } from './types';

// System processes that are always running
const SYSTEM_PROCESSES: Omit<Process, 'startTime'>[] = [
  { pid: 1, ppid: 0, user: 'root', command: '/sbin/init', state: 'S', cpu: 0.0, mem: 0.1, tty: '?' },
  { pid: 2, ppid: 0, user: 'root', command: '[kthreadd]', state: 'S', cpu: 0.0, mem: 0.0, tty: '?' },
  { pid: 10, ppid: 2, user: 'root', command: '[rcu_sched]', state: 'S', cpu: 0.0, mem: 0.0, tty: '?' },
  { pid: 11, ppid: 2, user: 'root', command: '[migration/0]', state: 'S', cpu: 0.0, mem: 0.0, tty: '?' },
  { pid: 100, ppid: 1, user: 'root', command: '/lib/systemd/systemd-journald', state: 'S', cpu: 0.1, mem: 0.5, tty: '?' },
  { pid: 120, ppid: 1, user: 'root', command: '/lib/systemd/systemd-udevd', state: 'S', cpu: 0.0, mem: 0.2, tty: '?' },
  { pid: 200, ppid: 1, user: 'root', command: '/usr/sbin/cron -f', state: 'S', cpu: 0.0, mem: 0.1, tty: '?' },
  { pid: 210, ppid: 1, user: 'syslog', command: '/usr/sbin/rsyslogd -n', state: 'S', cpu: 0.0, mem: 0.2, tty: '?' },
  { pid: 300, ppid: 1, user: 'root', command: '/usr/sbin/sshd -D', state: 'S', cpu: 0.0, mem: 0.2, tty: '?' },
];

export class ProcessManager {
  private processes: Map<number, Process> = new Map();
  private nextPid: number = 1000;
  private bootTime: Date;
  private shellPid: number = 0;
  private sshPid: number = 0;

  constructor() {
    this.bootTime = new Date();
    this.initSystemProcesses();
  }

  private initSystemProcesses(): void {
    // Add system processes
    for (const proc of SYSTEM_PROCESSES) {
      this.processes.set(proc.pid, {
        ...proc,
        startTime: this.bootTime,
      });
    }
  }

  /**
   * Initialize user session processes (called when terminal boots)
   */
  initUserSession(user: string, tty: string = 'pts/0'): number {
    // Create sshd session for user
    this.sshPid = this.nextPid++;
    this.processes.set(this.sshPid, {
      pid: this.sshPid,
      ppid: 300, // Main sshd
      user: 'root',
      command: `sshd: ${user}@${tty}`,
      state: 'S',
      cpu: 0.0,
      mem: 0.1,
      startTime: new Date(),
      tty,
    });

    // Create user shell
    this.shellPid = this.nextPid++;
    this.processes.set(this.shellPid, {
      pid: this.shellPid,
      ppid: this.sshPid,
      user,
      command: '-bash',
      state: 'S',
      cpu: 0.0,
      mem: 0.3,
      startTime: new Date(),
      tty,
    });

    return this.shellPid;
  }

  /**
   * Spawn a new process
   */
  spawn(command: string, user: string, tty: string = 'pts/0', ppid?: number): number {
    const pid = this.nextPid++;
    this.processes.set(pid, {
      pid,
      ppid: ppid ?? this.shellPid,
      user,
      command,
      state: 'R',
      cpu: Math.random() * 5,
      mem: Math.random() * 2,
      startTime: new Date(),
      tty,
    });
    return pid;
  }

  /**
   * Mark a process as complete (becomes zombie briefly then removed)
   */
  complete(pid: number): void {
    const proc = this.processes.get(pid);
    if (proc && proc.pid >= 1000) {
      // Don't remove system processes
      this.processes.delete(pid);
    }
  }

  /**
   * Kill a process
   */
  kill(pid: number, user: string, isRoot: boolean): { success: boolean; error?: string } {
    const proc = this.processes.get(pid);

    if (!proc) {
      return { success: false, error: `(${pid}) - No such process` };
    }

    // Can't kill init
    if (pid === 1) {
      return { success: false, error: `(${pid}) - Operation not permitted` };
    }

    // Check permissions
    if (proc.user !== user && !isRoot) {
      return { success: false, error: `(${pid}) - Operation not permitted` };
    }

    // Remove the process
    this.processes.delete(pid);
    return { success: true };
  }

  /**
   * Kill processes by name
   */
  killByName(name: string, user: string, isRoot: boolean): { killed: number; error?: string } {
    let killed = 0;
    const toKill: number[] = [];

    for (const [pid, proc] of this.processes) {
      if (proc.command.includes(name)) {
        if (proc.user === user || isRoot) {
          if (pid >= 1000 || isRoot) {
            toKill.push(pid);
          }
        }
      }
    }

    for (const pid of toKill) {
      this.processes.delete(pid);
      killed++;
    }

    if (killed === 0) {
      return { killed: 0, error: `${name}: no process found` };
    }

    return { killed };
  }

  /**
   * Find processes by pattern
   */
  findByPattern(pattern: string): Process[] {
    const results: Process[] = [];
    for (const proc of this.processes.values()) {
      if (proc.command.includes(pattern)) {
        results.push(proc);
      }
    }
    return results;
  }

  /**
   * Get all processes
   */
  getAll(): Process[] {
    // Update CPU/MEM for running processes to simulate activity
    for (const proc of this.processes.values()) {
      if (proc.state === 'R') {
        proc.cpu = Math.random() * 10;
        proc.mem = Math.random() * 5;
      } else if (proc.state === 'S') {
        // Sleeping processes have minimal activity
        proc.cpu = Math.random() * 0.5;
      }
    }
    return Array.from(this.processes.values()).sort((a, b) => a.pid - b.pid);
  }

  /**
   * Get processes for a specific user
   */
  getByUser(user: string): Process[] {
    return this.getAll().filter(p => p.user === user);
  }

  /**
   * Get processes attached to a TTY
   */
  getByTty(tty: string): Process[] {
    return this.getAll().filter(p => p.tty === tty);
  }

  /**
   * Get a specific process
   */
  get(pid: number): Process | undefined {
    return this.processes.get(pid);
  }

  /**
   * Get the current shell PID
   */
  getShellPid(): number {
    return this.shellPid;
  }

  /**
   * Get system uptime
   */
  getUptime(): { days: number; hours: number; minutes: number } {
    const now = new Date();
    const diff = now.getTime() - this.bootTime.getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    return { days, hours, minutes };
  }

  /**
   * Get process count by state
   */
  getProcessStats(): { total: number; running: number; sleeping: number; stopped: number; zombie: number } {
    let running = 0, sleeping = 0, stopped = 0, zombie = 0;

    for (const proc of this.processes.values()) {
      switch (proc.state) {
        case 'R': running++; break;
        case 'S': case 'D': sleeping++; break;
        case 'T': stopped++; break;
        case 'Z': zombie++; break;
      }
    }

    return { total: this.processes.size, running, sleeping, stopped, zombie };
  }

  /**
   * Get load average (simulated)
   */
  getLoadAverage(): [number, number, number] {
    const base = this.processes.size / 100;
    return [
      base + Math.random() * 0.5,
      base + Math.random() * 0.3,
      base + Math.random() * 0.2,
    ];
  }
}

// Singleton instance for the terminal
let globalProcessManager: ProcessManager | null = null;

export function getProcessManager(): ProcessManager {
  if (!globalProcessManager) {
    globalProcessManager = new ProcessManager();
  }
  return globalProcessManager;
}

export function resetProcessManager(): void {
  globalProcessManager = new ProcessManager();
}
