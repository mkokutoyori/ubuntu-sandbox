/**
 * Reactive aggregation — derived streams + scan / startWith / take.
 *
 * Validates that the RmanEventBus exposes higher-order observables for
 * session-wide metrics, active job tracking, and channel set membership.
 * These are computed via the same operator pipeline (scan/distinct) used
 * elsewhere — no imperative state shared with the producers.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  RmanSession, RmanSessionOptionsBuilder, BackupKey, DbId, ok,
  Operators,
  type IRmanOracleContext, type RmanEvent, type SessionMetrics,
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

describe('Operators: scan / startWith / take', () => {
  beforeEach(() => BackupKey._reset());

  it('scan folds a running counter across the event stream', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), makeCtx());
    s.connect();
    const counts: number[] = [];
    s.events$.pipe(
      Operators.filter((e: RmanEvent) => e.type === 'JOB_COMPLETED'),
      Operators.scan(0, (acc) => acc + 1),
    ).subscribe(n => counts.push(n));

    s.processLine('BACKUP DATABASE');
    s.processLine('BACKUP DATABASE');
    s.processLine('BACKUP DATABASE');
    expect(counts).toEqual([1, 2, 3]);
  });

  it('startWith seeds the stream synchronously', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), makeCtx());
    const seen: string[] = [];
    s.events$.pipe(
      Operators.map((e: RmanEvent) => e.type),
      Operators.startWith<string>('__INIT__'),
    ).subscribe(v => seen.push(v));
    s.connect();
    expect(seen[0]).toBe('__INIT__');
    expect(seen.length).toBeGreaterThan(1);
  });

  it('take(n) auto-unsubscribes after n emissions', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), makeCtx());
    s.connect();
    const seen: string[] = [];
    s.events$.pipe(
      Operators.filter((e: RmanEvent) => e.type === 'JOB_COMPLETED'),
      Operators.take(2),
    ).subscribe(e => seen.push(e.type));
    s.processLine('BACKUP DATABASE');
    s.processLine('BACKUP DATABASE');
    s.processLine('BACKUP DATABASE');
    expect(seen.length).toBe(2);
  });
});

describe('Bus aggregation: metrics$ / activeJob$ / activeChannels$', () => {
  beforeEach(() => BackupKey._reset());

  it('metrics$ aggregates jobs/pieces/bytes over the session', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), makeCtx());
    s.connect();
    const snaps: SessionMetrics[] = [];
    s.metrics$.subscribe(m => snaps.push(m));
    s.processLine('BACKUP DATABASE');
    s.processLine('BACKUP DATABASE');
    const last = snaps[snaps.length - 1];
    expect(last.jobsCompleted).toBe(2);
    expect(last.piecesCreated).toBe(2);
    expect(last.totalBytesBackedUp).toBe(2_000);
    expect(last.jobsFailed).toBe(0);
  });

  it('activeJob$ tracks the currently-running jobId (null when idle)', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), makeCtx());
    s.connect();
    const phases: Array<string | null> = [];
    s.activeJob$.subscribe(j => phases.push(j));
    s.processLine('BACKUP DATABASE');
    // Sequence: null (initial) → JOB-N (started) → null (completed)
    expect(phases[0]).toBeNull();
    expect(phases[1]).toMatch(/^JOB-/);
    expect(phases[phases.length - 1]).toBeNull();
  });

  it('activeChannels$ exposes the live set of allocated channelIds', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), makeCtx());
    s.connect();
    const sizes: number[] = [];
    s.activeChannels$.subscribe(set => sizes.push(set.size));
    s.processLine('BACKUP DATABASE');
    // Should bounce 0 → 1 → 0 around the single backup job.
    expect(sizes[0]).toBe(0);
    expect(Math.max(...sizes)).toBe(1);
    expect(sizes[sizes.length - 1]).toBe(0);
  });
});
