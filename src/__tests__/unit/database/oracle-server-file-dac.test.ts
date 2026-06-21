/**
 * Oracle server-side file I/O honours host DAC as the `oracle` OS user.
 *
 * The Oracle instance reads/writes host files (UTL_FILE, external tables,
 * BFILE, Data Pump, CREATE PFILE/SPFILE) through its server process, which
 * on a real host runs as the `oracle` OS user and is therefore subject to
 * filesystem permissions. The simulator previously wired these through the
 * editor pass-throughs, which read with no permission check and wrote with
 * the *interactive shell's* identity — so Oracle could read a root-owned
 * 0600 file and files it produced were misattributed.
 *
 * These tests drive a real LinuxServer (not the in-memory Map stand-in) so
 * the device VFS and its DAC are exercised end to end.
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

const sh = (srv: LinuxServer, cmd: string) => srv.executeShellCommandSync(cmd);

function boot(name: string): LinuxServer {
  const srv = new LinuxServer('linux-server', name, 100, 100);
  SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell.dispose();
  return srv;
}

function sql(srv: LinuxServer, lines: string[]): string {
  const s = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell;
  let out = '';
  for (const line of lines) out += s.processLine(line).output.join('\n') + '\n';
  s.dispose();
  return out;
}

describe('Oracle server-side file I/O under host DAC', () => {
  it('a file written by UTL_FILE is owned by the oracle OS user and visible to cat', () => {
    const srv = boot('dac-1');
    sql(srv, [
      "CREATE DIRECTORY home_dir AS '/home/oracle';",
      `DECLARE f UTL_FILE.FILE_TYPE; BEGIN
         f := UTL_FILE.FOPEN('HOME_DIR', 'report.txt', 'W');
         UTL_FILE.PUT_LINE(f, 'written-by-oracle');
         UTL_FILE.FCLOSE(f);
       END;`,
    ]);
    // The OS shell sees exactly what PL/SQL wrote …
    expect(sh(srv, 'cat /home/oracle/report.txt')).toContain('written-by-oracle');
    // … owned by the oracle user, not by whoever ran the SQL.
    expect(sh(srv, 'ls -l /home/oracle/report.txt')).toMatch(/\boracle\b/);
  });

  it('Oracle can read a world-readable file but is denied a root-owned 0600 file', () => {
    const srv = boot('dac-2');
    // root drops two files into a directory oracle can traverse.
    sh(srv, 'mkdir -p /home/oracle/files');
    sh(srv, 'echo public-data > /home/oracle/files/pub.txt');
    sh(srv, 'echo top-secret > /home/oracle/files/secret.txt');
    sh(srv, 'chmod 600 /home/oracle/files/secret.txt');

    const out = sql(srv, [
      'SET SERVEROUTPUT ON',
      "CREATE DIRECTORY files_dir AS '/home/oracle/files';",
      // Readable file → content surfaces.
      `DECLARE f UTL_FILE.FILE_TYPE; l VARCHAR2(200); BEGIN
         f := UTL_FILE.FOPEN('FILES_DIR', 'pub.txt', 'R');
         UTL_FILE.GET_LINE(f, l); UTL_FILE.FCLOSE(f);
         DBMS_OUTPUT.PUT_LINE('READ_OK:' || l);
       END;`,
      // root:600 file → the oracle user is denied, surfaced as ORA-29283.
      `DECLARE f UTL_FILE.FILE_TYPE; l VARCHAR2(200); BEGIN
         f := UTL_FILE.FOPEN('FILES_DIR', 'secret.txt', 'R');
         UTL_FILE.GET_LINE(f, l); UTL_FILE.FCLOSE(f);
         DBMS_OUTPUT.PUT_LINE('LEAKED:' || l);
       EXCEPTION WHEN OTHERS THEN DBMS_OUTPUT.PUT_LINE('DENIED');
       END;`,
    ]);

    expect(out).toContain('READ_OK:public-data');
    expect(out).toContain('DENIED');
    expect(out).not.toMatch(/LEAKED/);
  });

  it('UTL_FILE write into a directory not writable by oracle fails', () => {
    const srv = boot('dac-3');
    // /root is mode 0700 owned by root — oracle cannot create files there.
    const out = sql(srv, [
      'SET SERVEROUTPUT ON',
      "CREATE DIRECTORY root_dir AS '/root';",
      `BEGIN
         DECLARE f UTL_FILE.FILE_TYPE; BEGIN
           f := UTL_FILE.FOPEN('ROOT_DIR', 'x.txt', 'W');
           UTL_FILE.PUT_LINE(f, 'should-not-land');
           UTL_FILE.FCLOSE(f);
           DBMS_OUTPUT.PUT_LINE('WROTE');
         EXCEPTION WHEN OTHERS THEN DBMS_OUTPUT.PUT_LINE('WRITE_DENIED');
         END;
       END;`,
    ]);
    expect(out).toContain('WRITE_DENIED');
    expect(sh(srv, 'cat /root/x.txt')).not.toContain('should-not-land');
  });
});
