import type { LinuxCommand, LinuxCommandOption } from '../LinuxCommand';
import { cmdFaillock } from '../../LinuxUserCommands';
import { Satisfy } from '../../iam/policy/CommandPrivilegePolicy';

const FAILLOCK_OPTIONS: readonly LinuxCommandOption[] = [
  { flag: '--user', aliases: ['-u'], dest: 'user', takesArg: true, argName: 'LOGIN', description: 'Limit the report/reset to one account' },
  { flag: '--reset', dest: 'reset', description: 'Reset the failure count' },
];

export const faillockCommand: LinuxCommand = {
  name: 'faillock',
  package: 'libpam-modules',
  needsNetworkContext: false,
  usage: 'faillock [--user LOGIN] [--reset]',
  options: FAILLOCK_OPTIONS,
  privilege: { satisfiedBy: Satisfy.root },
  run: (ctx, args) => cmdFaillock(ctx.executor.ctx(), args),
};
