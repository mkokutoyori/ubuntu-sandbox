import type { LinuxCommand, LinuxCommandOption } from '../LinuxCommand';
import { cmdUsermod } from '../../LinuxUserCommands';
import { Satisfy } from '../../iam/policy/CommandPrivilegePolicy';

const USERMOD_OPTIONS: readonly LinuxCommandOption[] = [
  { flag: '-s', aliases: ['--shell'], dest: 's', takesArg: true, argName: 'shell', description: 'Set the login shell' },
  { flag: '-d', aliases: ['--home'], dest: 'd', takesArg: true, argName: 'home_dir', description: 'Set the home directory' },
  { flag: '-m', aliases: ['--move-home'], dest: 'm', description: 'Move the content of the home directory (used with -d)' },
  { flag: '-G', aliases: ['-aG', '--groups'], dest: 'aG', takesArg: true, argName: 'group1,group2,...', description: 'Set supplementary groups' },
  { flag: '-L', aliases: ['--lock'], dest: 'L', description: 'Lock the account password' },
  { flag: '-U', aliases: ['--unlock'], dest: 'U', description: 'Unlock the account password' },
];

export const usermodCommand: LinuxCommand = {
  name: 'usermod',
  needsNetworkContext: false,
  usage: 'usermod [options] LOGIN',
  options: USERMOD_OPTIONS,
  privilege: { satisfiedBy: Satisfy.root },
  run: (ctx, args) => cmdUsermod(ctx.executor.ctx(), args),
};
