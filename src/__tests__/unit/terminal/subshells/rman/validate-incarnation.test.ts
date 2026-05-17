/**
 * VALIDATE / LIST INCARNATION + a reactive composition example.
 *
 *   VALIDATE DATABASE
 *   VALIDATE TABLESPACE <name>
 *   VALIDATE DATAFILE <n>
 *   VALIDATE BACKUPSET <bsKey>
 *
 *   LIST INCARNATION OF DATABASE
 *
 * Composition: derived([session.metrics, session.activeJob]) → "is busy"
 * boolean signal. Demonstrates the project's derived() primitive against
 * our BehaviorSubject-style RmanObservables (wrapped into a Signal).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WritableSignal, derived } from '@/events/Signal';
import {
  RmanSession, RmanSessionOptionsBuilder, BackupKey, DbId, ok,
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
      { fileNo: 1, path: '/u01/oradata/ORCL/system01.dbf', sizeBytes: 1_000, tablespace: 'SYSTEM' },
      { fileNo: 4, path: '/u01/oradata/ORCL/users01.dbf',  sizeBytes: 1_000, tablespace: 'USERS'  },
    ],
    getSpfileParam: () => undefined,
    getInstanceState: () => 'OPEN',
  } as unknown as IRmanOracleContext;
}

describe('VALIDATE command', () => {
  beforeEach(() => BackupKey._reset());

  it('VALIDATE DATABASE emits BACKUP_VALIDATED for each datafile, no piece written', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), makeCtx());
    s.connect();
    const types: string[] = [];
    s.events$.subscribe(e => types.push(e.type));
    s.processLine('VALIDATE DATABASE');
    expect(types).toContain('BACKUP_VALIDATED');
    expect(types).not.toContain('BACKUP_PIECE_CREATED');
    expect(types).toContain('JOB_COMPLETED');
  });

  it('VALIDATE TABLESPACE USERS scopes the validation message', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), makeCtx());
    s.connect();
    const messages: string[] = [];
    s.events$.subscribe(e => {
      if (e.type === 'BACKUP_VALIDATED') messages.push((e as Extract<RmanEvent, { type: 'BACKUP_VALIDATED' }>).what);
    });
    s.processLine('VALIDATE TABLESPACE USERS');
    expect(messages.some(m => /tablespace\s+USERS/i.test(m))).toBe(true);
  });

  it('VALIDATE DATAFILE 4 references the file number', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), makeCtx());
    s.connect();
    const messages: string[] = [];
    s.events$.subscribe(e => {
      if (e.type === 'BACKUP_VALIDATED') messages.push((e as Extract<RmanEvent, { type: 'BACKUP_VALIDATED' }>).what);
    });
    s.processLine('VALIDATE DATAFILE 4');
    expect(messages.some(m => /datafile\s+4/i.test(m))).toBe(true);
  });

  it('VALIDATE BACKUPSET <bsKey> succeeds against a recorded set', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), makeCtx());
    s.connect();
    s.processLine('BACKUP DATABASE');
    const types: string[] = [];
    s.events$.subscribe(e => types.push(e.type));
    const r = s.processLine('VALIDATE BACKUPSET 1');
    expect(r.ok).toBe(true);
    expect(types).toContain('BACKUP_VALIDATED');
  });

  it('VALIDATE BACKUPSET against a missing key returns RMAN-06004', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), makeCtx());
    s.connect();
    const r = s.processLine('VALIDATE BACKUPSET 999');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('RMAN_06004');
  });
});

describe('LIST INCARNATION OF DATABASE', () => {
  it('returns a single row for the current incarnation', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), makeCtx());
    s.connect();
    const r = s.processLine('LIST INCARNATION OF DATABASE');
    expect(r.ok).toBe(true);
    if (r.ok) {
      const txt = r.value.join('\n');
      expect(txt).toMatch(/List of Database Incarnations/i);
      expect(txt).toContain('ORCL');
      expect(txt).toMatch(/CURRENT|PARENT/);
    }
  });
});

describe('derived() composition over session signals', () => {
  beforeEach(() => BackupKey._reset());

  it('a derived "isBusy" signal toggles around an active job', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), makeCtx());
    s.connect();

    // Mirror the session's activeJob$ into a project Signal so derived()
    // can take its dependency vector — the bridge is a one-liner.
    const activeJobSig = new WritableSignal<string | null>(null);
    s.activeJob$.subscribe(v => activeJobSig.set(v));

    const isBusy = derived([activeJobSig], () => activeJobSig.get() !== null);
    const seen: boolean[] = [];
    isBusy.subscribe(() => seen.push(isBusy.get()));

    s.processLine('BACKUP DATABASE');
    // True flipped on at JOB_STARTED, off again at JOB_COMPLETED.
    expect(seen).toContain(true);
    expect(seen[seen.length - 1]).toBe(false);
  });
});
