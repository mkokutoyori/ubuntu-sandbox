/*
 * Probe — `tnsping` and `sqlplus user/pw@host:port/service` typed on a
 * LinuxPC through executeCommand (scripts, SSH, pipes) reach the remote
 * database over Oracle Net, the way the interactive terminal already did.
 *
 * The executor answered both from canned text whenever the machine was not
 * a server: "TNS-03505: Failed to resolve name" and "ORA-12162: TNS:net
 * service name is incorrectly specified", while the terminal's tnsping on
 * the very same PC resolved the EZCONNECT identifier and reached the
 * listener. Two views of one machine disagreed about the same command.
 *
 * Measured before the fix (git stash of src/network and src/terminal):
 * 3 of the 4 cases fail.
 * Passing either way:
 *   - "tnsping on the server itself" is the WITNESS: the server already
 *     went through the real handler, so the listener and the lab are sound.
 */
import { describe, it, expect } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import '../new_firewall/fortigateBatteryHarness';

async function buildLab(): Promise<{ srv: LinuxServer; pc: LinuxPC }> {
  const srv = new LinuxServer('linux-server', 'db1', 0, 0);
  const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
  srv.powerOn();
  pc.powerOn();
  new Cable('c').connect(srv.getPort('eth0') as never, pc.getPort('eth0') as never);
  for (const line of ['ip link set eth0 up', 'ip addr add 10.0.0.2/24 dev eth0']) await srv.executeCommand(line);
  for (const line of ['ip link set eth0 up', 'ip addr add 10.0.0.1/24 dev eth0']) await pc.executeCommand(line);
  return { srv, pc };
}

describe('Oracle client tools on a LinuxPC reach the remote database', () => {
  it('tnsping on the server itself reaches its listener', async () => {
    const { srv } = await buildLab();
    expect(await srv.executeCommand('tnsping 10.0.0.2:1521/ORCL')).toMatch(/^OK \(\d+ msec\)$/m);
  });

  it('tnsping from the PC resolves EZCONNECT and reaches the listener', async () => {
    const { pc } = await buildLab();
    const out = await pc.executeCommand('tnsping 10.0.0.2:1521/ORCL');
    expect(out).toContain('Used EZCONNECT adapter to resolve the alias');
    expect(out).toMatch(/^OK \(\d+ msec\)$/m);
  });

  it('sqlplus from the PC runs a query on the remote database', async () => {
    const { pc } = await buildLab();
    const out = await pc.executeCommand('echo "SELECT 1 FROM DUAL;" | sqlplus -S system/oracle@10.0.0.2:1521/ORCL');
    expect(out).toMatch(/^-+\n\s*1\s*$/m);
    expect(out).not.toMatch(/ORA-/);
  });

  it('sqlplus from the PC is refused with the server verdict on a wrong password', async () => {
    const { pc } = await buildLab();
    const out = await pc.executeCommand('echo "SELECT 1 FROM DUAL;" | sqlplus -S system/wrong@10.0.0.2:1521/ORCL');
    expect(out).toContain('ORA-01017: invalid username/password; logon denied');
  });
});
