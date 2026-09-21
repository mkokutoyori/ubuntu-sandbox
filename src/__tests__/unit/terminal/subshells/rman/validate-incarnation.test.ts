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
 *
 * Quatre cas lisaient l'etiquette `what` de BACKUP_VALIDATED, qui
 * REECRIVAIT la portee deja annoncee par les etapes du job
 * (« channel ORA_DISK_1: validating datafile 4 ») — deux ecritures du
 * meme fait. Le lot qui fait VRAIMENT verifier VALIDATE porte le
 * resultat dans VALIDATION_REPORT et laisse la portee aux etapes ;
 * les cas lisent desormais ces deux canaux. Le fait mesure ne change
 * pas : la sortie nomme bien le datafile et le tablespace demandes.
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

  it('VALIDATE DATABASE reports every datafile, no piece written', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), makeCtx());
    s.connect();
    const types: string[] = [];
    const rapports: Array<Extract<RmanEvent, { type: 'VALIDATION_REPORT' }>> = [];
    s.events$.subscribe(e => {
      types.push(e.type);
      if (e.type === 'VALIDATION_REPORT') rapports.push(e);
    });
    s.processLine('VALIDATE DATABASE');
    expect(types).toContain('VALIDATION_REPORT');
    expect(types).not.toContain('BACKUP_PIECE_CREATED');
    expect(types).toContain('JOB_COMPLETED');
    expect(rapports[0].files.map(f => f.fileNo)).toEqual([1, 4]);
  });

  it('VALIDATE TABLESPACE USERS scopes the validation message', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), makeCtx());
    s.connect();
    const messages: string[] = [];
    const rapports: Array<Extract<RmanEvent, { type: 'VALIDATION_REPORT' }>> = [];
    s.events$.subscribe(e => {
      if (e.type === 'PROGRESS_UPDATED') messages.push(e.message);
      if (e.type === 'VALIDATION_REPORT') rapports.push(e);
    });
    s.processLine('VALIDATE TABLESPACE USERS');
    expect(messages.some(m => /tablespace\s+USERS/i.test(m))).toBe(true);
    expect(rapports[0].files.map(f => f.fileNo)).toEqual([4]);
  });

  it('VALIDATE DATAFILE 4 references the file number', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), makeCtx());
    s.connect();
    const messages: string[] = [];
    const rapports: Array<Extract<RmanEvent, { type: 'VALIDATION_REPORT' }>> = [];
    s.events$.subscribe(e => {
      if (e.type === 'PROGRESS_UPDATED') messages.push(e.message);
      if (e.type === 'VALIDATION_REPORT') rapports.push(e);
    });
    s.processLine('VALIDATE DATAFILE 4');
    expect(messages.some(m => /datafile\s+4/i.test(m))).toBe(true);
    expect(rapports[0].files.map(f => f.fileNo)).toEqual([4]);
  });

  it('VALIDATE BACKUPSET <bsKey> succeeds against a recorded set', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), makeCtx());
    s.connect();
    s.processLine('BACKUP DATABASE');
    const types: string[] = [];
    s.events$.subscribe(e => types.push(e.type));
    const r = s.processLine('VALIDATE BACKUPSET 1');
    expect(r.ok).toBe(true);
    expect(types).toContain('VALIDATION_REPORT');
    expect(types).not.toContain('JOB_FAILED');
  });

  it('VALIDATE BACKUPSET against a missing key returns RMAN-06004', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), makeCtx());
    s.connect();
    const r = s.processLine('VALIDATE BACKUPSET 999');
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.error.code).toBe('RMAN_06004');
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
