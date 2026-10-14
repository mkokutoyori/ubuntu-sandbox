/**
 * Probe: scp speaks the scp protocol (OpenSSH 8.9, Ubuntu 22.04), not SFTP.
 *
 * Measured with src/network stashed (6 cases, 3 fall): the client opened the
 * `sftp` subsystem for scp, so no `scp -t` / `scp -f` command ever reached
 * the server, and `ForceCommand internal-sftp`, which refuses an `scp` exec
 * but admits the sftp subsystem, let the transfer through (OpenSSH 9
 * behaviour, wrong for the simulated 8.9).
 *
 *   fall before : 'upload runs scp -t on an exec channel'
 *   fall before : 'download runs scp -f on an exec channel'
 *   fall before : 'ForceCommand internal-sftp refuses scp'
 *   pass both   : 'the file arrives' (witness: the lab transfers at all)
 *   pass both   : 'a missing remote file is reported by the remote'
 *   pass both   : 'the sink applies the umask without -p (666 -> 644)' (the
 *                 SFTP path already masked with 022; guards the new sink)
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { SshSession } from '@/network/protocols/ssh/session/SshSession';

function lab() {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
  const client = new LinuxPC('linux-pc', 'client', 0, 0);
  const server = new LinuxServer('linux-server', 'server', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  [client, server].forEach((d, i) => new Cable(`c${i}`).connect(d.getPorts()[0], sw.getPorts()[i]));
  const mask = new SubnetMask('255.255.255.0');
  client.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), mask);
  server.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), mask);
  const users = (server as unknown as { executor: { userMgr: {
    useradd(u: string, o?: object): void; setPassword(u: string, p: string): void;
  } } }).executor.userMgr;
  users.useradd('alice', { m: true, s: '/bin/bash' });
  users.setPassword('alice', 'admin');
  return { client, server };
}

function watchExecCommands(): string[] {
  const commands: string[] = [];
  const original = SshSession.prototype.openExecStream;
  vi.spyOn(SshSession.prototype, 'openExecStream').mockImplementation(function (this: SshSession, command: string) {
    commands.push(command);
    return original.call(this, command);
  });
  return commands;
}

describe('scp is the scp protocol on an exec channel', () => {
  afterEach(() => vi.restoreAllMocks());

  it('the file arrives', async () => {
    const { client, server } = lab();
    await client.executeCommand("echo hello > /tmp/up.txt");
    await client.executeCommand('sshpass -p admin scp /tmp/up.txt alice@10.0.0.2:/home/alice/up.txt');
    expect((await server.executeCommand('cat /home/alice/up.txt')).trim()).toBe('hello');
  });

  it('upload runs scp -t on an exec channel', async () => {
    const commands = watchExecCommands();
    const { client } = lab();
    await client.executeCommand("echo hello > /tmp/up.txt");
    await client.executeCommand('sshpass -p admin scp /tmp/up.txt alice@10.0.0.2:/home/alice/up.txt');
    expect(commands.some((c) => /^scp .*-t '\/home\/alice\/up\.txt'$/.test(c))).toBe(true);
  });

  it('download runs scp -f on an exec channel', async () => {
    const commands = watchExecCommands();
    const { client, server } = lab();
    await server.executeCommand('sudo sh -c "echo down > /home/alice/down.txt && chown alice /home/alice/down.txt"');
    await client.executeCommand('sshpass -p admin scp alice@10.0.0.2:/home/alice/down.txt /tmp/down.txt');
    expect(commands.some((c) => /^scp .*-f '\/home\/alice\/down\.txt'$/.test(c))).toBe(true);
    expect((await client.executeCommand('cat /tmp/down.txt')).trim()).toBe('down');
  });

  it('a missing remote file is reported by the remote', async () => {
    const { client } = lab();
    const out = await client.executeCommand('sshpass -p admin scp alice@10.0.0.2:/home/alice/none.txt /tmp/none.txt');
    expect(out).toMatch(/none\.txt: No such file or directory/);
  });

  it('ForceCommand internal-sftp refuses scp', async () => {
    const { client, server } = lab();
    await server.executeCommand("sudo sh -c 'printf \"ForceCommand internal-sftp\\nPasswordAuthentication yes\\n\" >> /etc/ssh/sshd_config'");
    await server.executeCommand('sudo systemctl reload ssh');
    await client.executeCommand("echo hello > /tmp/up.txt");
    const out = await client.executeCommand('sshpass -p admin scp /tmp/up.txt alice@10.0.0.2:/home/alice/up.txt');
    expect(out).toMatch(/This service allows sftp connections only/);
    expect(await server.executeCommand('ls /home/alice/up.txt 2>&1')).toMatch(/No such file/);
  });

  it('the sink applies the umask without -p (666 -> 644)', async () => {
    const { client, server } = lab();
    await client.executeCommand('echo hello > /tmp/up.txt && chmod 666 /tmp/up.txt');
    await client.executeCommand('sshpass -p admin scp /tmp/up.txt alice@10.0.0.2:/home/alice/up.txt');
    expect((await server.executeCommand('stat -c %a /home/alice/up.txt')).trim()).toBe('644');
  });
});
