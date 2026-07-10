import type { LinuxCommand, LinuxCommandOption } from '../LinuxCommand';
import { Deny } from '../../iam/policy/CommandPrivilegePolicy';

const DMESG_OPTIONS: readonly LinuxCommandOption[] = [
  { flag: '-T', aliases: ['--ctime', '-H', '--human'], dest: 'humanTime', description: 'Show human-readable timestamps' },
  { flag: '-c', aliases: ['--read-clear'], dest: 'readClear', description: 'Read and clear all messages' },
  { flag: '-C', aliases: ['--clear'], dest: 'clear', description: 'Clear the kernel ring buffer' },
  { flag: '-r', aliases: ['--raw'], dest: 'raw', description: 'Print the raw message buffer' },
  { flag: '-x', aliases: ['--decode'], dest: 'decode', description: 'Decode facility and level to readable strings' },
  { flag: '-w', aliases: ['--follow'], dest: 'follow', description: 'Wait for new messages' },
  { flag: '-d', aliases: ['--show-delta'], dest: 'showDelta', description: 'Show time delta between messages' },
  { flag: '-n', aliases: ['--console-level'], dest: 'consoleLevel', takesArg: true, argName: 'level', description: 'Set the level of messages printed to the console' },
  { flag: '-l', aliases: ['--level'], dest: 'level', takesArg: true, argName: 'list', description: 'Restrict output to the given comma-separated levels' },
  { flag: '-h', aliases: ['--help'], dest: 'help', description: 'Display help and exit' },
  { flag: '-V', aliases: ['--version'], dest: 'version', description: 'Display version and exit' },
];

export const dmesgCommand: LinuxCommand = {
  name: 'dmesg',
  needsNetworkContext: false,
  usage: 'dmesg [options]',
  options: DMESG_OPTIONS,
  privilege: {
    appliesWhen: (args) => args.some((a) =>
      a === '-c' || a === '--read-clear' || a === '-C' || a === '--clear' ||
      a === '-n' || a === '--console-level'),
    deny: Deny.withMessage('dmesg: read kernel buffer failed: Permission denied'),
  },
  run: (ctx, args) => ctx.executor.logMgr.executeDmesg(args),
};
