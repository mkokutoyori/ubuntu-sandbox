/**
 * Cross-cutting integration with the project-wide IEventBus + Signal stack.
 *
 * Validates that, when an RmanSession is built with a shared bus + sessionId,
 *   - every internal RmanEvent is re-published as a `rman.*` topic on the bus
 *   - RmanSignalRefreshActor projects those events onto WritableSignals
 *   - the read-only RmanObservables view reflects the latest aggregate state
 *
 * Mirrors the OracleSignalRefreshActor + OracleSignalStore pattern.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EventBus } from '@/events/EventBus';
import type { DomainEvent } from '@/events/types';
import {
  RmanSession, RmanSessionOptionsBuilder, BackupKey, DbId, ok,
  RmanSignalStore, RmanSignalRefreshActor, makeReadonlyRmanObservables,
  type IRmanOracleContext,
} from '@/terminal/subshells/rman';

function makeCtx(): IRmanOracleContext {
  return {
    dbId: DbId.DEFAULT, dbName: 'ORCL',
    vfs: {
      writeFile: () => ok(undefined), readFile: () => ok(new Uint8Array(0)),
      fileExists: () => true, deleteFile: () => ok(undefined), availableBytes: () => 1e10,
    },
    getDatafiles: () => [
      { fileNo: 1, path: '/u01/oradata/ORCL/system01.dbf', sizeBytes: 1000, tablespace: 'SYSTEM' },
    ],
    getSpfileParam: () => undefined,
    getInstanceState: () => 'OPEN',
  } as unknown as IRmanOracleContext;
}

describe('RmanBusBridge — projects RmanEvents onto IEventBus as rman.* topics', () => {
  beforeEach(() => BackupKey._reset());

  it('publishes rman.session.connected on connect()', () => {
    const bus = new EventBus();
    const topics: string[] = [];
    bus.subscribeAll(e => topics.push(e.topic));

    const s = new RmanSession(
      new RmanSessionOptionsBuilder().withSharedBus(bus, 'sess-A').build(),
      makeCtx(),
    );
    s.connect();
    expect(topics).toContain('rman.session.state-changed');
    expect(topics).toContain('rman.session.connected');
  });

  it('publishes rman.job.* + rman.backup.piece-created for a BACKUP DATABASE', () => {
    const bus = new EventBus();
    const seen: DomainEvent[] = [];
    bus.subscribeAll(e => seen.push(e));

    const s = new RmanSession(
      new RmanSessionOptionsBuilder().withSharedBus(bus, 'sess-B').build(),
      makeCtx(),
    );
    s.connect();
    s.processLine('BACKUP DATABASE');

    const topics = seen.map(e => e.topic);
    expect(topics).toContain('rman.job.started');
    expect(topics).toContain('rman.job.completed');
    expect(topics).toContain('rman.channel.allocated');
    expect(topics).toContain('rman.channel.released');
    expect(topics).toContain('rman.backup.piece-created');
    expect(topics).toContain('rman.backup.set-complete');

    // All carry the correct sessionId
    expect(seen.every(e => (e.payload as { sessionId?: string }).sessionId === 'sess-B')).toBe(true);
  });

  it('filters out events from a different session', () => {
    const bus = new EventBus();
    const seenByA: string[] = [];
    bus.subscribeWhere(
      'rman.job.completed',
      p => p.sessionId === 'sess-A',
      e => seenByA.push(e.payload.jobId),
    );

    const a = new RmanSession(
      new RmanSessionOptionsBuilder().withSharedBus(bus, 'sess-A').build(),
      makeCtx(),
    );
    const b = new RmanSession(
      new RmanSessionOptionsBuilder().withSharedBus(bus, 'sess-B').build(),
      makeCtx(),
    );
    a.connect(); b.connect();
    a.processLine('BACKUP DATABASE');
    b.processLine('BACKUP DATABASE');
    b.processLine('BACKUP DATABASE');
    expect(seenByA.length).toBe(1);
  });
});

describe('RmanSignalRefreshActor — keeps RmanSignalStore in sync', () => {
  beforeEach(() => BackupKey._reset());

  it('initial session state propagates via WritableSignal', () => {
    const bus = new EventBus();
    const store = new RmanSignalStore();
    const actor = new RmanSignalRefreshActor(bus, 'sess-X', store);
    actor.start();

    const s = new RmanSession(
      new RmanSessionOptionsBuilder().withSharedBus(bus, 'sess-X').build(),
      makeCtx(),
    );
    s.connect();

    const vm = store.session.get();
    expect(vm.state).toBe('CONNECTED');
    expect(vm.dbName).toBe('ORCL');
    expect(vm.sessionId).toBe('sess-X');

    actor.stop();
  });

  it('metrics signal aggregates bytes + counters across jobs', () => {
    const bus = new EventBus();
    const store = new RmanSignalStore();
    new RmanSignalRefreshActor(bus, 'sess-Y', store).start();

    const s = new RmanSession(
      new RmanSessionOptionsBuilder().withSharedBus(bus, 'sess-Y').build(),
      makeCtx(),
    );
    s.connect();
    s.processLine('BACKUP DATABASE');
    s.processLine('BACKUP DATABASE');

    const m = store.metrics.get();
    expect(m.jobsCompleted).toBe(2);
    expect(m.piecesCreated).toBe(2);
    expect(m.totalBytesBackedUp).toBe(2_000);
  });

  it('exposes Signal-shaped observables compatible with useSyncExternalStore', () => {
    const bus = new EventBus();
    const store = new RmanSignalStore();
    new RmanSignalRefreshActor(bus, 'sess-Z', store).start();

    const obs = makeReadonlyRmanObservables(store);
    let notifications = 0;
    const unsub = obs.metrics.subscribe(() => { notifications++; });

    const s = new RmanSession(
      new RmanSessionOptionsBuilder().withSharedBus(bus, 'sess-Z').build(),
      makeCtx(),
    );
    s.connect();
    s.processLine('BACKUP DATABASE');

    expect(notifications).toBeGreaterThan(0);
    expect(obs.metrics.get().jobsCompleted).toBe(1);
    unsub();
  });

  it('activeChannels signal bounces 0 → 1 → 0 around a job', () => {
    const bus = new EventBus();
    const store = new RmanSignalStore();
    new RmanSignalRefreshActor(bus, 'sess-W', store).start();

    const sizes: number[] = [];
    store.activeChannels.subscribe(() => sizes.push(store.activeChannels.get().size));

    const s = new RmanSession(
      new RmanSessionOptionsBuilder().withSharedBus(bus, 'sess-W').build(),
      makeCtx(),
    );
    s.connect();
    s.processLine('BACKUP DATABASE');

    expect(Math.max(...sizes)).toBe(1);
    expect(sizes[sizes.length - 1]).toBe(0);
  });
});
