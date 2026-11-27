/*
 * Probe: rlm_sql, connection pool on the wire. The pool section's `start` is the number of Oracle sessions the module opens when it starts: they exist on the database host
 * before any request, as V$SESSION shows, and a reload closes and reopens them. Source of truth: FreeRADIUS v3.2.x raddb/mods-available/sql and src/lib/server/connection.c
 * (see probe-freeradius-sql-pool for the rules of the pool itself, checked there with an injected clock). Without a pool section the stock defaults apply (start 5).
 *
 * Discriminated with git stash on src/network: 3 of 3 fall before the fix.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances } from '@/terminal/commands/database';
import { SqlPlusSubShell } from '@/terminal/subshells/SqlPlusSubShell';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { CLIENTS_CONF_PATH, USERS_FILE_PATH } from '@/network/devices/linux/freeradius/RadiusdService';

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); resetAllOracleInstances(); Logger.reset(); });

const vfsOf = (server: LinuxServer) => (server as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
const write = (server: LinuxServer, path: string, content: string) => { vfsOf(server).writeFile(path, content, 0, 0, 0o022); };
const SQL_MODULE = '/etc/freeradius/3.0/mods-enabled/sql';

const MODULE = (pool: string[]) => ['sql {', '  driver = "rlm_sql_oracle"', '  dialect = "oracle"', '  radius_db = "//10.0.0.2/ORCL"', '  login = "system"', '  password = "oracle"', ...(pool.length === 0 ? [] : ['  pool {', ...pool.map((line) => `    ${line}`), '  }']), '}', ''].join('\n');

async function lab(pool: string[]) {
  const radius = new LinuxServer('linux-server', 'AAA', 0, 0);
  const dbhost = new LinuxServer('linux-server', 'dbhost', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'sw1', 8, 0, 0);
  new Cable('c2').connect(radius.getPorts()[0], sw.getPorts()[0]);
  new Cable('c3').connect(dbhost.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  radius.getPorts()[0].configureIP(new IPAddress('10.0.0.3'), mask);
  dbhost.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), mask);
  write(radius, CLIENTS_CONF_PATH, 'client lab {\n  ipaddr = 10.0.0.1\n  secret = shared\n}\n');
  write(radius, USERS_FILE_PATH, 'alice Cleartext-Password := "pw"\n');
  write(radius, SQL_MODULE, MODULE(pool));
  const started = await radius.executeCommand('systemctl restart freeradius');
  return { radius, dbhost, started };
}

const sessions = async (dbhost: LinuxServer) => Number(/^\s*(\d+)\s*$/m.exec(await dbhost.executeCommand("sqlplus -s / as sysdba <<'E'\nSELECT COUNT(*) AS n FROM v$session WHERE username = 'SYSTEM';\nE"))?.[1] ?? -1);

describe('rlm_sql: the pool opens its sessions on the database host', () => {
  it('start = 3 opens three Oracle sessions before any request', async () => {
    const { dbhost, started } = await lab(['start = 3', 'min = 1']);
    expect(started).not.toContain('Failed');
    expect(await sessions(dbhost)).toBe(3);
  });

  it('without a pool section the stock default opens five', async () => {
    const { dbhost } = await lab([]);
    expect(await sessions(dbhost)).toBe(5);
  });

  it('a restart closes the old sessions and opens the new ones: no accumulation', async () => {
    const { dbhost, radius } = await lab(['start = 2', 'min = 1']);
    await radius.executeCommand('systemctl restart freeradius');
    expect(await sessions(dbhost)).toBe(2);
  });
});
