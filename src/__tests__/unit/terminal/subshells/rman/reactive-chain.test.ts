/**
 * Full reactive-chain integration.
 *
 * Wires every reactive component the RMAN module ships and validates a
 * realistic operational scenario:
 *
 *   1. Two concurrent RmanSessions publish onto a shared IEventBus.
 *   2. RmanSignalRefreshActor mutates a RmanSignalStore for one of them.
 *   3. RmanLoggerActor projects every rman.* topic into `log`.
 *   4. OracleInstanceWatcherActor disposes that session reactively when
 *      the watched device's Oracle instance shuts down.
 *   5. Throughout, the project-wide Signal `derived` operator composes a
 *      stream against the live RmanSignalStore — confirming the data
 *      reaches the read-model React-style consumers expect.
 *
 * No producer mutates a Signal directly. Every observable transition
 * happens through the bus.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventBus } from '@/events/EventBus';
import { WritableSignal, derived } from '@/events/Signal';
import type { DomainEvent } from '@/events/types';
import {
  RmanSession, RmanSessionOptionsBuilder, BackupKey, DbId, ok,
  RmanSignalStore, RmanSignalRefreshActor, makeReadonlyRmanObservables,
  RmanLoggerActor, OracleInstanceWatcherActor,
  type IRmanOracleContext, type RmanMetricsVM,
} from '@/terminal/subshells/rman';

function makeCtx(): IRmanOracleContext {
  return {
    dbId: DbId.DEFAULT, dbName: 'ORCL',
    vfs: {
      writeFile: () => ok(undefined), readFile: () => ok(new Uint8Array(0)),
      fileExists: () => true, deleteFile: () => ok(undefined), availableBytes: () => 1e10,
    },
    getDatafiles: () => [
      { fileNo: 1, path: '/u01/oradata/ORCL/system01.dbf', sizeBytes: 1_000, tablespace: 'SYSTEM' },
    ],
    getSpfileParam: () => undefined,
    getInstanceState: () => 'OPEN',
  } as unknown as IRmanOracleContext;
}

describe('Full reactive chain — bus, actors, signals, derived state', () => {
  let bus: EventBus;
  beforeEach(() => { bus = new EventBus(); BackupKey._reset(); });
  afterEach(() => bus.clear());

  it('publishes, projects, watches, and derives in lock-step', () => {
    // ── Wiring ────────────────────────────────────────────────────
    const store  = new RmanSignalStore();
    const obs    = makeReadonlyRmanObservables(store);
    const refresh = new RmanSignalRefreshActor(bus, 'sess-A', store);
    const logger  = new RmanLoggerActor(bus, 'sess-A');
    refresh.start();
    logger.start();

    const logs: DomainEvent[] = [];
    bus.subscribe('log', e => logs.push(e));

    // A project-style Signal mirroring the RMAN read-model metrics$, so
    // we can compose derived() against the rest of the codebase.
    const metricsMirror = new WritableSignal<RmanMetricsVM>(obs.metrics.get());
    obs.metrics.subscribe(() => metricsMirror.set(obs.metrics.get()));
    const completedSig = derived([metricsMirror], () => metricsMirror.get().jobsCompleted);
    const completedHistory: number[] = [];
    completedSig.subscribe(() => completedHistory.push(completedSig.get()));

    const sessA = new RmanSession(
      new RmanSessionOptionsBuilder().withSharedBus(bus, 'sess-A').build(),
      makeCtx(),
    );
    const sessB = new RmanSession(
      new RmanSessionOptionsBuilder().withSharedBus(bus, 'sess-B').build(),
      makeCtx(),
    );
    const watcher = new OracleInstanceWatcherActor(bus, 'dev-A', sessA);
    watcher.start();

    // ── Drive ─────────────────────────────────────────────────────
    sessA.connect();
    sessB.connect();
    sessA.processLine('BACKUP DATABASE');
    sessB.processLine('BACKUP DATABASE'); // foreign session — must NOT affect sess-A signals
    sessA.processLine('BACKUP DATABASE');

    // ── Cross-cutting reactivity: instance shutdown disposes sess-A ─
    expect(sessA.state).toBe('CONNECTED');
    bus.publish({
      topic: 'oracle.instance.state-changed',
      payload: { deviceId: 'dev-A', sid: 'ORCL', oldState: 'OPEN', newState: 'SHUTDOWN' },
    });
    expect(sessA.state).toBe('DISCONNECTED');
    // sess-B is unrelated — still alive.
    expect(sessB.state).toBe('CONNECTED');

    // ── Assertions on derived state ───────────────────────────────
    // Only sess-A's jobs were counted in the store (refresh actor scoped
    // by sessionId), so sess-A ran 2 backups → metrics.jobsCompleted == 2.
    expect(store.metrics.get().jobsCompleted).toBe(2);
    expect(store.metrics.get().piecesCreated).toBe(2);
    expect(store.metrics.get().totalBytesBackedUp).toBe(2_000);
    // Sess-A is now disconnected → session VM state matches.
    expect(store.session.get().state).toBe('DISCONNECTED');

    // The composed Signal saw the same monotonic progression.
    expect(completedHistory).toContain(1);
    expect(completedHistory[completedHistory.length - 1]).toBe(2);

    // Logger fan-out: every sess-A topic produced a `log` event with the
    // correct source tag.
    const myLogs = logs.filter(e => (e.payload as { source: string }).source === 'rman.sess-A');
    expect(myLogs.length).toBeGreaterThan(0);
    const messages = myLogs.map(e => (e.payload as { message: string }).message);
    expect(messages.some(m => /BACKUP_DATABASE.*started/i.test(m))).toBe(true);
    expect(messages.some(m => /BACKUP_DATABASE.*completed/i.test(m))).toBe(true);

    // ── Teardown ──────────────────────────────────────────────────
    watcher.stop(); logger.stop(); refresh.stop();
    sessB.dispose();
  });
});
