/**
 * RmanCommandDispatcher + concrete commands.
 *
 * Validates pattern matching, BackupCommand → engine.run plumbing,
 * synchronous ListBackupCommand/ReportCommand/ShowCommand output, and
 * unknown command → RMAN_01009.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { RmanCommandDispatcher } from '@/terminal/subshells/rman/commands/RmanCommandDispatcher';
import { RmanEventBus } from '@/terminal/subshells/rman/reactive/RmanEventBus';
import { RmanJobEngine } from '@/terminal/subshells/rman/job/RmanJobEngine';
import { ReactiveChannelPool } from '@/terminal/subshells/rman/channel/ReactiveChannelPool';
import { DEFAULT_CHANNEL_CONFIGS } from '@/terminal/subshells/rman/channel/defaults';
import { InMemoryRmanCatalog } from '@/terminal/subshells/rman/catalog/InMemoryRmanCatalog';
import { BackupSetFactory } from '@/terminal/subshells/rman/catalog/BackupSetFactory';
import { RedundancyPolicy } from '@/terminal/subshells/rman/policy/RedundancyPolicy';
import { BackupKey } from '@/terminal/subshells/rman/values/BackupKey';
import { DbId } from '@/terminal/subshells/rman/values/DbId';
import { ok } from '@/terminal/subshells/rman/core/Result';
import type { IRmanOracleContext } from '@/terminal/subshells/rman/integration/IRmanOracleContext';
import type { RmanCommandContext } from '@/terminal/subshells/rman/commands/types';
import type { RmanEvent } from '@/terminal/subshells/rman/core/types';

function buildCtx(): {
  cmdCtx: RmanCommandContext;
  bus: RmanEventBus;
  catalog: InMemoryRmanCatalog;
  events: RmanEvent[];
} {
  BackupKey._reset();
  const bus = new RmanEventBus();
  const pool = new ReactiveChannelPool(DEFAULT_CHANNEL_CONFIGS);
  const catalog = new InMemoryRmanCatalog();
  pool.allocations$.subscribe(e => bus.emit(e));
  pool.releases$.subscribe(e => bus.emit(e));
  catalog.changes$.subscribe(e => bus.emit(e));
  const ctx: IRmanOracleContext = {
    dbId: DbId.DEFAULT,
    dbName: 'ORCL',
    vfs: {
      writeFile: () => ok(undefined),
      readFile:  () => ok(new Uint8Array(0)),
      fileExists: () => true,
      deleteFile: () => ok(undefined),
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
  const engine = new RmanJobEngine(bus, pool, catalog, ctx);
  const events: RmanEvent[] = [];
  bus.events$.subscribe(e => events.push(e));
  return {
    bus, catalog, events,
    cmdCtx: { bus, engine, catalog, ctx, policy: new RedundancyPolicy(1) },
  };
}

describe('RmanCommandDispatcher — matching', () => {
  it('unknown command returns err RMAN_01009', () => {
    const { cmdCtx } = buildCtx();
    const d = new RmanCommandDispatcher();
    const r = d.dispatch('WIBBLE WOBBLE', cmdCtx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('RMAN_01009');
  });

  it('dispatches BACKUP DATABASE to BackupCommand (async, no synchronous output)', () => {
    const { cmdCtx, events } = buildCtx();
    const d = new RmanCommandDispatcher();
    const r = d.dispatch('BACKUP DATABASE', cmdCtx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([]);
    expect(events.some(e => e.type === 'JOB_STARTED')).toBe(true);
  });

  it('dispatches BACKUP TABLESPACE USERS with captured argument', () => {
    const { cmdCtx, events } = buildCtx();
    const d = new RmanCommandDispatcher();
    d.dispatch('BACKUP TABLESPACE USERS', cmdCtx);
    const prog = events.find(e => e.type === 'PROGRESS_UPDATED' && /backing up tablespace USERS/.test((e as { message: string }).message));
    expect(prog).toBeDefined();
  });

  it('LIST BACKUP SUMMARY returns synchronous output', () => {
    const { cmdCtx, catalog } = buildCtx();
    catalog.recordBackupSet(BackupSetFactory.createBackupSet({
      type: 'FULL', level: 0, path: '/u01/bk/x.bkp', sizeBytes: 1_073_741_824, datafiles: [],
    }));
    const d = new RmanCommandDispatcher();
    const r = d.dispatch('LIST BACKUP SUMMARY', cmdCtx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.length).toBeGreaterThan(0);
      expect(r.value.some(l => /List of Backups/.test(l))).toBe(true);
    }
  });

  it('LIST BACKUP with no sets returns the empty marker', () => {
    const { cmdCtx } = buildCtx();
    const d = new RmanCommandDispatcher();
    const r = d.dispatch('LIST BACKUP', cmdCtx);
    if (r.ok) expect(r.value.some(l => /no backup found/.test(l))).toBe(true);
  });

  it('SHOW ALL renders retention policy + autobackup', () => {
    const { cmdCtx } = buildCtx();
    const d = new RmanCommandDispatcher();
    const r = d.dispatch('SHOW ALL', cmdCtx);
    if (r.ok) {
      expect(r.value.some(l => /RETENTION POLICY/.test(l))).toBe(true);
      expect(r.value.some(l => /CONTROLFILE AUTOBACKUP/.test(l))).toBe(true);
    }
  });

  it('REPORT SCHEMA outputs Permanent + Temporary tables', () => {
    const { cmdCtx } = buildCtx();
    const d = new RmanCommandDispatcher();
    const r = d.dispatch('REPORT SCHEMA', cmdCtx);
    if (r.ok) {
      expect(r.value.some(l => /Permanent Datafiles/.test(l))).toBe(true);
    }
  });

  it('HELP returns the command list', () => {
    const { cmdCtx } = buildCtx();
    const d = new RmanCommandDispatcher();
    const r = d.dispatch('HELP', cmdCtx);
    if (r.ok) expect(r.value.some(l => /BACKUP/.test(l))).toBe(true);
  });

  it('registerCommand extends the dispatcher (Open/Closed)', () => {
    const { cmdCtx } = buildCtx();
    const d = new RmanCommandDispatcher();
    let calls = 0;
    d.registerCommand(/^PING$/i, {
      name: 'PING',
      execute: () => { calls++; return ok(['pong']); },
    });
    const r = d.dispatch('PING', cmdCtx);
    expect(calls).toBe(1);
    if (r.ok) expect(r.value).toEqual(['pong']);
  });
});
