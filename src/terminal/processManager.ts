/**
 * STUB FILE - will be rebuilt with TDD
 * Process manager for terminal sessions
 */

export interface Process {
  pid: number;
  command: string;
  status: 'running' | 'stopped' | 'zombie';
  startTime: number;
}

export class ProcessManager {
  private processes: Map<number, Process> = new Map();
  private nextPid: number = 1000;

  createProcess(command: string): Process {
    const process: Process = {
      pid: this.nextPid++,
      command,
      status: 'running',
      startTime: Date.now()
    };
    this.processes.set(process.pid, process);
    return process;
  }

  getProcess(pid: number): Process | undefined {
    return this.processes.get(pid);
  }

  killProcess(pid: number): boolean {
    return this.processes.delete(pid);
  }

  listProcesses(): Process[] {
    return Array.from(this.processes.values());
  }

  reset(): void {
    this.processes.clear();
    this.nextPid = 1000;
  }
}

const processManagers: Map<string, ProcessManager> = new Map();

export function getProcessManager(deviceId: string): ProcessManager {
  if (!processManagers.has(deviceId)) {
    processManagers.set(deviceId, new ProcessManager());
  }
  return processManagers.get(deviceId)!;
}

export function resetProcessManager(deviceId: string): void {
  const manager = processManagers.get(deviceId);
  if (manager) {
    manager.reset();
  }
}
