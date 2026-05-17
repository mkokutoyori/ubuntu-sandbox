/**
 * Final BACKUP option polish: CUMULATIVE / MAXPIECESIZE / ENCRYPTED +
 * RmanLoggerActor cross-cutting integration.
 *
 *   BACKUP INCREMENTAL LEVEL 1 CUMULATIVE DATABASE
 *   BACKUP DATABASE MAXPIECESIZE 50M
 *   BACKUP DATABASE ENCRYPTED
 *
 *   RmanLoggerActor projects rman.* topics onto the project-wide 'log'
 *   topic, exactly like Oracle's signal-refresh + log actors compose.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EventBus } from '@/events/EventBus';
import type { DomainEvent } from '@/events/types';
import {
  RmanSession, RmanSessionOptionsBuilder, BackupKey, DbId, ok,
  RmanLoggerActor,
  type IRmanOracleContext, type RmanEvent,
} from '@/terminal/subshells/rman';

function makeCtx(): IRmanOracleContext {
  return {
    dbId: DbId.DEFAULT, dbName: 'ORCL',
    vfs: {
      writeFile: () => ok(undefined), readFile: () => ok(new Uint8Array(0)),
      fileExists: () => true, deleteFile: () => ok(undefined), availableBytes: () => 1e10,
    },
    getDatafiles: () => [
      { fileNo: 1, path: '/u01/oradata/ORCL/system01.dbf', sizeBytes: 100_000_000, tablespace: 'SYSTEM' },
    ],
    getSpfileParam: () => undefined,
    getInstanceState: () => 'OPEN',
  } as unknown as IRmanOracleContext;
}

describe('BACKUP CUMULATIVE / MAXPIECESIZE / ENCRYPTED', () => {
  beforeEach(() => BackupKey._reset());

  it('CUMULATIVE on incremental level 1 is recorded in the catalog params', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), makeCtx());
    s.connect();
    const messages: string[] = [];
    s.events$.subscribe(e => {
      if (e.type === 'PROGRESS_UPDATED') messages.push((e as Extract<RmanEvent, { type: 'PROGRESS_UPDATED' }>).message);
    });
    const r = s.processLine('BACKUP INCREMENTAL LEVEL 1 CUMULATIVE DATABASE');
    expect(r.ok).toBe(true);
    expect(messages.some(m => /cumulative/i.test(m))).toBe(true);
  });

  it('MAXPIECESIZE splits a large backup into multiple BACKUP_PIECE_CREATED events', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), makeCtx());
    s.connect();
    const pieces: string[] = [];
    s.events$.subscribe(e => {
      if (e.type === 'BACKUP_PIECE_CREATED') pieces.push((e as Extract<RmanEvent, { type: 'BACKUP_PIECE_CREATED' }>).piece.path);
    });
    s.processLine('BACKUP DATABASE MAXPIECESIZE 50M');
    // 100 MB datafile, 50 MB pieces → 2 pieces
    expect(pieces.length).toBe(2);
    expect(new Set(pieces).size).toBe(2); // distinct paths
  });

  it('ENCRYPTED flag is captured on the BackupSet and rendered in LIST BACKUP', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), makeCtx());
    s.connect();
    s.processLine('BACKUP DATABASE ENCRYPTED');
    const r = s.processLine('LIST BACKUP');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.join('\n')).toMatch(/Encrypted:\s*YES|ENCRYPTED/i);
  });
});

describe('RmanLoggerActor — cross-cutting log integration', () => {
  beforeEach(() => BackupKey._reset());

  it('projects rman.job.* events onto the shared log topic', () => {
    const bus = new EventBus();
    const logs: DomainEvent[] = [];
    bus.subscribe('log', e => logs.push(e));

    const actor = new RmanLoggerActor(bus, 'sess-log');
    actor.start();

    const s = new RmanSession(
      new RmanSessionOptionsBuilder().withSharedBus(bus, 'sess-log').build(),
      makeCtx(),
    );
    s.connect();
    s.processLine('BACKUP DATABASE');

    const messages = logs.map(e => (e.payload as { message: string }).message);
    expect(messages.some(m => /backup/i.test(m))).toBe(true);
    expect(messages.some(m => /started|complete/i.test(m))).toBe(true);
    actor.stop();
  });

  it('only logs events for its scoped sessionId', () => {
    const bus = new EventBus();
    const logs: DomainEvent[] = [];
    bus.subscribe('log', e => logs.push(e));

    const actor = new RmanLoggerActor(bus, 'sess-mine');
    actor.start();

    const mine = new RmanSession(
      new RmanSessionOptionsBuilder().withSharedBus(bus, 'sess-mine').build(),
      makeCtx(),
    );
    const other = new RmanSession(
      new RmanSessionOptionsBuilder().withSharedBus(bus, 'sess-other').build(),
      makeCtx(),
    );
    mine.connect(); other.connect();
    mine.processLine('BACKUP DATABASE');
    other.processLine('BACKUP DATABASE');

    expect(logs.length).toBeGreaterThan(0);
    expect(logs.every(e => (e.payload as { source: string }).source === 'rman.sess-mine')).toBe(true);
    actor.stop();
  });
});
