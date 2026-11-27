/*
 * Probe: measured on the e-commerce lab, `sqlplus -s / as sysdba <<EOF` with SHUTDOWN or STARTUP anywhere in the input was answered by a private regex in
 * LinuxServer: the first SHUTDOWN stopped the instance and the rest of the script was dropped, a script sent to a stopped instance was not run at all (it printed a
 * banner and "SQL> Disconnected"), -s was ignored (banner and SQL> prompts printed), and STARTUP MOUNT with a datafile missing failed with ORA-01157 although only
 * OPEN reads the datafiles. The batch runner of the sqlplus @script work already feeds every line to the real session, which keeps the connection across SHUTDOWN
 * and STARTUP; LinuxServer now delegates to it first (two answers to one question, removed). Oracle Database Administrator's Guide, starting up a database: STARTUP
 * MOUNT reads the control file only; the ORA-01157 comes at ALTER DATABASE OPEN and leaves the instance mounted.
 *
 * Discriminated with git stash on src: 5 of 6 fall before the fix; the witness (a SELECT on an open instance) passes either way.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances } from '@/terminal/commands/database';

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); resetAllOracleInstances(); Logger.reset(); });

const sql = (server: LinuxServer, body: string) => server.executeCommand(`sqlplus -s / as sysdba <<'EOF'\n${body}\nEOF`);

describe('sqlplus on stdin goes through the session whatever the instance state', () => {
  it('witness: a SELECT on an open instance returns its row', async () => {
    const server = new LinuxServer('linux-server', 'DB');
    expect(await sql(server, 'SELECT instance_name FROM v$instance;')).toContain('ORCL');
  });

  it('a script that shuts down, mounts, switches to ARCHIVELOG and opens runs to its end', async () => {
    const server = new LinuxServer('linux-server', 'DB');
    await sql(server, 'SHUTDOWN IMMEDIATE\nSTARTUP MOUNT\nALTER DATABASE ARCHIVELOG;\nALTER DATABASE OPEN;');
    expect(await sql(server, 'SELECT log_mode FROM v$database;')).toContain('ARCHIVELOG');
  });

  it('-s prints neither the banner nor SQL> prompts', async () => {
    const server = new LinuxServer('linux-server', 'DB');
    const output = await sql(server, 'SHUTDOWN IMMEDIATE\nSTARTUP');
    expect(output).not.toContain('SQL*Plus: Release');
    expect(output).not.toContain('SQL> ');
  });

  it('a query sent to a mounted instance is answered', async () => {
    const server = new LinuxServer('linux-server', 'DB');
    await sql(server, 'SHUTDOWN IMMEDIATE\nSTARTUP MOUNT');
    expect(await sql(server, 'SELECT status FROM v$instance;')).toContain('MOUNTED');
  });

  it('STARTUP MOUNT succeeds with a datafile missing', async () => {
    const server = new LinuxServer('linux-server', 'DB');
    await sql(server, 'SELECT 1 FROM dual;');
    await server.executeCommand('rm -f /u01/app/oracle/oradata/ORCL/users01.dbf');
    await sql(server, 'SHUTDOWN ABORT');
    const output = await sql(server, 'STARTUP MOUNT');
    expect(output).toContain('Database mounted.');
    expect(output).not.toContain('ORA-01157');
  });

  it('OPEN with a datafile missing reports ORA-01157 and leaves the instance mounted', async () => {
    const server = new LinuxServer('linux-server', 'DB');
    await sql(server, 'SELECT 1 FROM dual;');
    await server.executeCommand('rm -f /u01/app/oracle/oradata/ORCL/users01.dbf');
    await sql(server, 'SHUTDOWN ABORT');
    await sql(server, 'STARTUP MOUNT');
    expect(await sql(server, 'ALTER DATABASE OPEN;')).toContain('ORA-01157');
    expect(await sql(server, 'SELECT status FROM v$instance;')).toContain('MOUNTED');
  });
});
