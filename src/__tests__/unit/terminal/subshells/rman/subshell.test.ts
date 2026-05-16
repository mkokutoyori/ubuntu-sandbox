/**
 * ReactiveRmanSubShell — converts session events into terminal output.
 *
 * Integration test through the ISubShell surface: processLine drives the
 * RmanSession internally and we assert the printed output matches
 * Oracle's RMAN one-shot session semantics.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ReactiveRmanSubShell } from '@/terminal/subshells/rman/ReactiveRmanSubShell';
import { BackupKey } from '@/terminal/subshells/rman/values/BackupKey';
import { ok } from '@/terminal/subshells/rman/core/Result';
import { DbId } from '@/terminal/subshells/rman/values/DbId';
import type { IRmanOracleContext } from '@/terminal/subshells/rman/integration/IRmanOracleContext';

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
      { fileNo: 2, path: '/u01/oradata/ORCL/sysaux01.dbf', sizeBytes: 576_716_800, tablespace: 'SYSAUX' },
    ],
    getSpfileParam: () => undefined,
  };
}

describe('ReactiveRmanSubShell', () => {
  beforeEach(() => BackupKey._reset());

  it('banner contains the Recovery Manager release line', () => {
    const { banner } = ReactiveRmanSubShell.fromContext([], ctx());
    expect(banner.some(l => /Recovery Manager: Release/.test(l))).toBe(true);
  });

  it('prompt is RMAN>', () => {
    const { subShell } = ReactiveRmanSubShell.fromContext([], ctx());
    expect(subShell.getPrompt()).toBe('RMAN> ');
  });

  it('BACKUP DATABASE prints the canonical RMAN sequence', () => {
    const { subShell } = ReactiveRmanSubShell.fromContext(['target', '/'], ctx());
    const res = subShell.processLine('BACKUP DATABASE');
    expect(res.exit).toBe(false);
    const text = res.output.join('\n');
    expect(text).toMatch(/Starting backup/);
    expect(text).toMatch(/allocated channel: ORA_DISK_1/);
    expect(text).toMatch(/SID=\d+ device type=DISK/);
    expect(text).toMatch(/starting full datafile backup set/);
    expect(text).toMatch(/piece handle=.*\.bkp tag=TAG\d/);
    expect(text).toMatch(/Finished backup/);
  });

  it('unknown command prints the standard RMAN error stack', () => {
    const { subShell } = ReactiveRmanSubShell.fromContext(['target', '/'], ctx());
    const res = subShell.processLine('FROBNICATE');
    const text = res.output.join('\n');
    expect(text).toMatch(/RMAN-00569/);
    expect(text).toMatch(/RMAN-00558/);
    expect(text).toMatch(/RMAN-01009/);
  });

  it('LIST BACKUP after BACKUP DATABASE prints the catalog', () => {
    const { subShell } = ReactiveRmanSubShell.fromContext(['target', '/'], ctx());
    subShell.processLine('BACKUP DATABASE');
    const res = subShell.processLine('LIST BACKUP SUMMARY');
    expect(res.output.some(l => /List of Backups/.test(l))).toBe(true);
  });

  it('EXIT returns exit=true and "Recovery Manager complete."', () => {
    const { subShell } = ReactiveRmanSubShell.fromContext(['target', '/'], ctx());
    const res = subShell.processLine('EXIT');
    expect(res.exit).toBe(true);
    expect(res.output.some(l => /Recovery Manager complete/.test(l))).toBe(true);
  });

  it('dispose() is idempotent', () => {
    const { subShell } = ReactiveRmanSubShell.fromContext(['target', '/'], ctx());
    subShell.dispose();
    expect(() => subShell.dispose()).not.toThrow();
  });
});
