import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { parseSftpServerArguments, SFTP_SERVER_USAGE } from '@/network/protocols/ssh/sftp/server/SftpServerOptions';

export const SFTP_SERVER_PATH = '/usr/lib/openssh/sftp-server';

export const sftpServerCommand: LinuxCommand = {
  name: 'sftp-server',
  needsNetworkContext: true,
  binaryPath: SFTP_SERVER_PATH,
  package: 'openssh-sftp-server',
  usage: SFTP_SERVER_USAGE.split('\n')[0],
  help: 'SFTP server subsystem.',
  async run(_ctx: LinuxCommandContext, args: string[]): Promise<string> {
    const outcome = parseSftpServerArguments(args);
    if (outcome.kind === 'query') return outcome.lines.join('\n');
    if (outcome.kind === 'usage') return SFTP_SERVER_USAGE;
    if (outcome.kind === 'fatal') return outcome.message;
    return '';
  },
  async runWithStatus(ctx: LinuxCommandContext, args: string[]) {
    const outcome = parseSftpServerArguments(args);
    if (outcome.kind === 'usage') return { output: '', exitCode: 1, stderr: SFTP_SERVER_USAGE };
    if (outcome.kind === 'fatal') return { output: '', exitCode: 255, stderr: outcome.message };
    return { output: await sftpServerCommand.run(ctx, args) as string, exitCode: 0 };
  },
};
