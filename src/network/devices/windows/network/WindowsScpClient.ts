import { runWindowsSshClient } from './WindowsSshClient';
import { findHostByAddress } from '../../linux/network/HostLookup';
import { ScpSession } from '@/network/protocols/ssh/scp/ScpSession';
import { parseScpArgs } from '@/network/protocols/ssh/Scp';
import { VfsSftpFileSystem } from '@/network/protocols/ssh/sftp/VfsSftpFileSystem';
import { WindowsSftpFileSystem } from '@/network/protocols/ssh/sftp/WindowsSftpFileSystem';
import { RouterSftpFileSystem } from '@/network/protocols/ssh/sftp/RouterSftpFileSystem';
import type { ISftpFileSystem } from '@/network/protocols/ssh/sftp/ISftpFileSystem';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import type { WindowsFileSystem } from '@/network/devices/windows/WindowsFileSystem';

export interface WindowsScpClientOpts {
  readonly args: string[];
  readonly sourceHostname: string;
  readonly sourceIp: string;
  readonly sourceUser: string;
  readonly sourceHome: string;
  readonly localFs: WindowsFileSystem;
}

export interface WindowsScpClientResult {
  readonly output: string;
  readonly exitCode: number;
}

const SCP_USAGE =
  'usage: scp [-346BCpqrTv] [-c cipher] [-D sftp_server_command]\n' +
  '           [-F ssh_config] [-i identity_file] [-J destination]\n' +
  '           [-l limit] [-o ssh_option] [-P port] [-S program]\n' +
  '           [-X sftp_option] source ... target';

export async function runWindowsScpClient(opts: WindowsScpClientOpts): Promise<WindowsScpClientResult> {
  const parsed = parseScpArgs([...opts.args]);
  if (!parsed) {
    return { output: SCP_USAGE, exitCode: 1 };
  }
  if (parsed.source.remote === parsed.destination.remote) {
    if (parsed.source.remote) {
      return { output: 'scp: remote-to-remote copy not supported in simulator', exitCode: 1 };
    }
    return { output: 'scp: exactly one of source/destination must be remote', exitCode: 1 };
  }

  const remoteEp = parsed.source.remote ? parsed.source : parsed.destination;
  const remoteUser = remoteEp.user ?? opts.sourceUser;
  const remoteHost = remoteEp.host ?? '';
  const probeArgs = parsed.port !== 22
    ? ['-p', String(parsed.port), `${remoteUser}@${remoteHost}`, 'hostname']
    : [`${remoteUser}@${remoteHost}`, 'hostname'];
  const probe = await runWindowsSshClient({
    args: probeArgs,
    sourceHostname: opts.sourceHostname,
    sourceIp: opts.sourceIp,
    sourceUser: opts.sourceUser,
    sourceHome: opts.sourceHome,
    localFs: {
      readFile: (p) => opts.localFs.readFile(p),
      createFile: (p, c) => {
        const dir = p.substring(0, p.lastIndexOf('\\'));
        if (dir && !opts.localFs.exists(dir)) opts.localFs.mkdirp(dir);
        return opts.localFs.createFile(p, c);
      },
    },
  });
  if (probe.exitCode !== 0) {
    return { output: `scp: ${probe.output.replace(/^ssh:\s*/, '')}`, exitCode: probe.exitCode };
  }

  const found = findHostByAddress(remoteHost, { readFile: () => null });
  const remoteFs = resolveRemoteSftpFs(found?.device);
  if (!remoteFs) {
    return { output: `scp: ${remoteHost}: no route to host`, exitCode: 1 };
  }

  const localFs = new WindowsSftpFileSystem(opts.localFs as ConstructorParameters<typeof WindowsSftpFileSystem>[0]);
  const session = new ScpSession({
    args: opts.args,
    resolveRemote: (h) => (h === remoteHost ? remoteFs : null),
    local: { fs: localFs, cwd: opts.sourceHome },
  });
  return session.run();
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
