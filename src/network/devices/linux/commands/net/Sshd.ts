import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { runSshd, type SshdCommandHost, type SshdCommandResult } from '@/network/protocols/ssh/server/SshdCommand';
import { LINUX_SSHD_PROFILE } from '@/network/protocols/ssh/server/SshdDump';
import { OPENSSH_UBUNTU_22_04 } from '@/network/protocols/ssh/OpenSshRelease';

export const sshdCommand: LinuxCommand = {
  name: 'sshd',
  package: 'openssh-server',
  needsNetworkContext: true,
  usage: 'sshd [-46DdeGiqTtV] [-C connection_spec] [-c host_cert_file] [-E log_file] [-f config_file] [-g login_grace_time] [-h host_key_file] [-o option] [-p port] [-u len]',
  help: 'OpenSSH daemon: test the configuration (-t), dump the effective configuration (-T), or start a daemon (-D, -p).',
  run(ctx: LinuxCommandContext, args: string[]): string {
    return sshdRun(ctx, args).output;
  },
  runWithStatusSync(ctx: LinuxCommandContext, args: string[]): SshdCommandResult {
    return sshdRun(ctx, args);
  },
  runWithStatus(ctx: LinuxCommandContext, args: string[]): Promise<SshdCommandResult> {
    return Promise.resolve(sshdRun(ctx, args));
  },
};

function sshdRun(ctx: LinuxCommandContext, args: string[]): SshdCommandResult {
  const executor = ctx.executor;
  const vfs = executor.vfs;
  const host: SshdCommandHost = {
    invokedAs: ctx.invokedAs ?? 'sshd',
    platform: 'linux',
    profile: LINUX_SSHD_PROFILE,
    defaultConfigPath: '/etc/ssh/sshd_config',
    includeBase: '/etc/ssh',
    version: OPENSSH_UBUNTU_22_04.clientVersion,
    source: vfs,
    resolvePath: (path) => vfs.normalizePath(path, executor.getCwd()),
    isPrivileged: () => executor.userMgr.currentUid === 0,
    canReadHostKey: (path) => vfs.exists(vfs.normalizePath(path, executor.getCwd())),
    portTaken: (address, port) => ctx.sshDaemon?.portTaken(address, port) ?? false,
    separationDirectoryMissing: () => (vfs.exists('/run/sshd') ? null : '/run/sshd'),
    logDaemon: (level, message) => ctx.sshDaemon?.logDaemon(level, message),
    startDaemon: (request) => { ctx.sshDaemon?.start(request); },
  };
  return runSshd(args, host);
}
