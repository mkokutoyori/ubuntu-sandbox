import type { LinuxCommand, LinuxCommandOption } from '../LinuxCommand';
import { Satisfy } from '../../iam/policy/CommandPrivilegePolicy';

const FAILLOCK_OPTIONS: readonly LinuxCommandOption[] = [
  { flag: '--dir', dest: 'dir', takesArg: true, argName: 'DIR', description: 'Tally directory' },
  { flag: '--user', dest: 'user', takesArg: true, argName: 'LOGIN', description: 'Limit the report/reset to one account' },
  { flag: '--reset', dest: 'reset', description: 'Reset the failure count' },
];

export const faillockCommand: LinuxCommand = {
  name: 'faillock',
  package: 'libpam-modules',
  needsNetworkContext: false,
  usage: 'faillock [--dir /path/to/tally-directory] [--user username] [--reset]',
  options: FAILLOCK_OPTIONS,
  privilege: { satisfiedBy: Satisfy.root },
  run: (ctx, args) => ctx.executor.runFaillock(args).output,
  runWithStatus: (ctx, args) => Promise.resolve(ctx.executor.runFaillock(args)),
};
