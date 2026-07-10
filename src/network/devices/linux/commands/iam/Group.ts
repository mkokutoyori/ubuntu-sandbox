import type { LinuxCommand, LinuxCommandOption } from '../LinuxCommand';
import { cmdGroupadd, cmdGroupmod, cmdGroupdel } from '../../LinuxUserCommands';
import { Satisfy } from '../../iam/policy/CommandPrivilegePolicy';

const GROUPADD_OPTIONS: readonly LinuxCommandOption[] = [
  { flag: '-g', aliases: ['--gid'], dest: 'g', takesArg: true, argName: 'gid', description: 'Set the numeric GID of the new group' },
  { flag: '-r', aliases: ['--system'], dest: 'r', description: 'Create a system group' },
  { flag: '-f', aliases: ['--force'], dest: 'f', description: 'Exit successfully if the group already exists' },
];

const GROUPMOD_OPTIONS: readonly LinuxCommandOption[] = [
  { flag: '-g', dest: 'g', takesArg: true, argName: 'gid', description: 'Set a new numeric GID' },
  { flag: '-n', aliases: ['--new-name'], dest: 'n', takesArg: true, argName: 'name', description: 'Rename the group' },
];

const GROUPDEL_OPTIONS: readonly LinuxCommandOption[] = [
  { flag: '-f', aliases: ['--force'], dest: 'f', description: 'Delete the group even if it is the primary group of a user' },
];

export const groupaddCommand: LinuxCommand = {
  name: 'groupadd',
  needsNetworkContext: false,
  usage: 'groupadd [options] GROUP',
  options: GROUPADD_OPTIONS,
  privilege: { satisfiedBy: Satisfy.root },
  run: (ctx, args) => cmdGroupadd(ctx.executor.ctx(), args),
};

export const groupmodCommand: LinuxCommand = {
  name: 'groupmod',
  needsNetworkContext: false,
  usage: 'groupmod [options] GROUP',
  options: GROUPMOD_OPTIONS,
  privilege: { satisfiedBy: Satisfy.root },
  run: (ctx, args) => cmdGroupmod(ctx.executor.ctx(), args),
};

export const groupdelCommand: LinuxCommand = {
  name: 'groupdel',
  needsNetworkContext: false,
  usage: 'groupdel [options] GROUP',
  options: GROUPDEL_OPTIONS,
  privilege: { satisfiedBy: Satisfy.root },
  run: (ctx, args) => cmdGroupdel(ctx.executor.ctx(), args),
};
