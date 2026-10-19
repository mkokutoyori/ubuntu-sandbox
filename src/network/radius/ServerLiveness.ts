export interface DeadCriteria {
  readonly timeSec: number;
  readonly tries: number;
}

export const DEFAULT_DEAD_CRITERIA: DeadCriteria = Object.freeze({ timeSec: 10, tries: 10 });

interface ServerRecord {
  consecutiveTransmissions: number;
  lastValidReplyAtMs: number | null;
  deadUntilMs: number | null;
  stateSinceMs: number | null;
  previousDurationMs: number;
  deadCount: number;
  deadTotalMs: number;
}

export interface LivenessView {
  readonly alive: boolean;
  readonly durationMs: number;
  readonly previousDurationMs: number;
  readonly deadCount: number;
  readonly deadTotalMs: number;
  readonly consecutiveTransmissions: number;
}

export class ServerLiveness {
  private readonly records = new Map<string, ServerRecord>();

  private recordOf(server: string): ServerRecord {
    let record = this.records.get(server);
    if (!record) {
      record = {
        consecutiveTransmissions: 0, lastValidReplyAtMs: null, deadUntilMs: null,
        stateSinceMs: null, previousDurationMs: 0, deadCount: 0, deadTotalMs: 0,
      };
      this.records.set(server, record);
    }
    return record;
  }

  private leaveDead(record: ServerRecord, nowMs: number): void {
    if (record.deadUntilMs === null) return;
    const since = record.stateSinceMs ?? nowMs;
    const spent = Math.max(0, Math.min(nowMs, record.deadUntilMs) - since);
    record.deadTotalMs += spent;
    record.previousDurationMs = spent;
    record.stateSinceMs = Math.min(nowMs, record.deadUntilMs);
    record.deadUntilMs = null;
  }

  recordValidReply(server: string, nowMs: number): void {
    const record = this.recordOf(server);
    record.consecutiveTransmissions = 0;
    record.lastValidReplyAtMs = nowMs;
    this.leaveDead(record, nowMs);
  }

  recordTimeout(
    server: string, transmissions: number, nowMs: number, criteria: DeadCriteria, deadtimeMinutes: number,
  ): void {
    const record = this.recordOf(server);
    record.consecutiveTransmissions += transmissions;
    if (deadtimeMinutes <= 0) return;
    const silentLongEnough = record.lastValidReplyAtMs === null
      || nowMs - record.lastValidReplyAtMs >= criteria.timeSec * 1000;
    if (silentLongEnough && record.consecutiveTransmissions >= criteria.tries && record.deadUntilMs === null) {
      record.previousDurationMs = Math.max(0, nowMs - (record.stateSinceMs ?? nowMs));
      record.stateSinceMs = nowMs;
      record.deadUntilMs = nowMs + deadtimeMinutes * 60_000;
      record.deadCount += 1;
    }
  }

  isDead(server: string, nowMs: number): boolean {
    const record = this.records.get(server);
    if (!record || record.deadUntilMs === null) return false;
    if (nowMs >= record.deadUntilMs) {
      this.leaveDead(record, nowMs);
      record.consecutiveTransmissions = 0;
      return false;
    }
    return true;
  }

  deadForMs(server: string, nowMs: number): number {
    const record = this.records.get(server);
    return record?.deadUntilMs != null ? Math.max(0, record.deadUntilMs - nowMs) : 0;
  }

  view(server: string, nowMs: number, configuredAtMs: number): LivenessView {
    const dead = this.isDead(server, nowMs);
    const record = this.records.get(server);
    const since = record?.stateSinceMs ?? configuredAtMs;
    const deadSoFar = record ? record.deadTotalMs + (dead ? Math.max(0, nowMs - (record.stateSinceMs ?? nowMs)) : 0) : 0;
    return {
      alive: !dead,
      durationMs: Math.max(0, nowMs - since),
      previousDurationMs: record?.previousDurationMs ?? 0,
      deadCount: record?.deadCount ?? 0,
      deadTotalMs: deadSoFar,
      consecutiveTransmissions: record?.consecutiveTransmissions ?? 0,
    };
  }

  forget(server: string): void {
    this.records.delete(server);
  }
}
