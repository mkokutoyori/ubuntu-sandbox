export type LockMode = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export type LockType = 'TM' | 'TX' | 'UL';

export const LOCK_MODE_NAMES: Record<LockMode, string> = {
  0: 'None', 1: 'Null', 2: 'Row-S (SS)', 3: 'Row-X (SX)',
  4: 'Share', 5: 'S/Row-X (SSX)', 6: 'Exclusive',
};

const CONFLICT: boolean[][] = [
  [false, false, false, false, false, false, false],
  [false, false, false, false, false, false, false],
  [false, false, false, false, false, false, true],
  [false, false, false, false, true,  true,  true],
  [false, false, false, true,  false, true,  true],
  [false, false, false, true,  true,  true,  true],
  [false, false, true,  true,  true,  true,  true],
];

export function modesConflict(held: LockMode, requested: LockMode): boolean {
  return CONFLICT[held][requested];
}

export interface HeldLock {
  sessionId: string;
  sid: number;
  type: LockType;
  id1: number;
  id2: number;
  lmode: LockMode;
  request: LockMode;
  schema: string;
  table: string;
  txId: number | null;
  acquiredAt: number;
}

export class DeadlockError extends Error {
  constructor(public readonly cycle: string[]) {
    super('ORA-00060: deadlock detected while waiting for resource');
    this.name = 'DeadlockError';
  }
}

export class ResourceBusyError extends Error {
  constructor() {
    super('ORA-00054: resource busy and acquire with NOWAIT specified or timeout expired');
    this.name = 'ResourceBusyError';
  }
}

export class LockManager {
  private held: HeldLock[] = [];
  private waits = new Map<string, string>();
  /** Row-level TX locks: "SCHEMA.TABLE:rowKey" → owning sessionId. */
  private rowLocks = new Map<string, string>();

  private rowKeyFor(schema: string, table: string, key: string): string {
    return `${schema.toUpperCase()}.${table.toUpperCase()}:${key}`;
  }

  /** Who holds the row lock (undefined = free). */
  rowLockHolder(schema: string, table: string, key: string): string | undefined {
    return this.rowLocks.get(this.rowKeyFor(schema, table, key));
  }

  /** Acquire a row lock (re-entrant for the same session). */
  acquireRowLock(sessionId: string, schema: string, table: string, key: string): boolean {
    const k = this.rowKeyFor(schema, table, key);
    const holder = this.rowLocks.get(k);
    if (holder !== undefined && holder !== sessionId) return false;
    this.rowLocks.set(k, sessionId);
    return true;
  }

  /** Release every row lock held by a session (commit / rollback / logoff). */
  releaseRowLocks(sessionId: string): void {
    for (const [k, holder] of this.rowLocks) {
      if (holder === sessionId) this.rowLocks.delete(k);
    }
  }
  private objectIdSeq = 50000;
  private objectIds = new Map<string, number>();

  private objectId(schema: string, table: string): number {
    const key = `${schema}.${table}`;
    let id = this.objectIds.get(key);
    if (id === undefined) { id = this.objectIdSeq++; this.objectIds.set(key, id); }
    return id;
  }

  lockTable(args: {
    sessionId: string; sid: number; schema: string; table: string;
    mode: LockMode; txId?: number | null; nowait?: boolean;
  }): void {
    const id1 = this.objectId(args.schema.toUpperCase(), args.table.toUpperCase());
    const conflicting = this.held.find(l =>
      l.type === 'TM' && l.id1 === id1 && l.sessionId !== args.sessionId
      && l.lmode > 0 && modesConflict(l.lmode, args.mode));
    if (conflicting) {
      if (args.nowait) throw new ResourceBusyError();
      this.registerWait(args.sessionId, conflicting.sessionId);
      this.detectDeadlock(args.sessionId);
      this.held.push({
        sessionId: args.sessionId, sid: args.sid, type: 'TM', id1, id2: 0,
        lmode: 0, request: args.mode, schema: args.schema.toUpperCase(),
        table: args.table.toUpperCase(), txId: args.txId ?? null, acquiredAt: Date.now(),
      });
      return;
    }
    this.clearWait(args.sessionId);
    const existing = this.held.find(l =>
      l.type === 'TM' && l.id1 === id1 && l.sessionId === args.sessionId);
    if (existing) {
      if (args.mode > existing.lmode) existing.lmode = args.mode;
      return;
    }
    this.held.push({
      sessionId: args.sessionId, sid: args.sid, type: 'TM', id1, id2: 0,
      lmode: args.mode, request: 0, schema: args.schema.toUpperCase(),
      table: args.table.toUpperCase(), txId: args.txId ?? null, acquiredAt: Date.now(),
    });
  }

  lockRowsForUpdate(args: {
    sessionId: string; sid: number; schema: string; table: string;
    txId: number; nowait?: boolean;
  }): void {
    this.lockTable({ ...args, mode: 3, nowait: args.nowait });
    const exists = this.held.find(l =>
      l.type === 'TX' && l.sessionId === args.sessionId && l.txId === args.txId);
    if (!exists) {
      this.held.push({
        sessionId: args.sessionId, sid: args.sid, type: 'TX',
        id1: 0x10000 | (args.txId & 0xffff), id2: args.txId, lmode: 6, request: 0,
        schema: args.schema.toUpperCase(), table: args.table.toUpperCase(),
        txId: args.txId, acquiredAt: Date.now(),
      });
    }
  }

  acquireDmlLock(args: {
    sessionId: string; sid: number; schema: string; table: string; txId: number;
  }): void {
    try {
      this.lockTable({ ...args, mode: 3, nowait: false });
    } catch (e) {
      if (e instanceof DeadlockError) throw e;
    }
  }

  releaseSession(sessionId: string): void {
    this.held = this.held.filter(l => l.sessionId !== sessionId);
    this.releaseRowLocks(sessionId);
    this.clearWait(sessionId);
    this.wakeWaiters();
  }

  releaseTransaction(sessionId: string, txId: number): void {
    this.held = this.held.filter(l => !(l.sessionId === sessionId && l.txId === txId));
    this.releaseRowLocks(sessionId);
    this.clearWait(sessionId);
    this.wakeWaiters();
  }

  private wakeWaiters(): void {
    let progress = true;
    while (progress) {
      progress = false;
      for (const l of this.held) {
        if (l.lmode !== 0 || l.request === 0) continue;
        const blocker = this.held.find(o =>
          o.type === l.type && o.id1 === l.id1 && o.sessionId !== l.sessionId
          && o.lmode > 0 && modesConflict(o.lmode, l.request));
        if (!blocker) {
          l.lmode = l.request;
          l.request = 0;
          this.clearWait(l.sessionId);
          progress = true;
        }
      }
    }
  }

  private registerWait(waiter: string, holder: string): void {
    this.waits.set(waiter, holder);
  }

  private clearWait(sessionId: string): void {
    this.waits.delete(sessionId);
  }

  private detectDeadlock(starting: string): void {
    const path: string[] = [starting];
    const seen = new Set<string>([starting]);
    let current = this.waits.get(starting);
    while (current) {
      path.push(current);
      if (seen.has(current)) {
        this.waits.delete(starting);
        throw new DeadlockError(path);
      }
      seen.add(current);
      current = this.waits.get(current);
    }
  }

  blockingSessionFor(sessionId: string): number | null {
    const holder = this.waits.get(sessionId);
    if (!holder) return null;
    const lock = this.held.find(l => l.sessionId === holder && l.lmode > 0);
    return lock ? lock.sid : null;
  }

  getHeldLocks(): readonly HeldLock[] { return this.held; }

  getBlockers(): Array<{ holderSid: number; holderSession: string; waiterSid: number; waiterSession: string }> {
    const out: Array<{ holderSid: number; holderSession: string; waiterSid: number; waiterSession: string }> = [];
    for (const [waiter, holder] of this.waits) {
      const wLock = this.held.find(l => l.sessionId === waiter);
      const hLock = this.held.find(l => l.sessionId === holder && l.lmode > 0);
      if (wLock && hLock) {
        out.push({ holderSid: hLock.sid, holderSession: holder, waiterSid: wLock.sid, waiterSession: waiter });
      }
    }
    return out;
  }

  reset(): void {
    this.held = [];
    this.waits.clear();
  }
}
