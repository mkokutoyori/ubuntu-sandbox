/**
 * runWindowsSftpClient — OpenSSH-for-Windows sftp.exe binding.
 *
 * Parses the command line and drives SftpInteractiveSession against a
 * remote file system the device opens over a real SSH session
 * (`openRemote`): every listing, read and write is an SFTP packet on the
 * cable, and the remote server's own account decides what is allowed.
 */

import { winWireExecTarget, type WinWireTarget } from './WindowsSshClient';
import { SftpInteractiveSession } from '@/network/protocols/ssh/sftp/SftpInteractiveSession';
import { SftpCommandScript } from '@/network/protocols/ssh/sftp/SftpCommandScript';
import { WindowsSftpFileSystem } from '@/network/protocols/ssh/sftp/WindowsSftpFileSystem';
import type { ISftpFileSystem } from '@/network/protocols/ssh/sftp/ISftpFileSystem';
import type { WindowsFileSystem } from '@/network/devices/windows/WindowsFileSystem';

export type WindowsSftpRemote =
  | { readonly kind: 'opened'; readonly fs: ISftpFileSystem; readonly release: () => void }
  | { readonly kind: 'refused'; readonly message: string };

export interface WindowsSftpClientOpts {
  readonly args: string[];
  readonly stdin?: string;
  readonly sourceUser: string;
  readonly sourceHome: string;
  readonly localFs: WindowsFileSystem;
  readonly openRemote: (target: WinWireTarget) => Promise<WindowsSftpRemote>;
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

  const destination = positional[positional.length - 1];
  const sshArgs = opts.args.map(a => (a === '-P' ? '-p' : a));
  const target = winWireExecTarget(sshArgs, opts.sourceUser);
  if (!target) {
    return { output: `sftp: Could not resolve hostname ${destination}: Name or service not known`, exitCode: 1 };
  }

  const bIdx = opts.args.indexOf('-b');
  let batch = opts.stdin ?? '';
  if (bIdx >= 0) {
    const batchPath = opts.args[bIdx + 1];
    if (!batchPath) return { output: 'sftp: missing argument to -b', exitCode: 1 };
    const body = opts.localFs.readFile(batchPath);
    if (!body.ok || body.content === undefined) {
      return { output: `Couldn't open ${batchPath}: No such file or directory`, exitCode: 1 };
    }
    batch = body.content;
  }

  const remote = await opts.openRemote(target);
  if (remote.kind === 'refused') return { output: remote.message, exitCode: 1 };

  const session = new SftpInteractiveSession({
    local: new WindowsSftpFileSystem(opts.localFs as ConstructorParameters<typeof WindowsSftpFileSystem>[0]),
    remote: remote.fs,
    initialLocalCwd: opts.sourceHome,
    initialRemoteCwd: remote.fs.initialCwd?.() ?? undefined,
  });
  session.run(SftpCommandScript.parse(batch));
  remote.release();
  return { output: `Connected to ${target.host}.\n${session.transcript}\nsftp> `, exitCode: 0 };
}
