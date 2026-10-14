export type CounterPhase = 'authentication' | 'accounting';

export interface PhaseCounters {
  requests: number;
  timeouts: number;
  retransmissions: number;
  failovers: number;
  accepts: number;
  rejects: number;
  challenges: number;
  unexpected: number;
  incorrect: number;
  serverErrors: number;
  lastResponseMs: number;
  transactionSuccess: number;
  transactionFailure: number;
  starts: number;
  interims: number;
  stops: number;
  startResponses: number;
  interimResponses: number;
  stopResponses: number;
}

export interface ServerCountersSnapshot {
  authentication: Readonly<PhaseCounters>;
  accounting: Readonly<PhaseCounters>;
  clearedAtMs: number;
}

export function emptyPhase(): PhaseCounters {
  return {
    requests: 0, timeouts: 0, retransmissions: 0, failovers: 0,
    accepts: 0, rejects: 0, challenges: 0, unexpected: 0, incorrect: 0,
    serverErrors: 0, lastResponseMs: 0, transactionSuccess: 0, transactionFailure: 0,
    starts: 0, interims: 0, stops: 0, startResponses: 0, interimResponses: 0, stopResponses: 0,
  };
}

interface ServerEntry {
  authentication: PhaseCounters;
  accounting: PhaseCounters;
  clearedAtMs: number;
}

export class ServerCounters {
  private readonly servers = new Map<string, ServerEntry>();

  constructor(private readonly nowMs: () => number) {}

  private entryOf(address: string): ServerEntry {
    let entry = this.servers.get(address);
    if (!entry) {
      entry = { authentication: emptyPhase(), accounting: emptyPhase(), clearedAtMs: this.nowMs() };
      this.servers.set(address, entry);
    }
    return entry;
  }

  phase(address: string, phase: CounterPhase): PhaseCounters {
    return this.entryOf(address)[phase];
  }

  snapshot(address: string): ServerCountersSnapshot {
    const entry = this.entryOf(address);
    return {
      authentication: { ...entry.authentication },
      accounting: { ...entry.accounting },
      clearedAtMs: entry.clearedAtMs,
    };
  }

  clear(address?: string): void {
    const targets = address === undefined ? [...this.servers.keys()] : [address];
    for (const target of targets) {
      this.servers.set(target, {
        authentication: emptyPhase(), accounting: emptyPhase(), clearedAtMs: this.nowMs(),
      });
    }
  }

  forget(address: string): void {
    this.servers.delete(address);
  }

  addresses(): string[] {
    return [...this.servers.keys()];
  }
}
