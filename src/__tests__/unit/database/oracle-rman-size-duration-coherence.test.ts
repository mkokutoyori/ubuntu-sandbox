/**
 * RMAN backup piece size/duration realism — audit 10, constats
 * critiques #9 and #10.
 *
 * #9: the VFS backup piece file was always written as an empty
 * buffer, so its physical size (~37 bytes, the literal placeholder
 * string) never matched the size RMAN's own catalog reports via
 * `LIST BACKUP` (which can say "1.61G"). A real `ls -l`/`du`/`stat` on
 * the backup destination would always contradict RMAN.
 *
 * #10: `BACKUP INCREMENTAL LEVEL 1` computed the exact same
 * `totalSize` as a `LEVEL 0`/FULL backup — the central pedagogical
 * point of incremental backups (smaller than a full) was never
 * demonstrable, and the "elapsed time" line was a hardcoded constant
 * regardless of backup size.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances } from '@/terminal/commands/database';
import { SqlPlusSubShell } from '@/terminal/subshells/SqlPlusSubShell';
import { ReactiveRmanSubShell } from '@/terminal/subshells/rman';
import { DeviceCatalogRegistry } from '@/terminal/subshells/rman/catalog/DeviceCatalogRegistry';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  resetAllOracleInstances();
  Logger.reset();
});

function bootOracleServer(name: string): LinuxServer {
  const srv = new LinuxServer('linux-server', name, 0, 0);
  SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell.dispose();
  return srv;
}

const sh = (srv: LinuxServer, cmd: string) => srv.executeShellCommandSync(cmd);

function statSize(srv: LinuxServer, path: string): number {
  return Number(sh(srv, `stat -c %s ${path}`).trim());
}

function catalogSets(srv: LinuxServer) {
  const snap = DeviceCatalogRegistry.get(srv.getId()).listAll();
  if (!snap.ok) throw new Error('catalog listAll failed');
  return snap.value.sets;
}

describe('constat #9 — VFS piece size matches the RMAN catalog', () => {
  it('a FULL backup piece on disk is exactly the size RMAN\'s own catalog declares', () => {
    const srv = bootOracleServer('sz1');
    const rman = ReactiveRmanSubShell.create(srv, ['target', '/']);
    rman.subShell.processLine('backup database;');
    rman.subShell.dispose();

    const sets = catalogSets(srv);
    expect(sets.length).toBeGreaterThan(0);
    const set = sets[0];
    const piecePath = set.pieces[0].path;

    expect(statSize(srv, piecePath)).toBe(set.pieces[0].sizeBytes);
    // The old placeholder string was always ~37 bytes regardless of the
    // declared size — a real backup piece must not collapse to that.
    expect(set.pieces[0].sizeBytes).toBeGreaterThan(1000);
  });

  it('a backup with MAXPIECESIZE splits into several pieces, each matching its own on-disk size', () => {
    const srv = bootOracleServer('sz2');
    const before = catalogSets(srv).length;
    const rman = ReactiveRmanSubShell.create(srv, ['target', '/']);
    rman.subShell.processLine('backup database format \'/u01/backup/piece_%U\' maxpiecesize 500K;');
    rman.subShell.dispose();

    // Each MAXPIECESIZE split piece is catalogued as its own backup set
    // (a separate, pre-existing modeling detail, not part of this fix) —
    // what matters here is that every piece's on-disk size matches what
    // that set's catalog entry declares.
    const newSets = catalogSets(srv).slice(before);
    expect(newSets.length).toBeGreaterThan(1);
    for (const set of newSets) {
      for (const piece of set.pieces) {
        expect(statSize(srv, piece.path)).toBe(piece.sizeBytes);
      }
    }
  });
});

describe('constat #10 — LEVEL 1 incremental is smaller than LEVEL 0/FULL', () => {
  it('LEVEL 1 backs up a smaller catalog size than the preceding LEVEL 0', () => {
    const srv = bootOracleServer('lvl1');
    const rman = ReactiveRmanSubShell.create(srv, ['target', '/']);
    rman.subShell.processLine('backup incremental level 0 database;');
    const level0Size = catalogSets(srv).at(-1)!.pieces[0].sizeBytes;

    rman.subShell.processLine('backup incremental level 1 database;');
    const level1Size = catalogSets(srv).at(-1)!.pieces[0].sizeBytes;
    rman.subShell.dispose();

    expect(level1Size).toBeLessThan(level0Size);
    // On disk too — not just in the catalog metadata.
    const level1Path = catalogSets(srv).at(-1)!.pieces[0].path;
    expect(statSize(srv, level1Path)).toBe(level1Size);
  });

  it('LEVEL 1 CUMULATIVE is bigger than a plain differential LEVEL 1 but still smaller than LEVEL 0', () => {
    const srv = bootOracleServer('lvl2');
    const rman = ReactiveRmanSubShell.create(srv, ['target', '/']);
    rman.subShell.processLine('backup incremental level 0 database;');
    const level0Size = catalogSets(srv).at(-1)!.pieces[0].sizeBytes;

    rman.subShell.processLine('backup incremental level 1 database;');
    const diffSize = catalogSets(srv).at(-1)!.pieces[0].sizeBytes;

    rman.subShell.processLine('backup incremental level 1 cumulative database;');
    const cumSize = catalogSets(srv).at(-1)!.pieces[0].sizeBytes;
    rman.subShell.dispose();

    expect(diffSize).toBeLessThan(level0Size);
    expect(cumSize).toBeLessThan(level0Size);
    expect(cumSize).toBeGreaterThan(diffSize);
  });

  it('a FULL backup (no incremental level) is unaffected — still the full datafile size', () => {
    const srv = bootOracleServer('lvl3');
    const rman = ReactiveRmanSubShell.create(srv, ['target', '/']);
    rman.subShell.processLine('backup incremental level 0 database;');
    const level0Size = catalogSets(srv).at(-1)!.pieces[0].sizeBytes;

    rman.subShell.processLine('backup database;');
    const fullSize = catalogSets(srv).at(-1)!.pieces[0].sizeBytes;
    rman.subShell.dispose();

    expect(fullSize).toBe(level0Size);
  });
});

describe('constat #10 — elapsed time reflects backup size, not a hardcoded constant', () => {
  it('a bigger backup reports a longer elapsed time than a much smaller incremental', () => {
    const srv = bootOracleServer('elapsed1');
    const rman = ReactiveRmanSubShell.create(srv, ['target', '/']);

    const fullOut = rman.subShell.processLine('backup incremental level 0 database;').output.join('\n');
    const fullElapsed = fullOut.match(/elapsed time: (\d{2}:\d{2}:\d{2})/)?.[1];

    const incOut = rman.subShell.processLine('backup incremental level 1 database;').output.join('\n');
    const incElapsed = incOut.match(/elapsed time: (\d{2}:\d{2}:\d{2})/)?.[1];
    rman.subShell.dispose();

    expect(fullElapsed).toBeDefined();
    expect(incElapsed).toBeDefined();
    // Both must state a real completion line; the level-1 backup must
    // not claim the exact same duration as the much larger level-0 one.
    expect(incElapsed).not.toBe(fullElapsed);
  });
});
