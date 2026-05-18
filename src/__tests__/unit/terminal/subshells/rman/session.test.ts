/**
 * RmanSession — reactive Facade for the entire RMAN module.
 *
 * Tests cover:
 *   - state machine (IDLE → CONNECTING → CONNECTED → RUNNING_JOB → CONNECTED)
 *   - connect() emits CONNECTED + SESSION_STATE_CHANGED
 *   - processLine() of BACKUP DATABASE drives the full event sequence
 *   - LIST BACKUP returns synchronous lines
 *   - target-disconnect rejects non-meta commands
 *   - dispose() emits DISCONNECTED and tears down everything
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { RmanSession } from '@/terminal/subshells/rman/session/RmanSession';
import { RmanSessionOptionsBuilder } from '@/terminal/subshells/rman/session/RmanSessionOptionsBuilder';
import { DbId } from '@/terminal/subshells/rman/values/DbId';
import { BackupKey } from '@/terminal/subshells/rman/values/BackupKey';
import { ok } from '@/terminal/subshells/rman/core/Result';
import type { IRmanOracleContext } from '@/terminal/subshells/rman/integration/IRmanOracleContext';
import type { RmanEvent } from '@/terminal/subshells/rman/core/types';

function ctx(): IRmanOracleContext {
  return {
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
      { fileNo: 1, path: '/u01/oradata/ORCL/system01.dbf', sizeBytes: 838_860_800, tablespace: 'SYSTEM' },
    ],
    getSpfileParam: () => undefined,
  };
}

describe('RmanSessionOptionsBuilder', () => {
  it('build() produces an immutable options object with sane defaults', () => {
    const opts = new RmanSessionOptionsBuilder().build();
    expect(Object.isFrozen(opts)).toBe(true);
    expect(opts.dbId.name).toBe('ORCL');
    expect(opts.channelConfigs.length).toBeGreaterThan(0);
    // Oracle default is OFF (must be explicitly enabled via CONFIGURE CONTROLFILE AUTOBACKUP ON).
    expect(opts.autobackupCf).toBe(false);
    expect(opts.retentionPolicy.describe()).toBe('REDUNDANCY 1');
  });

  it('with-methods return the builder for fluent chaining', () => {
    const b = new RmanSessionOptionsBuilder();
    expect(b.withDebugMode(true)).toBe(b);
    expect(b.withAutobackupControlfile(false).build().autobackupCf).toBe(false);
  });
});

describe('RmanSession — lifecycle', () => {
  beforeEach(() => BackupKey._reset());

  it('starts in IDLE; connect() transitions to CONNECTED via CONNECTING', () => {
    const session = new RmanSession(new RmanSessionOptionsBuilder().build(), ctx());
    const events: RmanEvent[] = [];
    session.events$.subscribe(e => events.push(e));
    expect(session.state).toBe('IDLE');

    session.connect();
    expect(session.state).toBe('CONNECTED');

    const transitions = events
      .filter(e => e.type === 'SESSION_STATE_CHANGED')
      .map(e => `${(e as { from: string }).from}→${(e as { to: string }).to}`);
    expect(transitions).toEqual(['IDLE→CONNECTING', 'CONNECTING→CONNECTED']);
    expect(events.some(e => e.type === 'CONNECTED')).toBe(true);
  });

  it('non-meta command without connection returns RMAN_03002', () => {
    const session = new RmanSession(new RmanSessionOptionsBuilder().build(), ctx());
    const r = session.processLine('LIST BACKUP');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('RMAN_03002');
  });

  it('processLine BACKUP DATABASE drives the full sequence', () => {
    const session = new RmanSession(new RmanSessionOptionsBuilder().build(), ctx());
    session.connect();
    const events: RmanEvent[] = [];
    session.events$.subscribe(e => events.push(e));
    const r = session.processLine('BACKUP DATABASE');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([]); // async path

    const types = events.map(e => e.type);
    expect(types).toContain('JOB_STARTED');
    expect(types).toContain('CHANNEL_ALLOCATED');
    expect(types).toContain('BACKUP_PIECE_CREATED');
    expect(types).toContain('BACKUP_SET_COMPLETE');
    expect(types).toContain('CATALOG_UPDATED');
    expect(types).toContain('JOB_COMPLETED');
  });

  it('JOB_STARTED transitions CONNECTED → RUNNING_JOB and back on completion', () => {
    const session = new RmanSession(new RmanSessionOptionsBuilder().build(), ctx());
    session.connect();
    const transitions: string[] = [];
    session.events$.subscribe(e => {
      if (e.type === 'SESSION_STATE_CHANGED') transitions.push(`${e.from}→${e.to}`);
    });
    session.processLine('BACKUP DATABASE');
    expect(transitions).toEqual([
      'CONNECTED→RUNNING_JOB',
      'RUNNING_JOB→CONNECTED',
    ]);
    expect(session.state).toBe('CONNECTED');
  });

  it('LIST BACKUP returns synchronous lines after a backup', () => {
    const session = new RmanSession(new RmanSessionOptionsBuilder().build(), ctx());
    session.connect();
    session.processLine('BACKUP DATABASE');
    const r = session.processLine('LIST BACKUP SUMMARY');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.some(l => /List of Backups/.test(l))).toBe(true);
    }
  });

  it('EXIT disposes and returns "Recovery Manager complete."', () => {
    const session = new RmanSession(new RmanSessionOptionsBuilder().build(), ctx());
    session.connect();
    const events: RmanEvent[] = [];
    session.events$.subscribe(e => events.push(e));
    const r = session.processLine('EXIT');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(['Recovery Manager complete.']);
    expect(events.some(e => e.type === 'DISCONNECTED')).toBe(true);
    expect(session.state).toBe('DISCONNECTED');
  });

  it('CONNECT TARGET at runtime transitions IDLE → CONNECTED', () => {
    const session = new RmanSession(new RmanSessionOptionsBuilder().build(), ctx());
    expect(session.state).toBe('IDLE');
    const r = session.processLine('CONNECT TARGET /');
    expect(r.ok).toBe(true);
    expect(session.state).toBe('CONNECTED');
  });

  it('getBanner returns the canonical 5-line RMAN banner', () => {
    const session = new RmanSession(new RmanSessionOptionsBuilder().build(), ctx());
    const banner = session.getBanner();
    expect(banner.length).toBe(5);
    expect(banner.some(l => /Recovery Manager: Release/.test(l))).toBe(true);
  });
});

describe('RmanSession.create — factory', () => {
  it('auto-connects when "target /" is present in args', () => {
    const { session, banner } = RmanSession.create(['target', '/'], ctx());
    expect(session.state).toBe('CONNECTED');
    expect(banner.some(l => /connected to target database: ORCL/.test(l))).toBe(true);
    session.dispose();
  });

  it('does not auto-connect without target args', () => {
    const { session } = RmanSession.create([], ctx());
    expect(session.state).toBe('IDLE');
    session.dispose();
  });
});
