/*
 * Probe: `sqlplus / as sysdba @script.sql` was read as a connect identifier ("ORA-12162: TNS:net service name is incorrectly specified" then SP2-0157),
 * and a script piped on stdin was cut at every semicolon, one statement at a time, so SET commands, SPOOL, @ and PL/SQL blocks ended by / did not work the way
 * they do when typed. SQL*Plus User's Guide: sqlplus [connect] @file[.ext] [arguments] runs the script after the login; a script is read line by line like typed
 * input. The invocation parser now separates @file from the connect string; the batch runner feeds each line to the same session the interactive shell uses
 * (with the device file surface wired by one function the interactive shell shares: SPOOL, @, HOST), stops at EXIT, and ends an unterminated statement at the end
 * of the input as the old runner did for a one-line statement.
 *
 * A one-line stdin that is only `@file` (the shape of `sqlplus -s / as sysdba <<EOF @script EOF`) was cut at semicolons and given one, so SQL*Plus looked for `file;`.
 *
 * Discriminated with git stash on src: 6 of 8 fall before the fix; the witnesses (a heredoc script with plain statements, and a piped one-line statement) pass either way.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances } from '@/terminal/commands/database';

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); resetAllOracleInstances(); Logger.reset(); });

const write = (server: LinuxServer, path: string, body: string) => server.executeCommand(`cat > ${path} <<'LAB_EOF'\n${body}\nLAB_EOF`);

describe('sqlplus @script and batch input', () => {
  it('witness: a heredoc script of plain statements runs', async () => {
    const server = new LinuxServer('linux-server', 'DB');
    const output = await server.executeCommand("sqlplus -s / as sysdba <<'EOF'\nSELECT instance_name FROM v$instance;\nEXIT\nEOF");
    expect(output).toContain('ORCL');
  });

  it('witness: a statement piped without a final newline-terminated semicolon still runs', async () => {
    const server = new LinuxServer('linux-server', 'DB');
    expect(await server.executeCommand('echo "SELECT instance_name FROM v\\$instance" | sqlplus -s / as sysdba')).toContain('ORCL');
  });

  it('@script after the connect string runs the script', async () => {
    const server = new LinuxServer('linux-server', 'DB');
    await write(server, '/tmp/a.sql', 'SELECT instance_name FROM v$instance;\nEXIT');
    const output = await server.executeCommand('sqlplus -s / as sysdba @/tmp/a.sql');
    expect(output).toContain('ORCL');
    expect(output).not.toContain('ORA-12162');
  });

  it('a stdin made of one @file line runs the script, without a semicolon added to the name', async () => {
    const server = new LinuxServer('linux-server', 'DB');
    await write(server, '/tmp/one.sql', 'SELECT instance_name FROM v$instance;\nEXIT');
    const output = await server.executeCommand("sqlplus -s / as sysdba <<'EOF'\n@/tmp/one.sql\nEOF");
    expect(output).toContain('ORCL');
    expect(output).not.toContain('SP2-0310');
  });

  it('the .sql extension is optional, as in SQL*Plus', async () => {
    const server = new LinuxServer('linux-server', 'DB');
    await write(server, '/tmp/b.sql', 'SELECT 1 + 1 AS two FROM dual;\nEXIT');
    expect(await server.executeCommand('sqlplus -s / as sysdba @/tmp/b')).toMatch(/\b2\b/);
  });

  it('a missing script is reported with its SP2 code, not as a connection failure', async () => {
    const server = new LinuxServer('linux-server', 'DB');
    const output = await server.executeCommand('sqlplus -s / as sysdba @/tmp/absent.sql');
    expect(output).toContain('SP2-0310');
    expect(output).not.toContain('ORA-12162');
  });

  it('a script with SET, a PL/SQL block ended by / and SPOOL behaves as typed', async () => {
    const server = new LinuxServer('linux-server', 'DB');
    await write(server, '/tmp/c.sql', "SET SERVEROUTPUT ON\nSPOOL /tmp/out.lst\nBEGIN\n  DBMS_OUTPUT.PUT_LINE('bonjour');\nEND;\n/\nSPOOL OFF\nEXIT");
    const output = await server.executeCommand('sqlplus -s / as sysdba @/tmp/c.sql');
    expect(output).toContain('bonjour');
    expect(await server.executeCommand('cat /tmp/out.lst')).toContain('bonjour');
  });

  it('EXIT ends the batch: what follows is not run', async () => {
    const server = new LinuxServer('linux-server', 'DB');
    await write(server, '/tmp/d.sql', "SELECT 'avant' FROM dual;\nEXIT\nSELECT 'apres' FROM dual;");
    const output = await server.executeCommand('sqlplus -s / as sysdba @/tmp/d.sql');
    expect(output).toContain('avant');
    expect(output).not.toContain('apres');
  });
});
