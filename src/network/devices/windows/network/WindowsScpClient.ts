import { SftpSession } from '@/network/protocols/ssh/sftp/SftpSession';
import { SilentSshInteractionHandler } from '@/network/protocols/ssh/session/ISshInteractionHandler';
import { parseScpArgs } from '@/network/protocols/ssh/Scp';
import type { TcpConnector } from '@/network/core/TcpConnection';
import type { WindowsFileSystem } from '@/network/devices/windows/WindowsFileSystem';
import { WindowsLocalFs } from './WindowsLocalFs';

export interface WindowsScpClientOpts {
  readonly args: string[];
  readonly sourceHostname: string;
  readonly sourceIp: string;
  readonly sourceUser: string;
  readonly sourceHome: string;
  readonly localFs: WindowsFileSystem;
  readonly tcpConnector: TcpConnector;
  readonly password?: string;
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
  const localEp = parsed.source.remote ? parsed.destination : parsed.source;
  const remoteUser = remoteEp.user ?? opts.sourceUser;
  const remoteHost = remoteEp.host ?? '';
  const direction: 'upload' | 'download' = parsed.source.remote ? 'download' : 'upload';

  const localFs = new WindowsLocalFs(opts.localFs);
  const sftp = new SftpSession({
    tcpConnector: opts.tcpConnector,
    localVfs: localFs,
    localUser: opts.sourceUser,
    localUid: 1000,
    localGid: 1000,
    localCwd: opts.sourceHome,
    knownHostsPath: `${opts.sourceHome}\\.ssh\\known_hosts`,
    interactionHandler: new SilentSshInteractionHandler(opts.password ?? ''),
    homeDirectory: opts.sourceHome,
  });

  const banner = await sftp.connect(`${remoteUser}@${remoteHost}`, {
    port: parsed.port,
    password: opts.password,
  });
  if (!sftp.isConnected()) {
    sftp.disconnect();
    return {
      output: banner.startsWith('ssh:') ? banner : `ssh: connect to host ${remoteHost} port ${parsed.port}: Connection refused`,
      exitCode: 255,
    };
  }

  const transferOutput = direction === 'upload'
    ? (parsed.recursive
        ? sftp.putRecursive(localEp.path, remoteEp.path)
        : sftp.put(localEp.path, remoteEp.path))
    : (parsed.recursive
        ? sftp.getRecursive(remoteEp.path, localEp.path)
        : sftp.get(remoteEp.path, localEp.path));

  sftp.disconnect();

  const lines = transferOutput.split('\n').filter((l) => l.length > 0);
  const errLine = lines.find((l) => l.startsWith('remote open(') || l.includes(': No such file or directory') || l.includes('not a regular file'));
  if (errLine) return { output: `scp: ${errLine}`, exitCode: 1 };
  const progress = lines.find((l) => /100%/.test(l)) ?? lines[lines.length - 1] ?? '';
  return { output: progress, exitCode: 0 };
}
