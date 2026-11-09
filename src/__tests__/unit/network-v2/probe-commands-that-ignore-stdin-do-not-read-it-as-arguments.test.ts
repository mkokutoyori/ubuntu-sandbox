/*
 * Reference: the behaviour of the real tools (iptables(8), ip6tables(8), ifconfig(8), lsblk(8), timedatectl(1), hostnamectl(1), route(8), dpkg(1) take no standard input; only iptables-restore,
 * dpkg --set-selections and the like read it) and the registry rule of LinuxCommand: a command that does not declare `readsStdin` got the piped content appended to its argv as a trailing word.
 * Measured at the start: `echo zzstdin | iptables -L` answered "iptables: No chain/target/match by that name." (the pipe became the chain name), `ifconfig` "error: zzstdin", `lsblk: zzstdin`,
 * `timedatectl` "Unknown command verb zzstdin", `route -n` printed its usage, `dpkg -l` "no packages found matching zzstdin". Over SSH it made `sudo iptables -L` fail in
 * ssh-advanced-realism (§A15, §A16), because the SSH sub-shell feeds the sudo password as `printf pw | sudo -S <cmd>`.
 *
 * Measured against the commit before (git stash of src/network): see the commit message for the count; the WITNESSES are the unpiped runs and a command that does read its pipe.
 */
import { describe, it, expect } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';

function server(): LinuxServer {
  const machine = new LinuxServer('linux-server', 'srv', 0, 0);
  machine.powerOn();
  return machine;
}

describe('a command that takes no standard input is not given the pipe as an argument', () => {
  it('WITNESS iptables -L lists the chains when nothing is piped', async () => {
    expect(await server().executeCommand('iptables -L')).toContain('Chain INPUT');
  });

  it('WITNESS a command that reads its pipe still reads it', async () => {
    expect(await server().executeCommand('echo zzstdin | grep zz')).toBe('zzstdin');
  });

  it.each(['iptables -L', 'ip6tables -L', 'ifconfig', 'lsblk', 'timedatectl', 'hostnamectl', 'route -n', 'dpkg -l'])(
    '%s answers the same with a pipe in front of it', async (command) => {
      const machine = server();
      const alone = await machine.executeCommand(command);
      const piped = await machine.executeCommand(`echo zzstdin | ${command}`);
      expect(piped).not.toContain('zzstdin');
      expect(piped.split('\n')[0]).toBe(alone.split('\n')[0]);
    });

  it('sudo -S takes its password from the pipe and gives the command no argument for it', async () => {
    const out = await server().executeCommand("printf 'secret\\n' | sudo -S iptables -L");
    expect(out).toContain('Chain INPUT');
    expect(out).not.toContain('secret');
  });
});
