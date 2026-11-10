/*
 * Probe (bug reported on `journalctl -f`): after `sudo -i`, `sudo -s` or `sudo su`, the journal said
 * `sudo: pam_unix(sudo:session): session closed for user root` the moment the command returned, while the root shell it had
 * opened was still running. sudo's PAM session lives as long as the command it runs: for an interactive shell, until the shell
 * exits, and then in the order of a real unit, su (or the shell's own session) closed first and sudo closed last. The sudo session
 * is now closed by the release of the shell it left open, and by the end of the command for every other command.
 *
 * A second defect surfaced while measuring: `su -` (service su-l) opened and closed its PAM session FOUR times in the journal.
 * `session include su` loads the file `su` for the session type only, but an `@include` inside it reloaded the included file for
 * every type, so common-session (and its pam_unix) entered the session stack once per `include su` line of su-l. An @include now
 * keeps the type being loaded, as libpam does.
 *
 * Discriminated with git stash on src/network: 5 of 6 fall before the fix; the witness (a one-shot `sudo true` opens and closes
 * once) passes either way.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

const leaveShell = (server: LinuxServer): void => {
  (server as unknown as { executor: { handleExit(): unknown } }).executor.handleExit();
};

async function sessions(server: LinuxServer): Promise<string[]> {
  const out = await server.executeCommand('journalctl --no-pager | grep -E "session (opened|closed)"');
  return out.split('\n').filter(Boolean).map((line) => /(\w+(?:\[\d+\])?): pam_unix\((\S+):session\): session (opened|closed)/.exec(line)?.slice(1).join(' ') ?? line);
}

describe('sudo shells and the journal', () => {
  it('witness: a one-shot sudo opens and closes its session once', async () => {
    const server = new LinuxServer('linux-server', 'SRV', 0, 0);
    await server.executeCommand('sudo true');
    expect(await sessions(server)).toEqual(['sudo sudo opened', 'sudo sudo closed']);
  });

  for (const command of ['sudo -i', 'sudo -s', 'sudo su']) {
    it(`${command}: the sudo session stays open while the root shell runs`, async () => {
      const server = new LinuxServer('linux-server', 'SRV', 0, 0);
      await server.executeCommand(command);
      const open = await sessions(server);
      expect(open.some((line) => line.startsWith('sudo sudo opened'))).toBe(true);
      expect(open.some((line) => line.startsWith('sudo sudo closed'))).toBe(false);
    });
  }

  it('on exit the shell session closes first and sudo last', async () => {
    const server = new LinuxServer('linux-server', 'SRV', 0, 0);
    await server.executeCommand('sudo -i');
    leaveShell(server);
    const lines = await sessions(server);
    expect(lines.at(-1)).toBe('sudo sudo closed');
    expect(lines.at(-2)).toMatch(/^su\[\d+\] su-l closed$/);
  });

  it('`su -` opens and closes its session once each', async () => {
    const server = new LinuxServer('linux-server', 'SRV', 0, 0);
    await server.executeCommand('su -');
    leaveShell(server);
    expect((await sessions(server)).filter((line) => /su-l (opened|closed)$/.test(line)).length).toBe(2);
  });
});
