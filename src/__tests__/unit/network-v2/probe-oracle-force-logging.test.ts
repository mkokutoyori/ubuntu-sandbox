/*
 * Probe: measured on the e-commerce lab, the archivelog script ran `ALTER DATABASE FORCE LOGGING;` (answer: Database altered.) and V$DATABASE.FORCE_LOGGING stayed
 * NO: the parser kept the clause as a free text action and the executor answered "Database altered." to every action it did not know, while the instance carried a
 * forceLogging flag nothing ever set (the statement was accepted and had no effect). Oracle Database Administrator's Guide, FORCE LOGGING: ALTER DATABASE FORCE
 * LOGGING makes every change generate redo whatever NOLOGGING says; V$DATABASE.FORCE_LOGGING reports YES; NO FORCE LOGGING turns it off.
 *
 * Discriminated with git stash on src: 2 of 4 fall before the fix (YES after the statement, YES after a restart); the witness (the default is NO) and the NO FORCE LOGGING case pass
 * either way, the latter because the value is NO with or without the statement: it only has meaning read with the YES case before it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances } from '@/terminal/commands/database';

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); resetAllOracleInstances(); Logger.reset(); });

const sql = (server: LinuxServer, body: string) => server.executeCommand(`sqlplus -s / as sysdba <<'EOF'\n${body}\nEOF`);

describe('ALTER DATABASE FORCE LOGGING', () => {
  it('witness: the default is NO', async () => {
    const server = new LinuxServer('linux-server', 'DB');
    expect(await sql(server, 'SELECT force_logging FROM v$database;')).toMatch(/^NO\s*$/m);
  });

  it('turns FORCE_LOGGING to YES', async () => {
    const server = new LinuxServer('linux-server', 'DB');
    await sql(server, 'ALTER DATABASE FORCE LOGGING;');
    expect(await sql(server, 'SELECT force_logging FROM v$database;')).toMatch(/^YES\s*$/m);
  });

  it('NO FORCE LOGGING turns it back to NO', async () => {
    const server = new LinuxServer('linux-server', 'DB');
    await sql(server, 'ALTER DATABASE FORCE LOGGING;');
    await sql(server, 'ALTER DATABASE NO FORCE LOGGING;');
    expect(await sql(server, 'SELECT force_logging FROM v$database;')).toMatch(/^NO\s*$/m);
  });

  it('survives a restart of the instance', async () => {
    const server = new LinuxServer('linux-server', 'DB');
    await sql(server, 'ALTER DATABASE FORCE LOGGING;');
    await sql(server, 'SHUTDOWN IMMEDIATE\nSTARTUP');
    expect(await sql(server, 'SELECT force_logging FROM v$database;')).toMatch(/^YES\s*$/m);
  });
});
