/**
 * ASM end-to-end — real AsmManager state, driven by SQL DDL, surfaced
 * by the v\$asm_* dictionary views and materialised on the device VFS.
 *
 * Per the project rule "no stubs, no hardcoded": the views report
 * exactly what the manager holds, and any disk advertised by V\$ASM_DISK
 * exists as a real file on the underlying Linux device.
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

function setup(name: string) {
  const srv = new LinuxServer('linux-server', name, 100, 100);
  const { subShell } = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']);
  return subShell;
}
const sql = (s: ReturnType<typeof setup>, q: string) => s.processLine(q).output.join('\n');

describe('ASM — real machinery', () => {
  it('starts with zero diskgroups (no fabricated DATA/FRA rows)', () => {
    const s = setup('asm-empty');
    const dg = sql(s, 'SELECT * FROM v$asm_diskgroup;');
    expect(dg).not.toMatch(/DATA/);
    expect(dg).not.toMatch(/FRA/);
    const d = sql(s, 'SELECT * FROM v$asm_disk;');
    expect(d).not.toMatch(/oracleasm/);
    s.dispose();
  });

  it('CREATE DISKGROUP adds a row to v$asm_diskgroup and v$asm_disk', () => {
    const s = setup('asm-create');
    sql(s, "CREATE DISKGROUP DATA EXTERNAL REDUNDANCY DISK '/dev/sda1' SIZE 200 M, '/dev/sda2' SIZE 200 M;");
    const dg = sql(s, 'SELECT name, total_mb FROM v$asm_diskgroup;');
    expect(dg).toMatch(/DATA\s+400/);
    const d = sql(s, 'SELECT diskgroup_name FROM v$asm_disk;'); // ignored — selecting all
    const disks = sql(s, 'SELECT name, path, total_mb FROM v$asm_disk ORDER BY disk_number;');
    expect(disks).toContain('/dev/sda1');
    expect(disks).toContain('/dev/sda2');
    expect(disks).toMatch(/DATA_0000/);
    s.dispose();
  });

  it('every disk advertised by V$ASM_DISK exists as a real file on the VFS', () => {
    const s = setup('asm-fs');
    sql(s, "CREATE DISKGROUP DATA EXTERNAL REDUNDANCY DISK '/dev/sda1' SIZE 100 M;");
    sql(s, "ALTER DISKGROUP DATA ADD DISK '/dev/sda2' SIZE 100 M;");
    const ls = sql(s, 'HOST ls /dev/sda1 /dev/sda2');
    expect(ls).toContain('/dev/sda1');
    expect(ls).toContain('/dev/sda2');
    const content = sql(s, 'HOST cat /dev/sda1');
    expect(content).toMatch(/ASM DISK/);
    expect(content).toMatch(/diskgroup DATA/);
    s.dispose();
  });

  it('ALTER DISKGROUP DROP DISK removes the row and the device file', () => {
    const s = setup('asm-drop-disk');
    sql(s, "CREATE DISKGROUP DATA EXTERNAL REDUNDANCY DISK '/dev/sda1' SIZE 100 M, '/dev/sda2' SIZE 100 M;");
    sql(s, "ALTER DISKGROUP DATA DROP DISK 'DATA_0001';");
    const disks = sql(s, 'SELECT path FROM v$asm_disk;');
    expect(disks).toContain('/dev/sda1');
    expect(disks).not.toContain('/dev/sda2');
    expect(sql(s, 'HOST ls /dev/sda2')).toMatch(/No such file|cannot access/);
    expect(sql(s, 'HOST ls /dev/sda1')).toContain('/dev/sda1');
    s.dispose();
  });

  it('DROP DISKGROUP INCLUDING CONTENTS removes the diskgroup and all backing files', () => {
    const s = setup('asm-drop-dg');
    sql(s, "CREATE DISKGROUP DATA EXTERNAL REDUNDANCY DISK '/dev/sda1' SIZE 100 M, '/dev/sda2' SIZE 100 M;");
    sql(s, 'DROP DISKGROUP DATA INCLUDING CONTENTS;');
    const dg = sql(s, 'SELECT name FROM v$asm_diskgroup;');
    expect(dg).not.toMatch(/DATA/);
    const ls = sql(s, 'HOST ls /dev/sda1 /dev/sda2 2>/dev/null');
    expect(ls).not.toContain('/dev/sda1');
    expect(ls).not.toContain('/dev/sda2');
    s.dispose();
  });

  it('V$ASM_TEMPLATE returns the 8 default templates × number of diskgroups', () => {
    const s = setup('asm-tpl');
    sql(s, "CREATE DISKGROUP DATA EXTERNAL REDUNDANCY DISK '/dev/sda1' SIZE 100 M;");
    sql(s, "CREATE DISKGROUP FRA NORMAL REDUNDANCY DISK '/dev/sdb1' SIZE 100 M;");
    const t = sql(s, 'SELECT COUNT(*) FROM v$asm_template;');
    expect(t).toMatch(/16/);
    s.dispose();
  });
});
