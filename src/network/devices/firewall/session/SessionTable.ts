import { flowKeyToString, reverseFlowKey, type FlowKey } from './FlowKey';
import type { FlowDirection, ObservedTcpState, TcpStateMachine } from './TcpStateMachine';
import { sessionFamily, type SessionFamily } from './SessionFamily';
import type { IScheduler } from '@/events/Scheduler';
import { TimerSet } from '@/events/TimerSet';

export type SessionState = 'init' | 'opening' | 'active' | 'closing' | 'closed' | 'discard';

export type SessionCloseReason =
  | 'tcp-fin' | 'tcp-rst' | 'timeout' | 'clear' | 'parent-closed' | 'policy-change';

export interface SessionCounters {
  packetsC2S: number;
  bytesC2S: number;
  packetsS2C: number;
  bytesS2C: number;
}

export interface SessionTranslation {
  readonly natRuleId: string;
  readonly pool?: string;
  readonly originalSource: string;
  readonly originalSourcePort: number;
  readonly translatedSource: string;
  readonly translatedSourcePort: number;
  readonly originalDest: string;
  readonly originalDestPort: number;
  readonly translatedDest: string;
  readonly translatedDestPort: number;
}

export interface FirewallSession {
  readonly id: number;
  readonly createdAt: number;
  lastSeenAt: number;
  readonly c2s: FlowKey;
  readonly s2c: FlowKey;
  ingressZone: string;
  egressZone: string;
  ingressInterface: string;
  egressInterface: string;
  state: SessionState;
  tcpState?: ObservedTcpState;
  tcpMachine?: TcpStateMachine;
  policyId?: string;
  natRuleId?: string;
  translation?: SessionTranslation;
  application?: string;
  user?: string;
  readonly counters: SessionCounters;
  timeoutSec: number;
  expiresAt: number;
  parentSessionId?: number;
  algName?: string;
  isPinhole: boolean;
  closeReason?: SessionCloseReason;
}

export interface SessionInstallOptions {
  ingressZone: string;
  egressZone: string;
  ingressInterface: string;
  egressInterface: string;
  timeoutSec: number;
  policyId?: string;
  tcpState?: ObservedTcpState;
  replyKey?: FlowKey;
}

export interface SessionTableLimits {
  maxSessions?: number;
}

export interface SessionTableDeps {
  now?: () => number;
  scheduler?: () => IScheduler;
  limits?: SessionTableLimits;
  onCreated?: (session: FirewallSession) => void;
  onClosed?: (session: FirewallSession, reason: SessionCloseReason) => void;
}

export interface SessionLookup {
  readonly session: FirewallSession;
  readonly direction: FlowDirection;
}

export interface FamilyCounters {
  readonly created: number;
  readonly closed: number;
}

export interface SessionStatistics {
  readonly active: number;
  readonly created: number;
  readonly closed: number;
  readonly discarded: number;
  readonly byFamily: Readonly<Record<SessionFamily, FamilyCounters>>;
}

export interface SessionTableView {
  count(): number;
  all(): readonly FirewallSession[];
  find(predicate: (session: FirewallSession) => boolean): readonly FirewallSession[];
  byId(id: number): FirewallSession | undefined;
  statistics(): SessionStatistics;
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;

function retirementReason(session: FirewallSession): SessionCloseReason {
  if (session.tcpState === 'closed') return 'tcp-rst';
  if (session.tcpState === 'time-wait') return 'tcp-fin';
  return 'timeout';
}

export class SessionTableFullError extends Error {
  constructor(readonly limit: number) {
    super(`session table full (${limit})`);
    this.name = 'SessionTableFullError';
  }
}

export class SessionTable {
  private readonly sessions = new Map<number, FirewallSession>();
  private readonly index = new Map<string, SessionLookup>();
  private readonly children = new Map<number, Set<number>>();
  private readonly now: () => number;
  private readonly limits: SessionTableLimits;
  private readonly deps: SessionTableDeps;
  private nextId = 1;
  private createdCount = 0;
  private closedCount = 0;
  private discardedCount = 0;
  private expiryDueAt: number | null = null;
  private expiryTimer: symbol | null = null;
  private readonly timers: TimerSet | null;
  private readonly familyCounts: Record<SessionFamily, { created: number; closed: number }> = {
    ipv4: { created: 0, closed: 0 },
    ipv6: { created: 0, closed: 0 },
  };

  constructor(deps: SessionTableDeps = {}) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.limits = deps.limits ?? {};
    const scheduler = deps.scheduler;
    this.timers = scheduler ? new TimerSet(scheduler) : null;
  }

  install(key: FlowKey, options: SessionInstallOptions): FirewallSession {
    return this.create(key, options, 'active');
  }

  installDiscard(key: FlowKey, options: SessionInstallOptions): FirewallSession {
    const session = this.create(key, options, 'discard');
    this.discardedCount++;
    return session;
  }

  installPinhole(
    key: FlowKey, options: SessionInstallOptions, parentSessionId: number, algName: string,
  ): FirewallSession {
    const session = this.create(key, options, 'active');
    session.parentSessionId = parentSessionId;
    session.algName = algName;
    session.isPinhole = true;

    let siblings = this.children.get(parentSessionId);
    if (!siblings) { siblings = new Set(); this.children.set(parentSessionId, siblings); }
    siblings.add(session.id);
    return session;
  }

  consumePinhole(session: FirewallSession): void {
    session.isPinhole = false;
  }

  lookup(key: FlowKey): SessionLookup | undefined {
    return this.index.get(flowKeyToString(key));
  }

  byId(id: number): FirewallSession | undefined {
    return this.sessions.get(id);
  }

  count(): number {
    return this.sessions.size;
  }

  hasRoom(): boolean {
    const max = this.limits.maxSessions;
    return max === undefined || this.sessions.size < max;
  }

  recordTraffic(session: FirewallSession, direction: FlowDirection, bytes: number): void {
    if (direction === 'c2s') {
      session.counters.packetsC2S++;
      session.counters.bytesC2S += bytes;
    } else {
      session.counters.packetsS2C++;
      session.counters.bytesS2C += bytes;
    }
    this.refresh(session);
  }

  refresh(session: FirewallSession): void {
    session.lastSeenAt = this.now();
    session.expiresAt = session.lastSeenAt + session.timeoutSec * 1000;
    this.armExpiry(session.expiresAt);
  }

  setTimeout(session: FirewallSession, timeoutSec: number): void {
    session.timeoutSec = timeoutSec;
    session.expiresAt = session.lastSeenAt + timeoutSec * 1000;
    this.armExpiry(session.expiresAt);
  }

  close(session: FirewallSession, reason: SessionCloseReason): void {
    if (!this.sessions.has(session.id)) return;

    session.state = 'closed';
    session.closeReason = reason;
    this.index.delete(flowKeyToString(session.c2s));
    this.index.delete(flowKeyToString(session.s2c));
    this.sessions.delete(session.id);
    this.closedCount++;
    this.familyCounts[sessionFamily(session)].closed++;
    this.deps.onClosed?.(session, reason);

    const siblings = this.children.get(session.id);
    this.children.delete(session.id);
    if (!siblings) return;
    for (const childId of siblings) {
      const child = this.sessions.get(childId);
      if (child?.isPinhole) this.close(child, 'parent-closed');
    }
  }

  sweep(): number {
    const deadline = this.now();
    let purged = 0;
    for (const session of [...this.sessions.values()]) {
      if (session.expiresAt <= deadline) {
        this.close(session, retirementReason(session));
        purged++;
      }
    }
    return purged;
  }

  private armExpiry(deadline: number): void {
    if (!this.timers || !Number.isFinite(deadline)) return;
    if (this.expiryDueAt !== null && this.expiryDueAt <= deadline) return;
    this.timers.clear(this.expiryTimer);
    const delay = Math.min(MAX_TIMER_DELAY_MS, Math.max(0, deadline - this.now()));
    this.expiryTimer = this.timers.setTimeout(() => this.expireDue(), delay);
    this.expiryDueAt = deadline;
  }

  private expireDue(): void {
    this.expiryDueAt = null;
    this.expiryTimer = null;
    this.sweep();
    let earliest = Number.POSITIVE_INFINITY;
    for (const session of this.sessions.values()) earliest = Math.min(earliest, session.expiresAt);
    this.armExpiry(earliest);
  }

  clear(): number {
    return this.clearMatching(() => true);
  }

  clearMatching(predicate: (session: FirewallSession) => boolean): number {
    let removed = 0;
    for (const session of [...this.sessions.values()]) {
      if (this.sessions.has(session.id) && predicate(session)) {
        this.close(session, 'clear');
        removed++;
      }
    }
    return removed;
  }

  view(): SessionTableView {
    const sessions = this.sessions;
    const statistics = (): SessionStatistics => Object.freeze({
      active: sessions.size,
      created: this.createdCount,
      closed: this.closedCount,
      discarded: this.discardedCount,
      byFamily: Object.freeze({
        ipv4: Object.freeze({ ...this.familyCounts.ipv4 }),
        ipv6: Object.freeze({ ...this.familyCounts.ipv6 }),
      }),
    });

    return {
      count: () => sessions.size,
      all: () => Object.freeze([...sessions.values()]),
      find: (predicate) => Object.freeze([...sessions.values()].filter(predicate)),
      byId: (id) => sessions.get(id),
      statistics,
    };
  }

  private create(
    key: FlowKey, options: SessionInstallOptions, state: SessionState,
  ): FirewallSession {
    if (!this.hasRoom()) throw new SessionTableFullError(this.limits.maxSessions ?? 0);

    const createdAt = this.now();
    const session: FirewallSession = {
      id: this.nextId++,
      createdAt,
      lastSeenAt: createdAt,
      c2s: key,
      s2c: options.replyKey ?? reverseFlowKey(key),
      ingressZone: options.ingressZone,
      egressZone: options.egressZone,
      ingressInterface: options.ingressInterface,
      egressInterface: options.egressInterface,
      state,
      tcpState: options.tcpState,
      policyId: options.policyId,
      counters: { packetsC2S: 0, bytesC2S: 0, packetsS2C: 0, bytesS2C: 0 },
      timeoutSec: options.timeoutSec,
      expiresAt: createdAt + options.timeoutSec * 1000,
      isPinhole: false,
    };

    this.sessions.set(session.id, session);
    this.index.set(flowKeyToString(session.c2s), { session, direction: 'c2s' });
    this.index.set(flowKeyToString(session.s2c), { session, direction: 's2c' });
    this.createdCount++;
    this.familyCounts[sessionFamily(session)].created++;
    this.deps.onCreated?.(session);
    this.armExpiry(session.expiresAt);
    return session;
  }
}
