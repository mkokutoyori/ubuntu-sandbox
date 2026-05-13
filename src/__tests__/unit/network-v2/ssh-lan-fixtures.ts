/**
 * SSH LAN — shared fixtures for the ssh-lan-*.test.ts suites.
 *
 * Builds a small in-memory network exercising the full SSH/SFTP stack:
 *
 *   PC1 (10.0.0.1) ─┐
 *   PC2 (10.0.0.2) ─┼── GenericSwitch (8 ports) ──
 *   PC3 (10.0.0.3) ─┘
 *
 * Each PC is a fresh `LinuxPC`, so it boots `LinuxCommandExecutor` with
 * its own VFS, user manager, service manager, process manager, etc.
 * Default user `user` is created by the executor (password `admin`).
 *
 * Helpers:
 *   - {@link buildLan} returns the three PCs + the switch already cabled.
 *   - {@link assignIps} configures eth0 on each PC.
 *   - {@link sshExec} runs a one-shot `ssh user@host cmd` from one PC and
 *     returns the joined stdout. Connections close before the call returns.
 *   - {@link sshScript} runs a sequence of commands through a single SSH
 *     session and returns one string per command.
 *
 * The fixtures intentionally bypass the terminal layer so tests can assert
 * directly on bash output and remote VFS state without UI plumbing.
 */

import type { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxPC as LinuxPCClass } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { SshSession } from '@/network/protocols/ssh/session/SshSession';
import { SshConnectOptionsBuilder } from '@/network/protocols/ssh/SshConnectOptions';
import { SilentSshInteractionHandler } from '@/network/protocols/ssh/session/ISshInteractionHandler';
import { isOk } from '@/network/protocols/ssh/Result';
import { SftpSession } from '@/network/protocols/ssh/sftp/SftpSession';

export interface SshLan {
  pc1: LinuxPC;
  pc2: LinuxPC;
  pc3: LinuxPC;
  sw: GenericSwitch;
  /** Convenience map name → device. */
  byName: Record<'PC1' | 'PC2' | 'PC3', LinuxPC>;
  /** Convenience map IP → device. */
  byIp: Record<string, LinuxPC>;
}

export const PC1_IP = '10.0.0.1';
export const PC2_IP = '10.0.0.2';
export const PC3_IP = '10.0.0.3';
export const NETMASK = '255.255.255.0';

export function buildLan(): SshLan {
  const pc1 = new LinuxPCClass('linux-pc', 'PC1', 0, 0);
  const pc2 = new LinuxPCClass('linux-pc', 'PC2', 100, 0);
  const pc3 = new LinuxPCClass('linux-pc', 'PC3', 200, 0);
  const sw = new GenericSwitch('switch-generic', 'SW1', 8, 50, 50);

  // GenericSwitch numbers its ports `eth0`, `eth1`, `eth2`, ...
  const c1 = new Cable('c1');
  c1.connect(pc1.getPort('eth0')!, sw.getPort('eth0')!);
  const c2 = new Cable('c2');
  c2.connect(pc2.getPort('eth0')!, sw.getPort('eth1')!);
  const c3 = new Cable('c3');
  c3.connect(pc3.getPort('eth0')!, sw.getPort('eth2')!);

  return {
    pc1,
    pc2,
    pc3,
    sw,
    byName: { PC1: pc1, PC2: pc2, PC3: pc3 },
    byIp: { [PC1_IP]: pc1, [PC2_IP]: pc2, [PC3_IP]: pc3 },
  };
}

/** Configure eth0 on each PC and pre-warm ARP via mutual ping. */
export async function assignIps(lan: SshLan): Promise<void> {
  await lan.pc1.executeCommand(`ifconfig eth0 ${PC1_IP} netmask ${NETMASK}`);
  await lan.pc2.executeCommand(`ifconfig eth0 ${PC2_IP} netmask ${NETMASK}`);
  await lan.pc3.executeCommand(`ifconfig eth0 ${PC3_IP} netmask ${NETMASK}`);
  // Build the ARP cache between every pair so the SYN→SYN-ACK does not
  // fail with "no route" the first time TCP runs.
  for (const ip of [PC2_IP, PC3_IP]) await lan.pc1.executeCommand(`ping -c 1 ${ip}`);
  for (const ip of [PC1_IP, PC3_IP]) await lan.pc2.executeCommand(`ping -c 1 ${ip}`);
  for (const ip of [PC1_IP, PC2_IP]) await lan.pc3.executeCommand(`ping -c 1 ${ip}`);
}

/**
 * Open an authenticated `SshSession` from `from` to `targetIp` using the
 * default user `user` / password `admin`. Tests are expected to call
 * `session.disconnect()` themselves.
 */
export async function openSshSession(
  from: LinuxPC,
  targetIp: string,
  user: string = 'user',
  password: string = 'admin',
): Promise<SshSession> {
  // Local VFS for the SSH client (known_hosts, identity files). We use a
  // dedicated VFS independent of the device's executor so tests don't
  // accidentally pollute the local home directory.
  const localVfs = new VirtualFileSystem();
  const session = new SshSession({
    tcpConnector: (host, port) =>
      (from as unknown as { tcpConnect: (h: string, p: number) => Promise<unknown> })
        .tcpConnect(host, port) as Promise<never>,
    vfs: localVfs,
    localUser: 'root',
    localUid: 0,
    localGid: 0,
    knownHostsPath: '/root/.ssh/known_hosts',
    interactionHandler: new SilentSshInteractionHandler(password),
  });
  const result = await session.connect(
    SshConnectOptionsBuilder.create()
      .host(targetIp)
      .user(user)
      .port(22)
      .password(password)
      .strictHostKeyChecking('accept-new')
      .build(),
  );
  if (!isOk(result)) {
    throw new Error(`SSH connect failed: ${JSON.stringify(result.error)}`);
  }
  return session;
}

/**
 * One-shot remote command (BRD SSH-05): connect, exec, capture output,
 * disconnect. Returns `{ stdout, stderr, exitCode }`. Throws if the SSH
 * connection fails.
 */
export async function sshExec(
  from: LinuxPC,
  targetIp: string,
  command: string,
  user: string = 'user',
  password: string = 'admin',
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const session = await openSshSession(from, targetIp, user, password);
  const channelResult = session.openExecChannel(command);
  if (!isOk(channelResult)) {
    session.disconnect();
    throw new Error('failed to open exec channel');
  }
  const result = await channelResult.value.execute();
  channelResult.value.close();
  session.disconnect();
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  };
}

/**
 * Run several commands through a single authenticated SSH session.
 * Useful when state must persist (e.g. consecutive `mkdir` then `ls`).
 * Returns the trimmed stdout for each command in order.
 */
export async function sshScript(
  from: LinuxPC,
  targetIp: string,
  commands: readonly string[],
  user: string = 'user',
  password: string = 'admin',
): Promise<string[]> {
  const session = await openSshSession(from, targetIp, user, password);
  const out: string[] = [];
  for (const cmd of commands) {
    const channelResult = session.openExecChannel(cmd);
    if (!isOk(channelResult)) {
      out.push('<<channel error>>');
      continue;
    }
    const result = await channelResult.value.execute();
    channelResult.value.close();
    out.push(result.stdout.replace(/\n$/, ''));
  }
  session.disconnect();
  return out;
}

/**
 * Compare the output of a command run locally against the same command
 * run via SSH. Trailing whitespace differences are normalised away.
 */
export async function localVsSsh(
  device: LinuxPC,
  command: string,
): Promise<{ local: string; ssh: string }> {
  const local = (await device.executeCommand(command)).replace(/\n$/, '');
  const ssh = (await sshExec(device, '127.0.0.1', command)).stdout.replace(/\n$/, '');
  return { local, ssh };
}

/**
 * Build an authenticated `SftpSession` rooted at the caller's local VFS
 * (a fresh in-memory VFS) that already negotiated SSH with the target.
 */
export async function openSftpSession(
  from: LinuxPC,
  targetIp: string,
  user: string = 'user',
  password: string = 'admin',
): Promise<{ sftp: SftpSession; localVfs: VirtualFileSystem }> {
  const localVfs = new VirtualFileSystem();
  const sftp = new SftpSession({
    tcpConnector: (host, port) =>
      (from as unknown as { tcpConnect: (h: string, p: number) => Promise<unknown> })
        .tcpConnect(host, port) as Promise<never>,
    localVfs,
    localUser: 'root',
    localUid: 0,
    localGid: 0,
    localCwd: '/root',
    knownHostsPath: '/root/.ssh/known_hosts',
    interactionHandler: new SilentSshInteractionHandler(password),
    homeDirectory: '/root',
  });
  const banner = await sftp.connect(`${user}@${targetIp}`, { password });
  if (!sftp.isConnected()) {
    throw new Error(`SFTP connect failed: ${banner}`);
  }
  return { sftp, localVfs };
}
