/*
 * Probe: measured on the e-commerce lab, `sudo -u bob sqlplus -s / as sysdba` and `sudo -u bob rman target /` ran as if bob belonged to the dba group: the batch
 * runner and the rman launcher never told the engine who the caller was, so the engine kept its default identity (an OS user in dba). The interactive SQL*Plus
 * terminal already gates the bequeath logon on group membership. Oracle Database Administrator's Guide, OS authentication: a logon AS SYSDBA with no
 * credentials needs the OS user to belong to the OSDBA group (dba); the refusal is ORA-01031, and RMAN reports it under RMAN-00554 and RMAN-04005. The launcher
 * now passes the shell user (name, primary group, dba membership, host); the refusal leaves the audit row the engine already writes. Recorded limit: the
 * super-user (uid 0) is admitted as an OSDBA, because every test machine runs as root without a dba group (TODO.md).
 *
 * Discriminated with git stash on src: 3 of 6 fall before the fix (sqlplus refusal, rman refusal, audit row); the witnesses (root is admitted by sqlplus and by rman) and the dba member pass either way.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances } from '@/terminal/commands/database';

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); resetAllOracleInstances(); Logger.reset(); });

const sqlAs = (server: LinuxServer, user: string, body: string) => server.executeCommand(`sudo -u ${user} sqlplus -s / as sysdba <<'EOF'\n${body}\nEOF`);
const rmanAs = (server: LinuxServer, user: string, body: string) => server.executeCommand(`sudo -u ${user} rman target / <<'EOF'\n${body}\nEOF`);

async function machine(): Promise<LinuxServer> {
  const server = new LinuxServer('linux-server', 'DB');
  await server.executeCommand('groupadd dba');
  await server.executeCommand('useradd -m -G dba dbaop');
  await server.executeCommand('useradd -m intern');
  return server;
}

describe('a bequeath logon needs the dba group', () => {
  it('witness: root is admitted by sqlplus', async () => {
    const server = await machine();
    expect(await server.executeCommand("sqlplus -s / as sysdba <<'EOF'\nSELECT 1 FROM dual;\nEOF")).toContain('1 row selected');
  });

  it('witness: root is admitted by rman', async () => {
    const server = await machine();
    expect(await server.executeCommand("rman target / <<'EOF'\nSHOW RETENTION POLICY;\nEOF")).toContain('connected to target database');
  });

  it('a member of dba is admitted by sqlplus', async () => {
    const server = await machine();
    expect(await sqlAs(server, 'dbaop', 'SELECT 1 FROM dual;')).toContain('1 row selected');
  });

  it('a user outside dba is refused by sqlplus with ORA-01031', async () => {
    const server = await machine();
    const output = await sqlAs(server, 'intern', 'SELECT 1 FROM dual;');
    expect(output).toContain('ORA-01031');
    expect(output).not.toContain('1 row selected');
  });

  it('a user outside dba is refused by rman with RMAN-04005 and ORA-01031', async () => {
    const server = await machine();
    const output = await rmanAs(server, 'intern', 'SHOW RETENTION POLICY;');
    expect(output).toContain('RMAN-04005');
    expect(output).toContain('ORA-01031');
    expect(output).not.toContain('connected to target database');
  });

  it('the refusal is audited', async () => {
    const server = await machine();
    await sqlAs(server, 'intern', 'SELECT 1 FROM dual;');
    const trail = await server.executeCommand("sqlplus -s / as sysdba <<'EOF'\nSELECT os_username, returncode FROM dba_audit_trail WHERE returncode = 1031;\nEOF");
    expect(trail).toContain('intern');
    expect(trail).toContain('1031');
  });
});
