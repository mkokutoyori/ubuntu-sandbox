/**
 * Integration guard: SYS.USER$ now exposes genuine Oracle password verifiers
 * (real 10g DES hash in PASSWORD, 11g `S:` + 12c `T:` in SPARE4) instead of
 * the cleartext or a placeholder hash.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances } from '@/terminal/commands/database';
import { SqlPlusSubShell } from '@/terminal/subshells/SqlPlusSubShell';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  resetAllOracleInstances();
  Logger.reset();
});

function newSession(name: string): SqlPlusSubShell {
  const srv = new LinuxServer('linux-server', name, 100, 100);
  return SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell;
}
function run(sh: SqlPlusSubShell, sql: string): string {
  return sh.processLine(sql).output.join('\n');
}

describe('SYS.USER$ password verifiers', () => {
  it('PASSWORD holds the real 10g DES hash (SCOTT/TIGER → F894844C34402B67)', () => {
    const sh = newSession('ov-1');
    const out = run(sh, "SELECT PASSWORD FROM SYS.USER$ WHERE NAME='SCOTT';");
    expect(out).toContain('F894844C34402B67');
    expect(out).not.toContain('TIGER'); // cleartext must not leak
    sh.dispose();
  });

  it('SPARE4 holds the 11g S: and 12c T: verifiers', () => {
    const sh = newSession('ov-2');
    const out = run(sh, "SELECT SPARE4 FROM SYS.USER$ WHERE NAME='SCOTT';");
    const unwrapped = out.split('\n').map(l => l.trimEnd()).join('').replace(/-{5,}/g, ' ');
    expect(unwrapped).toMatch(/S:[0-9A-F]{60}/);
    expect(unwrapped).toMatch(/T:[0-9A-F]{160}/);
    sh.dispose();
  });

  it('a freshly created user gets a real, deterministic 10g hash', () => {
    const sh = newSession('ov-3');
    sh.processLine('CREATE USER VTEST IDENTIFIED BY tiger;');
    const a = run(sh, "SELECT PASSWORD FROM SYS.USER$ WHERE NAME='VTEST';");
    // Deterministic: SYS.USER$ renders the same hash on a second read.
    const b = run(sh, "SELECT PASSWORD FROM SYS.USER$ WHERE NAME='VTEST';");
    expect(a).toMatch(/[0-9A-F]{16}/);
    expect(a).not.toContain('tiger');
    expect(a).toBe(b);
    sh.dispose();
  });

  it('USER_HISTORY$ stores a real 10g hash, not the cleartext', () => {
    const sh = newSession('ov-4');
    sh.processLine('ALTER USER SCOTT IDENTIFIED BY tiger2;');
    const out = run(sh, 'SELECT PASSWORD FROM SYS.USER_HISTORY$;');
    expect(out).toMatch(/[0-9A-F]{16}/);
    expect(out).not.toContain('tiger2');
    sh.dispose();
  });
});
