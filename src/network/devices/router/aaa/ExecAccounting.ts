import { simulationNowMs } from '@/network/core/SystemClock';
import type { IScheduler, TimerHandle } from '@/events/Scheduler';
import type { TacacsClientAgent } from '../../../tacacs/TacacsClientAgent';
import type { RadiusAccountingClient } from '../../../radius/RadiusAccountingClient';
import {
  radiusAcctPort,
  type AaaMethodEntry, type AaaServerGroup, type CiscoSecurityConfig, type RadiusServer, type TacacsServer,
} from '../security/CiscoSecurityConfig';
import type { SshSessionRecord } from './SshSessionRegistry';

export interface ExecAccountingLedger {
  start(): void;
  stop(): void;
  failed(): void;
}

export interface ExecAccountingDeps {
  security(): CiscoSecurityConfig;
  tacacs(): TacacsClientAgent | undefined;
  radius(): RadiusAccountingClient | undefined;
  prepareTacacs(client: TacacsClientAgent, server: TacacsServer): void;
  tacacsUser(username: string, server: TacacsServer): string;
  groupOf(name: string): AaaServerGroup | undefined;
  listName(session: SshSessionRecord): string;
  ledger: ExecAccountingLedger;
  scheduler(): IScheduler;
}

type RecordKind = 'start' | 'stop' | 'interim';

interface EntryState {
  readonly entry: AaaMethodEntry;
  startAcknowledged: boolean;
  readonly radiusSessions: Map<string, string>;
}

interface SessionState {
  readonly session: SshSessionRecord;
  readonly entries: EntryState[];
  readonly taskId: number;
  readonly startedMs: number;
  timer: TimerHandle | null;
  closing: boolean;
}

type Target =
  | { readonly kind: 'tacacs'; readonly server: TacacsServer }
  | { readonly kind: 'radius'; readonly server: RadiusServer };

export class ExecAccounting {
  private readonly sessions = new Map<string, SessionState>();
  private nextTask = 1;

  constructor(private readonly deps: ExecAccountingDeps) {}

  private entriesFor(session: SshSessionRecord): AaaMethodEntry[] {
    const sec = this.deps.security();
    if (!sec.aaaNewModel) return [];
    const wanted = this.deps.listName(session);
    const exec = sec.aaaMethods.filter((m) => m.phase === 'accounting' && m.service === 'exec');
    const chosen = exec.filter((m) => m.listName === wanted);
    return (chosen.length > 0 ? chosen : exec.filter((m) => m.listName === 'default'))
      .filter((m) => m.recordType !== 'none');
  }

  private targetsOf(entry: AaaMethodEntry): Target[] {
    const sec = this.deps.security();
    const targets: Target[] = [];
    for (let i = 0; i + 1 < entry.methods.length; i++) {
      if (entry.methods[i] !== 'group') continue;
      const group = this.deps.groupOf(entry.methods[i + 1]);
      if (!group) continue;
      for (const member of group.members) {
        if (group.kind === 'tacacs+') {
          const server = sec.tacacsServers.get(member);
          if (server?.address) targets.push({ kind: 'tacacs', server });
        } else {
          const server = sec.radiusServers.get(member);
          if (server?.address) targets.push({ kind: 'radius', server });
        }
      }
    }
    return targets;
  }

  private tacacsArguments(state: SessionState, kind: RecordKind): string[] {
    const now = Math.floor(simulationNowMs() / 1000);
    const args = [`task_id=${state.taskId}`, 'timezone=UTC', 'service=shell'];
    if (kind === 'start') return [`start_time=${Math.floor(state.startedMs / 1000)}`, ...args];
    const elapsed = `elapsed_time=${Math.max(0, now - Math.floor(state.startedMs / 1000))}`;
    return kind === 'stop' ? [`stop_time=${now}`, ...args, elapsed] : [...args, elapsed];
  }

  private async deliver(state: SessionState, entryState: EntryState, kind: RecordKind, user: string): Promise<boolean> {
    const sec = this.deps.security();
    const session = state.session;
    for (const target of this.targetsOf(entryState.entry)) {
      if (target.kind === 'tacacs') {
        const client = this.deps.tacacs();
        if (!client) continue;
        this.deps.prepareTacacs(client, target.server);
        const flag = kind === 'interim' ? 'watchdog' : kind;
        const status = await client.account(
          this.deps.tacacsUser(user, target.server), [flag], this.tacacsArguments(state, kind),
          { port: `${session.lineKind}${session.lineIndex}`, remoteAddress: session.fromIp || '0.0.0.0', privLvl: session.privilege },
          target.server.address);
        if (status === 'success') return true;
        continue;
      }
      const client = this.deps.radius();
      const address = target.server.address as string;
      if (!client) continue;
      client.start();
      client.addServer(address, target.server.key ?? sec.radiusDefaults.key ?? '', {
        port: radiusAcctPort(target.server, sec.radiusDefaults),
        timeoutMs: (target.server.timeoutSec ?? sec.radiusDefaults.timeoutSec ?? 5) * 1000,
        retransmit: target.server.retransmit ?? sec.radiusDefaults.retransmit,
      });
      const before = client.acknowledgedCount(address);
      if (kind === 'start') {
        const id = client.startSession(user, address);
        if (id !== null) entryState.radiusSessions.set(address, id);
      } else {
        let id = entryState.radiusSessions.get(address);
        if (id === undefined) {
          id = client.beginSession(user, address, false) ?? undefined;
          if (id !== undefined) entryState.radiusSessions.set(address, id);
        }
        if (id === undefined) continue;
        if (kind === 'stop') {
          client.stopSession(id);
          entryState.radiusSessions.delete(address);
        } else {
          client.interimUpdate(id);
        }
      }
      if (client.acknowledgedCount(address) > before) return true;
    }
    return false;
  }

  private suppressed(user: string): boolean {
    return this.deps.security().accounting.suppressNullUsername && user === '';
  }

  async opened(session: SshSessionRecord): Promise<void> {
    if (this.sessions.has(session.id) || this.suppressed(session.user)) return;
    const entries = this.entriesFor(session);
    if (entries.length === 0) return;
    const state: SessionState = {
      session, taskId: this.nextTask++, startedMs: simulationNowMs(), timer: null, closing: false,
      entries: entries.map((entry) => ({ entry, startAcknowledged: false, radiusSessions: new Map() })),
    };
    this.sessions.set(session.id, state);
    for (const entryState of state.entries) {
      if (entryState.entry.recordType === 'stop-only') continue;
      const acknowledged = await this.deliver(state, entryState, 'start', session.user);
      entryState.startAcknowledged = acknowledged;
      if (acknowledged) this.deps.ledger.start(); else this.deps.ledger.failed();
    }
    this.armPeriodic(state);
  }

  private armPeriodic(state: SessionState): void {
    const options = this.deps.security().accounting;
    if (!options.updateEnabled || options.updatePeriodicMinutes === null || state.closing) return;
    const jitterMs = options.jitterMaxSec > 0 ? Math.random() * options.jitterMaxSec * 1000 : 0;
    state.timer = this.deps.scheduler().setTimeout(() => {
      void this.interim(state);
    }, options.updatePeriodicMinutes * 60_000 + jitterMs);
  }

  private async interim(state: SessionState): Promise<void> {
    if (state.closing || !this.sessions.has(state.session.id)) return;
    for (const entryState of state.entries) {
      const acknowledged = await this.deliver(state, entryState, 'interim', state.session.user);
      if (!acknowledged) this.deps.ledger.failed();
    }
    this.armPeriodic(state);
  }

  async closed(session: SshSessionRecord): Promise<void> {
    const state = this.sessions.get(session.id);
    if (!state) return;
    state.closing = true;
    if (state.timer !== null) this.deps.scheduler().clear(state.timer);
    this.sessions.delete(session.id);
    const always = this.deps.security().accounting.sendStopAlways;
    for (const entryState of state.entries) {
      const needsStart = entryState.entry.recordType !== 'stop-only';
      if (needsStart && !entryState.startAcknowledged && !always) continue;
      const acknowledged = await this.deliver(state, entryState, 'stop', session.user);
      if (acknowledged) this.deps.ledger.stop(); else this.deps.ledger.failed();
    }
  }

  async authenticationFailed(user: string, fromIp: string): Promise<void> {
    const options = this.deps.security().accounting;
    if (!options.sendStopOnAuthFailure || this.suppressed(user)) return;
    const probe = {
      id: `auth-failure-${this.nextTask}`, user, fromIp, lineKind: 'vty', lineIndex: 0, privilege: 1,
      line: 'vty 0', transport: 'telnet',
    } as unknown as SshSessionRecord;
    const entries = this.entriesFor(probe);
    const state: SessionState = {
      session: probe, taskId: this.nextTask++, startedMs: simulationNowMs(), timer: null, closing: true,
      entries: entries.map((entry) => ({ entry, startAcknowledged: false, radiusSessions: new Map() })),
    };
    for (const entryState of state.entries) {
      const acknowledged = await this.deliver(state, entryState, 'stop', user);
      if (acknowledged) this.deps.ledger.stop(); else this.deps.ledger.failed();
    }
  }
}
