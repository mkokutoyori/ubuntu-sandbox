/*
 * Probe — `sshd.service` is an alias of `ssh.service`, as Debian and
 * Ubuntu declare it (`Alias=sshd.service` in the [Install] section of the
 * openssh-server unit; read through the Debian wiki and search excerpts,
 * salsa.debian.org and git.launchpad.net being refused by this
 * environment's proxy).
 *
 * Before: `systemctl stop sshd` answered "Unit sshd.service not found." and
 * left port 22 open; every battery that typed `systemctl start sshd` got the
 * same refusal, hidden because ssh already runs.
 *
 * Measured before the change (git stash of LinuxProcessCommands.ts):
 * 3 of the 4 cases fail.
 * Passing either way:
 *   - "ssh.service itself stops and closes port 22" is the WITNESS.
 */
import { describe, it, expect } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import '../new_firewall/fortigateBatteryHarness';

async function server(): Promise<LinuxServer> {
  const srv = new LinuxServer('linux-server', 'srv1', 0, 0);
  srv.powerOn();
  return srv;
}

describe('systemctl sshd', () => {
  it('ssh.service itself stops and closes port 22', async () => {
    const srv = await server();
    await srv.executeCommand('systemctl stop ssh');
    expect(await srv.executeCommand('ss -ltn')).not.toMatch(/:22\s/);
  });

  it('stopping sshd stops ssh and closes port 22', async () => {
    const srv = await server();
    const out = await srv.executeCommand('systemctl stop sshd; echo EC=$?');
    expect(out).not.toContain('not found');
    expect(out).toContain('EC=0');
    expect(await srv.executeCommand('systemctl is-active ssh')).toMatch(/^inactive$/m);
    expect(await srv.executeCommand('ss -ltn')).not.toMatch(/:22\s/);
  });

  it('is-active sshd reports the ssh unit', async () => {
    const srv = await server();
    expect(await srv.executeCommand('systemctl is-active sshd')).toMatch(/^active$/m);
  });

  it('starting sshd after a stop reopens port 22', async () => {
    const srv = await server();
    await srv.executeCommand('systemctl stop ssh');
    await srv.executeCommand('systemctl start sshd.service');
    expect(await srv.executeCommand('ss -ltn')).toMatch(/0\.0\.0\.0:22\s/);
  });
});
