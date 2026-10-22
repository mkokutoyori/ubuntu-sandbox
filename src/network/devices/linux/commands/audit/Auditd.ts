import type { LinuxCommand } from '../LinuxCommand';

export const auditdCommand: LinuxCommand = {
  name: 'auditd',
  needsNetworkContext: false,
  usage: 'auditd [-f] [-l] [-n] [-s disable|enable|nochange] [-c <config_file>]',
  options: [
    { flag: '-f', dest: 'foreground', description: 'Stay in the foreground, log to stderr' },
    { flag: '-l', dest: 'allowLinks', description: 'Follow symbolic links when reading configuration' },
    { flag: '-n', dest: 'noFork', description: 'Do not fork' },
    { flag: '-s', dest: 'startup', takesArg: true, argName: 'disable|enable|nochange', description: 'Initial audit state' },
    { flag: '-c', dest: 'configDir', takesArg: true, argName: 'config_file', description: 'Configuration directory' },
  ],
  run: (ctx, args) => ctx.executor.handleAuditd(args).output,
  runWithStatus: (ctx, args) => Promise.resolve(ctx.executor.handleAuditd(args)),
};
