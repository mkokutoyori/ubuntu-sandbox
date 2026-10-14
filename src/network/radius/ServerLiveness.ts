export interface DeadCriteria {
  readonly timeSec: number;
  readonly tries: number;
}

export const DEFAULT_DEAD_CRITERIA: DeadCriteria = Object.freeze({ timeSec: 10, tries: 10 });

interface ServerRecord {
  consecutiveTransmissions: number;
  lastValidReplyAtMs: number | null;
  deadUntilMs: number | null;
}

export class ServerLiveness {
  private readonly records = new Map<string, ServerRecord>();

  private recordOf(server: string): ServerRecord {
    let record = this.records.get(server);
    if (!record) {
      record = { consecutiveTransmissions: 0, lastValidReplyAtMs: null, deadUntilMs: null };
      this.records.set(server, record);
    }
    return record;
  }

  recordValidReply(server: string, nowMs: number): void {
    const record = this.recordOf(server);
    record.consecutiveTransmissions = 0;
    record.lastValidReplyAtMs = nowMs;
    record.deadUntilMs = null;
  }

  recordTimeout(
    server: string, transmissions: number, nowMs: number, criteria: DeadCriteria, deadtimeMinutes: number,
  ): void {
    const record = this.recordOf(server);
    record.consecutiveTransmissions += transmissions;
    if (deadtimeMinutes <= 0) return;
    const silentLongEnough = record.lastValidReplyAtMs === null
      || nowMs - record.lastValidReplyAtMs >= criteria.timeSec * 1000;
    if (silentLongEnough && record.consecutiveTransmissions >= criteria.tries) {
      record.deadUntilMs = nowMs + deadtimeMinutes * 60_000;
    }
  }

  isDead(server: string, nowMs: number): boolean {
    const record = this.records.get(server);
    if (!record || record.deadUntilMs === null) return false;
    if (nowMs >= record.deadUntilMs) {
      record.deadUntilMs = null;
      record.consecutiveTransmissions = 0;
      return false;
    }
    return true;
  }

  deadForMs(server: string, nowMs: number): number {
    const record = this.records.get(server);
    return record?.deadUntilMs != null ? Math.max(0, record.deadUntilMs - nowMs) : 0;
  }

  forget(server: string): void {
    this.records.delete(server);
  }
}
