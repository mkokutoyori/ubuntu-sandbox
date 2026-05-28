/**
 * runWindowsSftpClient — OpenSSH-for-Windows sftp.exe binding.
 *
 * Mirrors LinuxCommandExecutor.runSshTransport for the Windows side: probe
 * the remote via ssh, resolve an ISftpFileSystem on it (Linux VFS, Windows
 * NTFS, or a router synthetic source), then drive the same
 * SftpInteractiveSession against it.
 */

import { runWindowsSshClient } from './WindowsSshClient';
import { findHostByAddress } from '../../linux/network/HostLookup';
import { SftpInteractiveSession } from '@/network/protocols/ssh/sftp/SftpInteractiveSession';
import { SftpCommandScript } from '@/network/protocols/ssh/sftp/SftpCommandScript';
import { VfsSftpFileSystem } from '@/network/protocols/ssh/sftp/VfsSftpFileSystem';
import { WindowsSftpFileSystem } from '@/network/protocols/ssh/sftp/WindowsSftpFileSystem';
import { RouterSftpFileSystem } from '@/network/protocols/ssh/sftp/RouterSftpFileSystem';
import type { ISftpFileSystem } from '@/network/protocols/ssh/sftp/ISftpFileSystem';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import type { WindowsFileSystem } from '@/network/devices/windows/WindowsFileSystem';

export interface WindowsSftpClientOpts {
  readonly args: string[];
  readonly stdin?: string;
  readonly sourceHostname: string;
  readonly sourceIp: string;
  readonly sourceUser: string;
  readonly sourceHome: string;
  readonly localFs: WindowsFileSystem;
}

export interface WindowsSftpClientResult {
  readonly output: string;
  readonly exitCode: number;
}

const SFTP_USAGE =
  'usage: sftp [-46aCfNpqrv] [-B buffer_size] [-b batchfile] [-c cipher]\n' +
  '            [-D sftp_server_command] [-F ssh_config] [-i identity_file]\n' +
  '            [-J destination] [-l limit] [-o ssh_option] [-P port]\n' +
  '            [-R num_requests] [-S program] [-s subsystem | sftp_server]\n' +
  '            [-X sftp_option] destination';

export async function runWindowsSftpClient(opts: WindowsSftpClientOpts): Promise<WindowsSftpClientResult> {
  const positional = opts.args.filter(a => !a.startsWith('-'));
  if (positional.length === 0) {
    return { output: SFTP_USAGE, exitCode: 1 };
  }

  const target = positional[positional.length - 1];
  const userMatch = /^([\w.-]+)@(.+)$/.exec(target);
  const host = userMatch ? userMatch[2] : target;
  const remoteUser = userMatch ? userMatch[1] : opts.sourceUser;

  const pIdx = opts.args.indexOf('-P');
  const probePort = pIdx >= 0 ? opts.args[pIdx + 1] : null;
  const probeArgs = probePort
    ? ['-p', probePort, `${remoteUser}@${host}`, 'hostname']
    : [`${remoteUser}@${host}`, 'hostname'];
  const probe = await runWindowsSshClient({ ...opts, args: probeArgs });
  if (probe.exitCode !== 0) {
    return { output: `sftp: ${probe.output.replace(/^ssh:\s*/, '')}`, exitCode: probe.exitCode };
  }

  const found = findHostByAddress(host, { readFile: () => null });
  const remoteFs = resolveRemoteSftpFs(found?.device);
  if (!remoteFs) {
    return { output: `sftp: ${host}: no route to host`, exitCode: 1 };
  }

  const session = new SftpInteractiveSession({
    local: new WindowsSftpFileSystem(opts.localFs as ConstructorParameters<typeof WindowsSftpFileSystem>[0]),
    remote: remoteFs,
    initialLocalCwd: opts.sourceHome,
  });
  session.run(SftpCommandScript.parse(opts.stdin ?? ''));
  return { output: `Connected to ${host}.\n${session.transcript}\nsftp> `, exitCode: 0 };
}

function resolveRemoteSftpFs(device: unknown): ISftpFileSystem | null {
  if (!device) return null;
  const linuxVfs = (device as { executor?: { vfs?: VirtualFileSystem } }).executor?.vfs;
  if (linuxVfs) {
    return new VfsSftpFileSystem(linuxVfs, { uid: 0, gid: 0, umask: 0o022 });
  }
  const windowsFs = (device as { fs?: unknown }).fs;
  if (windowsFs && typeof (windowsFs as { createFile?: unknown }).createFile === 'function') {
    return new WindowsSftpFileSystem(windowsFs as ConstructorParameters<typeof WindowsSftpFileSystem>[0]);
  }
  const sftpSource = (device as { getSftpFileSource?: () => unknown }).getSftpFileSource?.();
  if (sftpSource && typeof (sftpSource as { read?: unknown }).read === 'function') {
    return new RouterSftpFileSystem(sftpSource as ConstructorParameters<typeof RouterSftpFileSystem>[0]);
  }
  return null;
}
