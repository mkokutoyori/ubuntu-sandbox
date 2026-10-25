/**
 * Probe — global(reportChildProcessExits) of rsyslog 8.2610 (runtime/glbl.c glblReportChildProcessExit, tools/rsyslogd.c
 * reapChild). The command that omfile runs when rotation.sizeLimit is reached is a child of rsyslogd; when it ends the
 * daemon reports it: "none" says nothing, "errors" (the default) reports a non-zero status as a warning, "all" also
 * reports a zero status as an information message. An invalid value is refused in the words of glbl.c and the default
 * stays. The pid in the report is a process of the machine that was the daemon's child while the command ran.
 * Measured against the preceding commit (git stash of src/network): 3 of the 5 cases fall - the parameter was accepted and
 * never read, nothing was ever reported, and an invalid value was accepted silently. The 2 that pass either way are
 * WITNESSES: a successful command under the default policy (the rotated file exists, so the lab does run the command) and
 * "none", whose silence is only meaningful next to the case that shows the same failing command reported by default.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.clear();
});

async function rotating(policy: string, command: string): Promise<LinuxServer> {
  const host = new LinuxServer('linux-server', 'host1', 0, 0);
  host.powerOn();
  await host.executeCommand(`printf '#!/bin/sh\\n${command}\\n' > /usr/local/bin/rotate.sh`);
  await host.executeCommand('chmod +x /usr/local/bin/rotate.sh');
  const global = policy === '' ? '' : `global(reportChildProcessExits="${policy}")\\n`;
  await host.executeCommand(`printf '${global}local4.* action(type="omfile" file="/var/log/limited.log" rotation.sizeLimit="60" rotation.sizeLimitCommand="/usr/local/bin/rotate.sh")\\n' > /etc/rsyslog.d/40-test.conf`);
  await host.executeCommand('systemctl restart rsyslog');
  for (let index = 0; index < 3; index++) await host.executeCommand(`logger -p local4.info -t probe message-${index}-aaaaaaaaaaaa`);
  return host;
}

const syslog = (host: LinuxServer): Promise<string> => host.executeCommand('cat /var/log/syslog');

describe('reportChildProcessExits', () => {
  it('witness: a command that succeeds is run and, with the default policy, not reported', async () => {
    const host = await rotating('', 'mv /var/log/limited.log /var/log/limited.log.1');
    expect(await host.executeCommand('ls /var/log/limited.log.1 2>&1')).not.toContain('No such file');
    expect(await syslog(host)).not.toContain('child process (pid');
  }, 60_000);

  it('the default reports a command that fails, with its pid and its status', async () => {
    const host = await rotating('', 'exit 3');
    expect(await syslog(host)).toMatch(/child process \(pid \d+\) exited with status 3/);
  }, 60_000);

  it('"all" also reports a command that succeeds', async () => {
    const host = await rotating('all', 'mv /var/log/limited.log /var/log/limited.log.1');
    expect(await syslog(host)).toMatch(/child process \(pid \d+\) exited with status 0/);
  }, 60_000);

  it('"none" reports nothing, even a failure', async () => {
    const host = await rotating('none', 'exit 3');
    expect(await syslog(host)).not.toContain('child process (pid');
  }, 60_000);

  it('an invalid value is refused in the words of the source and the default stays', async () => {
    const host = await rotating('sometimes', 'exit 3');
    expect(await syslog(host)).toContain("invalid value 'sometimes' for global parameter reportChildProcessExits -- ignored");
    expect(await syslog(host)).toMatch(/child process \(pid \d+\) exited with status 3/);
  }, 60_000);
});
