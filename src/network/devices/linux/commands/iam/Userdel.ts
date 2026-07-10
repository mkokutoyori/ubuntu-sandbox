import type { LinuxCommand, LinuxCommandOption } from '../LinuxCommand';
import { Satisfy } from '../../iam/policy/CommandPrivilegePolicy';

const USERDEL_OPTIONS: readonly LinuxCommandOption[] = [
  { flag: '-r', aliases: ['--remove'], dest: 'r', description: 'Remove the home directory and mail spool' },
  { flag: '-f', aliases: ['--force'], dest: 'f', description: 'Force removal even if the user is still logged in' },
];

export const userdelCommand: LinuxCommand = {
  name: 'userdel',
  needsNetworkContext: false,
  usage: 'userdel [options] LOGIN',
  options: USERDEL_OPTIONS,
  privilege: { satisfiedBy: Satisfy.root },
  run: (ctx, args) => ctx.executor.handleUserdel(args).output,
  runWithStatus: (ctx, args) => Promise.resolve(ctx.executor.handleUserdel(args)),
};
