import type { LinuxCommand, LinuxCommandOption } from '../LinuxCommand';
import { Satisfy } from '../../iam/policy/CommandPrivilegePolicy';

const LOGROTATE_OPTIONS: readonly LinuxCommandOption[] = [
  { flag: '-f', aliases: ['--force'], dest: 'force', description: 'Force rotation even if it is not necessary' },
  { flag: '-d', aliases: ['--debug'], dest: 'debug', description: 'Dry-run: print what would happen without doing it' },
  { flag: '-v', aliases: ['--verbose'], dest: 'verbose', description: 'Display messages during rotation' },
  { flag: '-m', aliases: ['--mail'], dest: 'mail', takesArg: true, argName: 'command', description: 'Command used to mail logs' },
  { flag: '-s', aliases: ['--state'], dest: 'state', takesArg: true, argName: 'file', description: 'Alternate state file' },
];

export const logrotateCommand: LinuxCommand = {
  name: 'logrotate',
  package: 'logrotate',
  needsNetworkContext: false,
  usage: 'logrotate [options] CONFIG',
  options: LOGROTATE_OPTIONS,
  privilege: { satisfiedBy: Satisfy.root },
  run: (ctx, args) => ctx.executor.cmdLogrotate(args).output,
  runWithStatus: (ctx, args) => Promise.resolve(ctx.executor.cmdLogrotate(args)),
};
