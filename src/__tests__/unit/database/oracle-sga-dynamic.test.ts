/**
 * SGA sizing derives from the live sga_target parameter (ASMM-style),
 * not from canned constants — ALTER SYSTEM SET sga_target reshapes
 * V$SGA / V$SGAINFO and the startup banner prints real byte counts.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { OracleDatabase } from '@/database/oracle/OracleDatabase';
import { SQLPlusSession } from '@/database/oracle/commands/SQLPlusSession';

let db: OracleDatabase;
let session: SQLPlusSession;

beforeEach(() => {
  db = new OracleDatabase();
  db.instance.startup('OPEN');
  session = new SQLPlusSession(db);
  session.login('SYS', 'oracle', true);
});

const out = (line: string): string => session.processLine(line).output.join('\n');

describe('SGA sizing follows sga_target', () => {
  test('default 512M target yields a ~256M buffer cache and ~128M shared pool', () => {
    const sga = db.instance.getSGAInfo();
    expect(sga.totalSize).toBe('512M');
    expect(sga.bufferCache).toBe('256M');
    expect(sga.sharedPool).toBe('128M');
  });

  test('ALTER SYSTEM SET sga_target=2G reshapes the breakdown', () => {
    out("ALTER SYSTEM SET sga_target='2G' SCOPE=BOTH;");
    const sga = db.instance.getSGAInfo();
    expect(sga.totalSize).toBe('2048M');
    // 50% buffer cache, granule-rounded (16M granules above 1G).
    expect(sga.bufferCache).toBe('1024M');
    expect(sga.sharedPool).toBe('512M');
    expect(sga.redoLogBuffer).toBe('16M');
  });

  test('startup banner prints exact byte counts from the live target', () => {
    db.instance.shutdown('IMMEDIATE');
    const banner = db.instance.startup('OPEN').join('\n');
    expect(banner).toMatch(/Total System Global Area\s+536870912 bytes/);
    expect(banner).toMatch(/Database Buffers\s+268435456 bytes/);
  });

  test('V$SGAINFO buffer cache row tracks the parameter', () => {
    out("ALTER SYSTEM SET sga_target='1G' SCOPE=BOTH;");
    const rows = out('SELECT name, bytes FROM v$sgainfo;');
    expect(rows).toMatch(/Database Buffers\s+536870912/);
  });
});
