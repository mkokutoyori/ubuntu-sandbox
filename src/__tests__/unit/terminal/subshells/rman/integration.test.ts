/**
 * RMAN — end-to-end integration scenarios from doc §11.
 *
 * Reproduces the canonical event sequences for:
 *   §11.1 BACKUP DATABASE
 *   §11.2 RESTORE + RECOVER
 *   §11.3 CROSSCHECK with missing file
 *   §11.4 LIST BACKUP SUMMARY (synchronous)
 *
 * All routed through the public barrel `@/terminal/subshells/rman`.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  RmanSession, BackupKey, ok,
  type IRmanOracleContext, DbId,
} from '@/terminal/subshells/rman';
import type { RmanEvent } from '@/terminal/subshells/rman';

function makeCtx(missingPaths: Set<string> = new Set()): IRmanOracleContext {
  const written = new Set<string>();
  return {
    dbId: DbId.DEFAULT,
    dbName: 'ORCL',
    vfs: {
      writeFile: (p) => { written.add(p); return ok(undefined); },
      readFile:  () => ok(new Uint8Array(0)),
      fileExists: (p) => !missingPaths.has(p) && written.has(p),
      deleteFile: (p) => { written.delete(p); return ok(undefined); },
      availableBytes: () => 1e10,
    },
    getDatafiles: () => [
      { fileNo: 1, path: '/u01/oradata/ORCL/system01.dbf',  sizeBytes: 838_860_800, tablespace: 'SYSTEM'   },
      { fileNo: 2, path: '/u01/oradata/ORCL/sysaux01.dbf',  sizeBytes: 576_716_800, tablespace: 'SYSAUX'   },
      { fileNo: 3, path: '/u01/oradata/ORCL/undotbs01.dbf', sizeBytes: 209_715_200, tablespace: 'UNDOTBS1' },
      { fileNo: 4, path: '/u01/oradata/ORCL/users01.dbf',   sizeBytes: 104_857_600, tablespace: 'USERS'    },
    ],
    getSpfileParam: () => undefined,
  };
}

describe('§11.1 — BACKUP DATABASE end-to-end', () => {
  beforeEach(() => BackupKey._reset());

  it('publishes the canonical event sequence in order', () => {
    const { session } = RmanSession.create(['target', '/'], makeCtx());
    const types: string[] = [];
    session.events$.subscribe(e => types.push(e.type));
    session.processLine('BACKUP DATABASE');
    session.dispose();

    // Index helpers
    const idx = (t: string) => types.indexOf(t);
    expect(idx('JOB_STARTED')).toBeGreaterThanOrEqual(0);
    expect(idx('CHANNEL_ALLOCATED')).toBeGreaterThan(idx('JOB_STARTED'));
    expect(idx('PROGRESS_UPDATED')).toBeGreaterThan(idx('CHANNEL_ALLOCATED'));
    expect(idx('BACKUP_PIECE_CREATED')).toBeGreaterThan(idx('PROGRESS_UPDATED'));
    expect(idx('BACKUP_SET_COMPLETE')).toBeGreaterThan(idx('BACKUP_PIECE_CREATED'));
    expect(idx('CHANNEL_RELEASED')).toBeGreaterThan(idx('BACKUP_SET_COMPLETE'));
    expect(idx('JOB_COMPLETED')).toBeGreaterThan(idx('CHANNEL_RELEASED'));
  });
});

describe('§11.2 — RESTORE then RECOVER', () => {
  beforeEach(() => BackupKey._reset());

  it('RESTORE emits one start+complete per datafile', () => {
    const { session } = RmanSession.create(['target', '/'], makeCtx());
    session.processLine('BACKUP DATABASE');
    const events: RmanEvent[] = [];
    session.events$.subscribe(e => events.push(e));
    session.processLine('RESTORE DATABASE');
    session.dispose();

    expect(events.filter(e => e.type === 'RESTORE_DATAFILE_STARTED').length).toBe(4);
    expect(events.filter(e => e.type === 'RESTORE_DATAFILE_COMPLETED').length).toBe(4);
  });

  it('RECOVER emits recover-started + recover-completed', () => {
    const { session } = RmanSession.create(['target', '/'], makeCtx());
    const events: RmanEvent[] = [];
    session.events$.subscribe(e => events.push(e));
    session.processLine('RECOVER DATABASE');
    session.dispose();
    expect(events.some(e => e.type === 'RECOVER_STARTED')).toBe(true);
    expect(events.some(e => e.type === 'RECOVER_COMPLETED')).toBe(true);
  });
});

describe('§11.3 — CROSSCHECK with a missing piece', () => {
  beforeEach(() => BackupKey._reset());

  it('flips the piece status to EXPIRED and emits CROSSCHECK_DONE with expired=1', () => {
    const missing = new Set<string>();
    const ctx = makeCtx(missing);
    const { session } = RmanSession.create(['target', '/'], ctx);
    session.processLine('BACKUP DATABASE');

    // Discover the written piece path via a quick LIST BACKUP and parse it
    const list = session.processLine('LIST BACKUP');
    if (list.ok) {
      const piecesLine = list.value.find(l => l.includes('Piece Name:'));
      if (piecesLine) {
        const m = piecesLine.match(/Piece Name:\s+(\S+)/);
        if (m) missing.add(m[1]); // simulate physical deletion
      }
    }

    const events: RmanEvent[] = [];
    session.events$.subscribe(e => events.push(e));
    session.processLine('CROSSCHECK BACKUP');
    session.dispose();

    const done = events.find(e => e.type === 'CROSSCHECK_DONE');
    if (done && done.type === 'CROSSCHECK_DONE') {
      expect(done.expired).toBe(1);
    } else {
      throw new Error('expected CROSSCHECK_DONE');
    }
    expect(events.some(e => e.type === 'CATALOG_UPDATED' &&
      (e as { operation: string }).operation === 'EXPIRE')).toBe(true);
  });
});

describe('§11.4 — LIST BACKUP SUMMARY is synchronous', () => {
  beforeEach(() => BackupKey._reset());

  it('returns the formatted summary directly, no extra events', () => {
    const { session } = RmanSession.create(['target', '/'], makeCtx());
    session.processLine('BACKUP DATABASE');

    let eventsAfter = 0;
    const unsub = session.events$.subscribe(() => eventsAfter++);
    const r = session.processLine('LIST BACKUP SUMMARY');
    unsub();
    session.dispose();

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.some(l => /List of Backups/.test(l))).toBe(true);
    expect(eventsAfter).toBe(0); // pure synchronous, no bus traffic
  });
});

describe('Public barrel export surface', () => {
  it('exposes the high-value classes through a single import', async () => {
    const mod = await import('@/terminal/subshells/rman');
    expect(mod.RmanSession).toBeDefined();
    expect(mod.RmanSessionOptionsBuilder).toBeDefined();
    expect(mod.ReactiveRmanSubShell).toBeDefined();
    expect(mod.RmanCommandDispatcher).toBeDefined();
    expect(mod.ReactiveChannelPool).toBeDefined();
    expect(mod.InMemoryRmanCatalog).toBeDefined();
    expect(mod.RedundancyPolicy).toBeDefined();
  });
});
