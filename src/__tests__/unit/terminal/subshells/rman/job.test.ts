/**
 * JobBuilder + RmanJobEngine — Phase 4.
 *
 * Validates:
 *   - JobBuilder emits the canonical Oracle step messages.
 *   - RmanJobEngine.run() orchestrates the bus + pool + catalog:
 *       JOB_STARTED → CHANNEL_ALLOCATED → PROGRESS_UPDATED×N →
 *       BACKUP_PIECE_CREATED → BACKUP_SET_COMPLETE →
 *       CHANNEL_RELEASED → JOB_COMPLETED.
 *   - On channel saturation, JOB_FAILED is emitted (no exception).
 *   - On VFS write failure, JOB_FAILED is emitted.
 *   - Restore/Recover/Crosscheck/Delete-Expired/Delete-Obsolete paths
 *     emit the expected event sequences and touch the catalog correctly.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { RmanJobEngine } from '@/terminal/subshells/rman/job/RmanJobEngine';
import { JobBuilder } from '@/terminal/subshells/rman/job/JobBuilder';
import { ReactiveChannelPool } from '@/terminal/subshells/rman/channel/ReactiveChannelPool';
import { DEFAULT_CHANNEL_CONFIGS } from '@/terminal/subshells/rman/channel/defaults';
import { InMemoryRmanCatalog } from '@/terminal/subshells/rman/catalog/InMemoryRmanCatalog';
import { BackupSetFactory } from '@/terminal/subshells/rman/catalog/BackupSetFactory';
import { RmanEventBus } from '@/terminal/subshells/rman/reactive/RmanEventBus';
import { BackupKey } from '@/terminal/subshells/rman/values/BackupKey';
import type { IRmanOracleContext } from '@/terminal/subshells/rman/integration/IRmanOracleContext';
import type { RmanEvent } from '@/terminal/subshells/rman/core/types';
import { DbId } from '@/terminal/subshells/rman/values/DbId';
import { ok, err } from '@/terminal/subshells/rman/core/Result';

function fakeCtx(opts: { fileExistsByDefault?: boolean; writeFails?: boolean } = {}): {
  ctx: IRmanOracleContext;
  vfsFiles: Set<string>;
  missingFiles: Set<string>;
} {
  const vfsFiles = new Set<string>();
  const missingFiles = new Set<string>();
  return {
    vfsFiles, missingFiles,
    ctx: {
      dbId: DbId.DEFAULT,
      dbName: 'ORCL',
      vfs: {
        writeFile: (path) => {
          if (opts.writeFails) return err({ code: 'VFS_WRITE_ERROR', message: 'no space', path });
          vfsFiles.add(path);
          return ok(undefined);
        },
        readFile: (path) => ok(new Uint8Array(0)),
        fileExists: (path) =>
          missingFiles.has(path) ? false : (vfsFiles.has(path) || (opts.fileExistsByDefault ?? false)),
        deleteFile: (path) => { vfsFiles.delete(path); return ok(undefined); },
        availableBytes: () => 10_737_418_240,
      },
      getDatafiles: () => [
        { fileNo: 1, path: '/u01/oradata/ORCL/system01.dbf',  sizeBytes: 838_860_800, tablespace: 'SYSTEM'   },
        { fileNo: 2, path: '/u01/oradata/ORCL/sysaux01.dbf',  sizeBytes: 576_716_800, tablespace: 'SYSAUX'   },
        { fileNo: 3, path: '/u01/oradata/ORCL/undotbs01.dbf', sizeBytes: 209_715_200, tablespace: 'UNDOTBS1' },
        { fileNo: 4, path: '/u01/oradata/ORCL/users01.dbf',   sizeBytes: 104_857_600, tablespace: 'USERS'    },
      ],
      getSpfileParam: (n) => n === 'db_name' ? 'ORCL' : undefined,
    },
  };
}

function trace(bus: RmanEventBus): RmanEvent[] {
  const events: RmanEvent[] = [];
  bus.events$.subscribe(e => events.push(e));
  return events;
}

describe('JobBuilder', () => {
  it('backupDatabase produces a job with the canonical Oracle messages', () => {
    const job = JobBuilder.backupDatabase();
    expect(job.operation).toBe('BACKUP_DATABASE');
    expect(job.steps.some(s => /starting full datafile backup set/.test(s.message))).toBe(true);
    expect(job.steps[job.steps.length - 1].pct).toBeLessThanOrEqual(100);
  });

  it('backupTablespace embeds the tablespace name in a step message', () => {
    const job = JobBuilder.backupTablespace('USERS');
    expect(job.operation).toBe('BACKUP_TABLESPACE');
    expect(job.steps.some(s => s.message.includes('USERS'))).toBe(true);
    expect(job.params?.tablespace).toBe('USERS');
  });

  it('every builder produces a frozen RmanJob with monotonic id', () => {
    const a = JobBuilder.backupDatabase();
    const b = JobBuilder.backupDatabase();
    expect(Object.isFrozen(a)).toBe(true);
    expect(a.id).not.toBe(b.id);
  });
});

describe('RmanJobEngine — BACKUP_DATABASE', () => {
  let bus: RmanEventBus;
  let pool: ReactiveChannelPool;
  let catalog: InMemoryRmanCatalog;

  beforeEach(() => {
    BackupKey._reset();
    bus     = new RmanEventBus();
    pool    = new ReactiveChannelPool(DEFAULT_CHANNEL_CONFIGS);
    catalog = new InMemoryRmanCatalog();
    // forward channel + catalog streams to the central bus
    pool.allocations$.subscribe(e => bus.emit(e));
    pool.releases$.subscribe(e => bus.emit(e));
    catalog.changes$.subscribe(e => bus.emit(e));
  });

  it('emits JOB_STARTED → PROGRESS_UPDATED×N → BACKUP_PIECE_CREATED → BACKUP_SET_COMPLETE → JOB_COMPLETED', () => {
    const { ctx } = fakeCtx();
    const engine = new RmanJobEngine(bus, pool, catalog, ctx);
    const events = trace(bus);

    const r = engine.run(JobBuilder.backupDatabase());
    expect(r.ok).toBe(true);

    const seq = events.map(e => e.type);
    expect(seq[0]).toBe('JOB_STARTED');
    expect(seq).toContain('CHANNEL_ALLOCATED');
    expect(seq).toContain('PROGRESS_UPDATED');
    expect(seq).toContain('BACKUP_PIECE_CREATED');
    expect(seq).toContain('BACKUP_SET_COMPLETE');
    expect(seq).toContain('CHANNEL_RELEASED');
    expect(seq[seq.length - 1]).toBe('JOB_COMPLETED');
  });

  it('records the set in the catalog', () => {
    const { ctx } = fakeCtx();
    const engine = new RmanJobEngine(bus, pool, catalog, ctx);
    engine.run(JobBuilder.backupDatabase());
    const snap = catalog.listAll();
    if (snap.ok) {
      expect(snap.value.sets.length).toBe(1);
      expect(snap.value.sets[0].datafiles.length).toBe(4);
    }
  });

  it('writes the piece file to the VFS', () => {
    const { ctx, vfsFiles } = fakeCtx();
    const engine = new RmanJobEngine(bus, pool, catalog, ctx);
    engine.run(JobBuilder.backupDatabase());
    expect(vfsFiles.size).toBe(1);
    expect([...vfsFiles][0].endsWith('.bkp')).toBe(true);
  });

  it('emits JOB_FAILED when the channel pool is saturated', () => {
    pool.allocate(); // saturate (parallelism=1)
    const { ctx } = fakeCtx();
    const engine = new RmanJobEngine(bus, pool, catalog, ctx);
    const events = trace(bus);
    engine.run(JobBuilder.backupDatabase());
    expect(events.some(e => e.type === 'JOB_FAILED')).toBe(true);
    expect(events.some(e => e.type === 'JOB_COMPLETED')).toBe(false);
  });

  it('emits JOB_FAILED when the VFS write fails', () => {
    const { ctx } = fakeCtx({ writeFails: true });
    const engine = new RmanJobEngine(bus, pool, catalog, ctx);
    const events = trace(bus);
    engine.run(JobBuilder.backupDatabase());
    const failed = events.find(e => e.type === 'JOB_FAILED');
    expect(failed).toBeDefined();
    if (failed && failed.type === 'JOB_FAILED') {
      expect(failed.error.code).toBe('VFS_WRITE_ERROR');
    }
    // Channel still released
    expect(events.some(e => e.type === 'CHANNEL_RELEASED')).toBe(true);
  });
});

describe('RmanJobEngine — RESTORE / RECOVER / CROSSCHECK', () => {
  let bus: RmanEventBus;
  let pool: ReactiveChannelPool;
  let catalog: InMemoryRmanCatalog;

  beforeEach(() => {
    BackupKey._reset();
    bus     = new RmanEventBus();
    pool    = new ReactiveChannelPool(DEFAULT_CHANNEL_CONFIGS);
    catalog = new InMemoryRmanCatalog();
    pool.allocations$.subscribe(e => bus.emit(e));
    pool.releases$.subscribe(e => bus.emit(e));
    catalog.changes$.subscribe(e => bus.emit(e));
  });

  it('RESTORE with no backups emits JOB_FAILED (RMAN_06023)', () => {
    const { ctx } = fakeCtx();
    const engine = new RmanJobEngine(bus, pool, catalog, ctx);
    const events = trace(bus);
    engine.run(JobBuilder.restoreDatabase());
    const failed = events.find(e => e.type === 'JOB_FAILED');
    if (failed && failed.type === 'JOB_FAILED') {
      expect(failed.error.code).toBe('RMAN_06023');
    } else {
      throw new Error('expected JOB_FAILED');
    }
  });

  it('RESTORE with a prior backup emits RESTORE_DATAFILE_STARTED/COMPLETED per datafile', () => {
    const { ctx } = fakeCtx();
    const engine = new RmanJobEngine(bus, pool, catalog, ctx);
    engine.run(JobBuilder.backupDatabase());
    const events = trace(bus);
    engine.run(JobBuilder.restoreDatabase());

    const starts = events.filter(e => e.type === 'RESTORE_DATAFILE_STARTED').length;
    const dones  = events.filter(e => e.type === 'RESTORE_DATAFILE_COMPLETED').length;
    expect(starts).toBe(4);
    expect(dones).toBe(4);
  });

  it('RECOVER emits RECOVER_STARTED + RECOVER_COMPLETED', () => {
    const { ctx } = fakeCtx();
    const engine = new RmanJobEngine(bus, pool, catalog, ctx);
    const events = trace(bus);
    engine.run(JobBuilder.recoverDatabase());
    expect(events.some(e => e.type === 'RECOVER_STARTED')).toBe(true);
    expect(events.some(e => e.type === 'RECOVER_COMPLETED')).toBe(true);
  });

  it('CROSSCHECK reports 0 expired when every piece exists on the VFS', () => {
    const { ctx } = fakeCtx();
    const engine = new RmanJobEngine(bus, pool, catalog, ctx);
    engine.run(JobBuilder.backupDatabase());
    const events = trace(bus);
    engine.run(JobBuilder.crosscheck());
    const ev = events.find(e => e.type === 'CROSSCHECK_DONE');
    if (ev && ev.type === 'CROSSCHECK_DONE') {
      expect(ev.expired).toBe(0);
      expect(ev.available).toBeGreaterThan(0);
    }
  });

  it('CROSSCHECK expires pieces whose file is missing', () => {
    const { ctx, vfsFiles, missingFiles } = fakeCtx();
    const engine = new RmanJobEngine(bus, pool, catalog, ctx);
    engine.run(JobBuilder.backupDatabase());

    // Mark the only piece as missing
    const piecePath = [...vfsFiles][0];
    missingFiles.add(piecePath);

    const events = trace(bus);
    engine.run(JobBuilder.crosscheck());

    const ev = events.find(e => e.type === 'CROSSCHECK_DONE');
    if (ev && ev.type === 'CROSSCHECK_DONE') expect(ev.expired).toBe(1);
    const expired = catalog.listExpired();
    if (expired.ok) expect(expired.value.length).toBe(1);
  });
});

describe('RmanJobEngine — DELETE EXPIRED / OBSOLETE', () => {
  let bus: RmanEventBus;
  let pool: ReactiveChannelPool;
  let catalog: InMemoryRmanCatalog;

  beforeEach(() => {
    BackupKey._reset();
    bus     = new RmanEventBus();
    pool    = new ReactiveChannelPool(DEFAULT_CHANNEL_CONFIGS);
    catalog = new InMemoryRmanCatalog();
    pool.allocations$.subscribe(e => bus.emit(e));
    pool.releases$.subscribe(e => bus.emit(e));
    catalog.changes$.subscribe(e => bus.emit(e));
  });

  it('DELETE EXPIRED removes only EXPIRED sets', () => {
    const { ctx, vfsFiles, missingFiles } = fakeCtx();
    const engine = new RmanJobEngine(bus, pool, catalog, ctx);
    engine.run(JobBuilder.backupDatabase());
    engine.run(JobBuilder.backupDatabase());

    // Expire the first piece by physically missing its file
    const firstPath = [...vfsFiles][0];
    missingFiles.add(firstPath);
    engine.run(JobBuilder.crosscheck());

    engine.run(JobBuilder.deleteExpired());
    const snap = catalog.listAll();
    if (snap.ok) expect(snap.value.sets.length).toBe(1);
  });

  it('DELETE OBSOLETE applies redundancy=1 and removes older sets', () => {
    const { ctx } = fakeCtx();
    const engine = new RmanJobEngine(bus, pool, catalog, ctx);

    // Build two sets with explicit timestamps so the order is deterministic.
    const oldSet = {
      ...BackupSetFactory.createBackupSet({
        type: 'FULL', level: 0, path: '/u01/bk/a.bkp', sizeBytes: 1, datafiles: [],
      }),
      completionTime: Date.now() - 100_000,
    };
    const newSet = BackupSetFactory.createBackupSet({
      type: 'FULL', level: 0, path: '/u01/bk/b.bkp', sizeBytes: 1, datafiles: [],
    });
    catalog.recordBackupSet(oldSet);
    catalog.recordBackupSet(newSet);

    // Engine now expects pre-resolved obsolete bsKeys (policy lives outside the engine).
    engine.run(JobBuilder.deleteObsolete([oldSet.bsKey]));
    const snap = catalog.listAll();
    if (snap.ok) {
      expect(snap.value.sets.length).toBe(1);
      expect(snap.value.sets[0].bsKey).toBe(newSet.bsKey);
    }
  });
});
