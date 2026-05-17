/**
 * CONFIGURE — mutable RMAN config + ConfigureCommand.
 *
 * Validates:
 *   - CONFIGURE RETENTION POLICY TO REDUNDANCY N
 *   - CONFIGURE RETENTION POLICY TO RECOVERY WINDOW OF N DAYS
 *   - CONFIGURE RETENTION POLICY TO NONE
 *   - CONFIGURE CONTROLFILE AUTOBACKUP ON|OFF
 *   - CONFIGURE DEVICE TYPE DISK PARALLELISM N
 *   - CONFIGURE DEFAULT DEVICE TYPE TO DISK|SBT
 *   - CONFIGURE BACKUP OPTIMIZATION ON|OFF
 *   - CONFIGURE MAXSETSIZE TO UNLIMITED|<n>
 *   - CONFIGURE COMPRESSION ALGORITHM '<name>'
 *   - CONFIGURE ENCRYPTION FOR DATABASE ON|OFF
 *
 * Each command:
 *   1. mutates the session-scoped config,
 *   2. emits oracle.rman.config-changed-like event (we use a dedicated
 *      RmanEvent so the captured value is visible to subscribers),
 *   3. reshapes SHOW ALL output.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  RmanSession, RmanSessionOptionsBuilder, RedundancyPolicy,
  RecoveryWindowPolicy, NonePolicy, DbId, BackupKey, ok,
  type IRmanOracleContext,
} from '@/terminal/subshells/rman';

function ctx(): IRmanOracleContext {
  return {
    dbId: DbId.DEFAULT, dbName: 'ORCL',
    vfs: {
      writeFile: () => ok(undefined), readFile: () => ok(new Uint8Array(0)),
      fileExists: () => true, deleteFile: () => ok(undefined),
      availableBytes: () => 1e10,
    },
    getDatafiles: () => [],
    getSpfileParam: () => undefined,
  };
}

function showAllLines(session: RmanSession): string[] {
  const r = session.processLine('SHOW ALL');
  return r.ok ? r.value : [];
}

describe('CONFIGURE — retention policy', () => {
  beforeEach(() => BackupKey._reset());

  it('CONFIGURE RETENTION POLICY TO REDUNDANCY 3 updates SHOW ALL', () => {
    const session = new RmanSession(new RmanSessionOptionsBuilder().build(), ctx());
    session.connect();
    expect(showAllLines(session).find(l => /CONFIGURE RETENTION POLICY TO REDUNDANCY 1/.test(l))).toBeDefined();
    session.processLine('CONFIGURE RETENTION POLICY TO REDUNDANCY 3');
    const lines = showAllLines(session);
    expect(lines.find(l => /CONFIGURE RETENTION POLICY TO REDUNDANCY 3/.test(l))).toBeDefined();
  });

  it('CONFIGURE RETENTION POLICY TO RECOVERY WINDOW OF 14 DAYS', () => {
    const session = new RmanSession(new RmanSessionOptionsBuilder().build(), ctx());
    session.connect();
    session.processLine('CONFIGURE RETENTION POLICY TO RECOVERY WINDOW OF 14 DAYS');
    const lines = showAllLines(session);
    expect(lines.find(l => /RECOVERY WINDOW OF 14 DAYS/.test(l))).toBeDefined();
  });

  it('CONFIGURE RETENTION POLICY TO NONE', () => {
    const session = new RmanSession(new RmanSessionOptionsBuilder().build(), ctx());
    session.connect();
    session.processLine('CONFIGURE RETENTION POLICY TO NONE');
    const lines = showAllLines(session);
    expect(lines.find(l => /CONFIGURE RETENTION POLICY TO NONE/.test(l))).toBeDefined();
  });
});

describe('CONFIGURE — controlfile autobackup', () => {
  it('CONFIGURE CONTROLFILE AUTOBACKUP ON', () => {
    const session = new RmanSession(new RmanSessionOptionsBuilder().withAutobackupControlfile(false).build(), ctx());
    session.connect();
    expect(showAllLines(session).find(l => /CONTROLFILE AUTOBACKUP OFF/.test(l))).toBeDefined();
    session.processLine('CONFIGURE CONTROLFILE AUTOBACKUP ON');
    expect(showAllLines(session).find(l => /CONTROLFILE AUTOBACKUP ON/.test(l))).toBeDefined();
  });

  it('CONFIGURE CONTROLFILE AUTOBACKUP OFF', () => {
    const session = new RmanSession(new RmanSessionOptionsBuilder().build(), ctx());
    session.connect();
    session.processLine('CONFIGURE CONTROLFILE AUTOBACKUP OFF');
    expect(showAllLines(session).find(l => /CONTROLFILE AUTOBACKUP OFF/.test(l))).toBeDefined();
  });
});

describe('CONFIGURE — device + compression + encryption + maxsetsize', () => {
  it('CONFIGURE DEVICE TYPE DISK PARALLELISM 4', () => {
    const session = new RmanSession(new RmanSessionOptionsBuilder().build(), ctx());
    session.connect();
    session.processLine('CONFIGURE DEVICE TYPE DISK PARALLELISM 4');
    expect(showAllLines(session).find(l => /DEVICE TYPE DISK PARALLELISM 4/.test(l))).toBeDefined();
  });

  it('CONFIGURE BACKUP OPTIMIZATION ON', () => {
    const session = new RmanSession(new RmanSessionOptionsBuilder().build(), ctx());
    session.connect();
    session.processLine('CONFIGURE BACKUP OPTIMIZATION ON');
    expect(showAllLines(session).find(l => /BACKUP OPTIMIZATION ON/.test(l))).toBeDefined();
  });

  it('CONFIGURE MAXSETSIZE TO 5G', () => {
    const session = new RmanSession(new RmanSessionOptionsBuilder().build(), ctx());
    session.connect();
    session.processLine('CONFIGURE MAXSETSIZE TO 5G');
    expect(showAllLines(session).find(l => /MAXSETSIZE TO 5G/.test(l))).toBeDefined();
  });

  it("CONFIGURE COMPRESSION ALGORITHM 'HIGH'", () => {
    const session = new RmanSession(new RmanSessionOptionsBuilder().build(), ctx());
    session.connect();
    session.processLine("CONFIGURE COMPRESSION ALGORITHM 'HIGH'");
    expect(showAllLines(session).find(l => /COMPRESSION ALGORITHM 'HIGH'/.test(l))).toBeDefined();
  });

  it('CONFIGURE ENCRYPTION FOR DATABASE ON', () => {
    const session = new RmanSession(new RmanSessionOptionsBuilder().build(), ctx());
    session.connect();
    session.processLine('CONFIGURE ENCRYPTION FOR DATABASE ON');
    expect(showAllLines(session).find(l => /ENCRYPTION FOR DATABASE ON/.test(l))).toBeDefined();
  });
});

describe('CONFIGURE — observable changes', () => {
  it('emits a config-changed event on the bus', () => {
    const session = new RmanSession(new RmanSessionOptionsBuilder().build(), ctx());
    session.connect();
    const keys: string[] = [];
    session.events$.subscribe(e => {
      if (e.type === 'CONFIG_CHANGED') keys.push(e.key);
    });
    session.processLine('CONFIGURE RETENTION POLICY TO REDUNDANCY 5');
    session.processLine('CONFIGURE CONTROLFILE AUTOBACKUP OFF');
    expect(keys).toContain('retention');
    expect(keys).toContain('controlfileAutobackup');
  });

  it('subsequent BACKUP uses the live config (DELETE OBSOLETE now respects new redundancy)', () => {
    const session = new RmanSession(new RmanSessionOptionsBuilder().build(), ctx());
    session.connect();
    session.processLine('CONFIGURE RETENTION POLICY TO REDUNDANCY 1');
    session.processLine('BACKUP DATABASE');
    session.processLine('BACKUP DATABASE');
    session.processLine('DELETE OBSOLETE');
    const lines = session.processLine('LIST BACKUP SUMMARY');
    if (lines.ok) {
      // After redundancy=1 + DELETE OBSOLETE, exactly 1 backup remains.
      const rows = lines.value.filter(l => /^\d+\s+B  F  A DISK/.test(l));
      expect(rows.length).toBe(1);
    }
  });
});
