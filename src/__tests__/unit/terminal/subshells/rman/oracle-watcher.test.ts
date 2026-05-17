/**
 * OracleInstanceWatcherActor — cross-cutting reactive bridge.
 *
 * Subscribes to `oracle.instance.state-changed` on the shared bus and,
 * when the watched device's instance leaves OPEN/MOUNT, forces every
 * RMAN session bound to that device to disconnect (mirrors what would
 * happen against a real Oracle target: the channel dies and RMAN exits).
 *
 * Pure actor: no producer mutates the RmanSession directly — the watcher
 * subscribes to the bus and calls `.dispose()` reactively.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventBus } from '@/events/EventBus';
import {
  RmanSession, RmanSessionOptionsBuilder, DbId, ok,
  OracleInstanceWatcherActor,
  type IRmanOracleContext,
} from '@/terminal/subshells/rman';

function makeCtx(): IRmanOracleContext {
  return {
    dbId: DbId.DEFAULT, dbName: 'ORCL',
    vfs: {
      writeFile: () => ok(undefined), readFile: () => ok(new Uint8Array(0)),
      fileExists: () => true, deleteFile: () => ok(undefined), availableBytes: () => 1e10,
    },
    getDatafiles: () => [],
    getSpfileParam: () => undefined,
    getInstanceState: () => 'OPEN',
  } as unknown as IRmanOracleContext;
}

describe('OracleInstanceWatcherActor', () => {
  let bus: EventBus;

  beforeEach(() => { bus = new EventBus(); });
  afterEach(() => bus.clear());

  it('disposes the RMAN session when the watched device shuts down', () => {
    const sess = new RmanSession(
      new RmanSessionOptionsBuilder().withSharedBus(bus, 'sess-X').build(),
      makeCtx(),
    );
    sess.connect();
    expect(sess.state).toBe('CONNECTED');

    const watcher = new OracleInstanceWatcherActor(bus, 'dev-A', sess);
    watcher.start();

    // Foreign device shutdown — must be ignored.
    bus.publish({
      topic: 'oracle.instance.state-changed',
      payload: { deviceId: 'dev-Z', sid: 'OTHER', oldState: 'OPEN', newState: 'SHUTDOWN' },
    });
    expect(sess.state).toBe('CONNECTED');

    // Watched device goes down → session is disposed.
    bus.publish({
      topic: 'oracle.instance.state-changed',
      payload: { deviceId: 'dev-A', sid: 'ORCL', oldState: 'OPEN', newState: 'SHUTDOWN' },
    });
    expect(sess.state).toBe('DISCONNECTED');

    watcher.stop();
  });

  it('ignores transitions that stay inside OPEN/MOUNT/NOMOUNT', () => {
    const sess = new RmanSession(
      new RmanSessionOptionsBuilder().withSharedBus(bus, 'sess-Y').build(),
      makeCtx(),
    );
    sess.connect();
    const watcher = new OracleInstanceWatcherActor(bus, 'dev-B', sess);
    watcher.start();

    bus.publish({
      topic: 'oracle.instance.state-changed',
      payload: { deviceId: 'dev-B', sid: 'ORCL', oldState: 'OPEN', newState: 'MOUNT' },
    });
    expect(sess.state).toBe('CONNECTED');

    watcher.stop();
  });

  it('stop() detaches the watcher (no more side-effects)', () => {
    const sess = new RmanSession(
      new RmanSessionOptionsBuilder().withSharedBus(bus, 'sess-Z').build(),
      makeCtx(),
    );
    sess.connect();
    const watcher = new OracleInstanceWatcherActor(bus, 'dev-C', sess);
    watcher.start();
    watcher.stop();

    bus.publish({
      topic: 'oracle.instance.state-changed',
      payload: { deviceId: 'dev-C', sid: 'ORCL', oldState: 'OPEN', newState: 'SHUTDOWN' },
    });
    expect(sess.state).toBe('CONNECTED');
  });
});
