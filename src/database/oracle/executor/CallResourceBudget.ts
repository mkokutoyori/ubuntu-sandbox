export interface ResourceCosts {
  readonly cpuPerSession: number;
  readonly logicalReadsPerSession: number;
  readonly connectTime: number;
  readonly privateSga: number;
}

export interface ResourceLimits {
  readonly cpuPerCallMs: number;
  readonly cpuPerSessionMs: number;
  readonly logicalReadsPerCall: number;
  readonly logicalReadsPerSession: number;
  readonly compositeLimit: number;
  readonly costs: ResourceCosts;
}

export interface ExceededLimit {
  readonly code: number;
  readonly message: string;
  readonly logoff: boolean;
}

export class SessionResourceMeter {
  cpuMs = 0;
  logicalReads = 0;
}

export class CallResourceBudget {
  private activeMs = 0;
  private activeSince: number | null;
  private callReads = 0;
  private tripped = new Set<number>();

  constructor(
    private readonly limits: ResourceLimits,
    private readonly session: SessionResourceMeter,
    private readonly now: () => number,
    private readonly connectedMinutes: () => number,
  ) {
    this.activeSince = now();
  }

  noteLogicalReads(blocks: number): void {
    this.callReads += blocks;
  }

  suspend(): void {
    if (this.activeSince === null) return;
    this.activeMs += this.now() - this.activeSince;
    this.activeSince = null;
  }

  resume(): void {
    if (this.activeSince === null) this.activeSince = this.now();
  }

  private elapsed(): number {
    return this.activeMs + (this.activeSince === null ? 0 : this.now() - this.activeSince);
  }

  close(): void {
    this.session.cpuMs += this.elapsed();
    this.session.logicalReads += this.callReads;
  }

  evaluate(): ExceededLimit | null {
    const elapsed = this.elapsed();
    const sessionCpuMs = this.session.cpuMs + elapsed;
    const sessionReads = this.session.logicalReads + this.callReads;
    const { limits } = this;
    if (elapsed > limits.cpuPerCallMs) {
      return this.trip(2393, 'exceeded call limit on CPU usage', false);
    }
    if (this.callReads > limits.logicalReadsPerCall) {
      return this.trip(2395, 'exceeded call limit on IO usage', false);
    }
    if (sessionCpuMs > limits.cpuPerSessionMs) {
      return this.trip(2392, 'exceeded session limit on CPU usage, you are being logged off', true);
    }
    if (sessionReads > limits.logicalReadsPerSession) {
      return this.trip(2394, 'exceeded session limit on IO usage, you are being logged off', true);
    }
    if (Number.isFinite(limits.compositeLimit)) {
      const { costs } = limits;
      const units = (sessionCpuMs / 10) * costs.cpuPerSession
        + sessionReads * costs.logicalReadsPerSession
        + this.connectedMinutes() * costs.connectTime;
      if (units > limits.compositeLimit) {
        return this.trip(2397, 'exceeded composite limit, you are being logged off', true);
      }
    }
    return null;
  }

  private trip(code: number, message: string, logoff: boolean): ExceededLimit | null {
    if (this.tripped.has(code)) return null;
    this.tripped.add(code);
    return { code, message, logoff };
  }
}
