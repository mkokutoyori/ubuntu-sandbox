import { SshAgent } from '../SshAgent';

export interface AgentProcess {
  readonly pid: number;
  readonly socket: string;
  readonly uid: number;
  readonly agent: SshAgent;
}

export class AgentProcessTable {
  private readonly processes = new Map<number, AgentProcess>();

  start(pid: number, socket: string, uid: number, defaultLifetimeSeconds: number | null): AgentProcess {
    const process = { pid, socket, uid, agent: new SshAgent(defaultLifetimeSeconds) };
    this.processes.set(pid, process);
    return process;
  }

  atSocket(socket: string): AgentProcess | undefined {
    for (const process of this.processes.values()) if (process.socket === socket) return process;
    return undefined;
  }

  withPid(pid: number): AgentProcess | undefined {
    return this.processes.get(pid);
  }

  stop(pid: number): boolean {
    return this.processes.delete(pid);
  }
}
