/*
 * Probe: measured on the e-commerce lab, `SELECT COUNT(*) FROM shop.orders` printed the column heading `COUNT(...)`. Oracle SQL*Plus names an unaliased
 * expression column by the text of the expression, upper-cased: COUNT(*), SUM(TOTAL), UPPER(EMAIL). The heading builder wrote the function name and a
 * literal ellipsis in place of the arguments. SQL*Plus User's Guide, column headings: the default heading is the column name or expression.
 *
 * Discriminated with git stash on src: 3 of 4 fall before the fix; the witness (an aliased column keeps its alias) passes either way.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances } from '@/terminal/commands/database';

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); resetAllOracleInstances(); Logger.reset(); });

const sql = (server: LinuxServer, body: string) => server.executeCommand(`sqlplus -s / as sysdba <<'EOF'\n${body}\nEOF`);

describe('the heading of an unaliased expression is the expression', () => {
  it('witness: an alias is the heading', async () => {
    const server = new LinuxServer('linux-server', 'DB');
    expect(await sql(server, 'SELECT COUNT(*) AS total FROM dual;')).toContain('TOTAL');
  });

  it('COUNT(*) is headed COUNT(*)', async () => {
    const server = new LinuxServer('linux-server', 'DB');
    const output = await sql(server, 'SELECT COUNT(*) FROM dual;');
    expect(output).toContain('COUNT(*)');
    expect(output).not.toContain('(...)');
  });

  it('a function with a column argument keeps the column in its heading', async () => {
    const server = new LinuxServer('linux-server', 'DB');
    await sql(server, 'CREATE TABLE t1 (id NUMBER, total NUMBER);\nINSERT INTO t1 VALUES (1, 5);\nCOMMIT;');
    expect(await sql(server, 'SELECT SUM(total) FROM t1;')).toContain('SUM(TOTAL)');
  });

  it('a function with a lower-case name and DISTINCT is headed in upper case', async () => {
    const server = new LinuxServer('linux-server', 'DB');
    await sql(server, 'CREATE TABLE t2 (id NUMBER);\nINSERT INTO t2 VALUES (1);\nCOMMIT;');
    expect(await sql(server, 'SELECT count(distinct id) FROM t2;')).toContain('COUNT(DISTINCT ID)');
  });
});
