/*
 * Probe: measured on the e-commerce lab reopened from its export, the standby host (an Oracle server whose instance had been booted but not changed) had no
 * oracle account: `sudo -u oracle` and a shell session opened as oracle failed, and sqlplus / as sysdba from an ordinary user was refused. The export writes nothing
 * for an untouched database (by design) and its factory twin is provisioned the same way as the live host, so neither the accounts nor the database came back:
 * only a host whose database had CHANGED got it back (the Oracle section restore creates the instance, which provisions the accounts). The export now carries a
 * one-word mark, oracleInstalled, for a host whose instance exists with nothing to carry; reopening creates that instance, which provisions the oracle and
 * oinstall/dba identity exactly as the first sqlplus does. A host that never booted Oracle gets neither the mark nor the account.
 *
 * Discriminated with git stash on src: 3 of 4 fall before the fix; the witness (a server that never booted Oracle has no mark and no account) passes either way.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { exportTopology, importTopology } from '@/store/topologySerializer';
import { getOracleDatabase, resetAllOracleInstances } from '@/terminal/commands/database';
import type { Equipment } from '@/network';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); resetAllOracleInstances(); });

const asMap = (devices: Equipment[]) => new Map(devices.map((device) => [device.getId(), device]));

async function reopened(devices: Equipment[]) {
  const json = JSON.parse(JSON.stringify(exportTopology('lab', asMap(devices), [])));
  const result = await importTopology(json);
  return { json, byName: (name: string) => [...result.deviceInstances.values()].find((device) => device.getName() === name) as LinuxServer };
}

describe('a booted but untouched Oracle server comes back with its Oracle identity', () => {
  it('witness: a server that never booted Oracle has no mark and no oracle account', async () => {
    const plain = new LinuxServer('linux-server', 'PLAIN');
    const { json, byName } = await reopened([plain]);
    expect(json.devices[0].oracleInstalled).toBeUndefined();
    expect(await byName('PLAIN').executeCommand('id oracle')).toContain('no such user');
  });

  it('the export marks a booted untouched server and writes no Oracle section', async () => {
    const booted = new LinuxServer('linux-server', 'BOOTED');
    getOracleDatabase(booted.getId());
    const { json } = await reopened([booted]);
    expect(json.devices[0].oracleInstalled).toBe(true);
    expect(json.devices[0].oracle).toBeUndefined();
  });

  it('the reopened server has the oracle account in the dba group', async () => {
    const booted = new LinuxServer('linux-server', 'BOOTED');
    getOracleDatabase(booted.getId());
    const { byName } = await reopened([booted]);
    const output = await byName('BOOTED').executeCommand('id oracle');
    expect(output).toContain('uid=54321(oracle)');
    expect(output).toContain('dba');
  });

  it('an oracle shell session on the reopened server can run sqlplus / as sysdba', async () => {
    const booted = new LinuxServer('linux-server', 'BOOTED');
    getOracleDatabase(booted.getId());
    const { byName } = await reopened([booted]);
    const server = byName('BOOTED');
    const session = server.openShellSession({ user: 'oracle' });
    const output = await server.executeCommandInSession("sqlplus -s / as sysdba <<'EOF'\nSELECT 1 FROM dual;\nEOF", session);
    expect(output).toContain('1 row selected');
  });
});
