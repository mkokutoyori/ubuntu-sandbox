import type { LinuxCommand, LinuxCommandOption } from '../LinuxCommand';

const PASSWD_OPTIONS: readonly LinuxCommandOption[] = [
  { flag: '-S', aliases: ['--status'], dest: 'status', description: 'Report the password status for the account' },
  { flag: '-l', aliases: ['--lock'], dest: 'lock', description: 'Lock the account password' },
  { flag: '-u', aliases: ['--unlock'], dest: 'unlock', description: 'Unlock the account password' },
  { flag: '-e', aliases: ['--expire'], dest: 'expire', description: 'Force expiration of the password immediately' },
  { flag: '-d', aliases: ['--delete'], dest: 'delete', description: 'Delete the password, making the account passwordless' },
  { flag: '-n', aliases: ['--mindays'], dest: 'mindays', takesArg: true, argName: 'days', description: 'Set the minimum password age' },
  { flag: '-x', aliases: ['--maxdays'], dest: 'maxdays', takesArg: true, argName: 'days', description: 'Set the maximum password age' },
  { flag: '-w', aliases: ['--warndays'], dest: 'warndays', takesArg: true, argName: 'days', description: 'Set the expiration warning period' },
];

export const passwdCommand: LinuxCommand = {
  name: 'passwd',
  needsNetworkContext: false,
  usage: 'passwd [options] [LOGIN]',
  options: PASSWD_OPTIONS,
  privilege: {
    appliesWhen: (args) => args.length > 0 && !args[0].startsWith('-'),
    deny: (_command, args) => ({
      output: `passwd: You may not view or modify password information for ${args[0]}.`,
      exitCode: 1,
    }),
  },
  run: (ctx, args) => ctx.executor.handlePasswd(args).output,
  runWithStatus: (ctx, args) => Promise.resolve(ctx.executor.handlePasswd(args)),
};
