import type { LinuxCommand, LinuxCommandOption } from '../LinuxCommand';
import { Deny } from '../../iam/policy/CommandPrivilegePolicy';

const LASTLOG_OPTIONS: readonly LinuxCommandOption[] = [
  { flag: '-u', aliases: ['--user'], dest: 'user', takesArg: true, argName: 'LOGIN|UID|RANGE', description: 'Filter to one login, numeric UID, or an inclusive UID range LO-HI' },
  { flag: '-b', aliases: ['--before'], dest: 'before', takesArg: true, argName: 'days', description: 'Show only logins older than DAYS' },
  { flag: '-t', aliases: ['--time'], dest: 'time', takesArg: true, argName: 'days', description: 'Show only logins more recent than DAYS' },
  { flag: '-C', aliases: ['--clear'], dest: 'clear', description: 'Clear the lastlog record of the user (requires -u and root)' },
  { flag: '-S', aliases: ['--set'], dest: 'set', description: 'Set the lastlog record of the user to now (requires -u and root)' },
  { flag: '-R', aliases: ['--root'], dest: 'root', takesArg: true, argName: 'dir', description: 'Apply changes in the CHROOT directory' },
  { flag: '-h', aliases: ['--help'], dest: 'help', description: 'Display help and exit' },
  { flag: '-V', aliases: ['--version'], dest: 'version', description: 'Display version and exit' },
];

export const lastlogCommand: LinuxCommand = {
  name: 'lastlog',
  needsNetworkContext: false,
  usage: 'lastlog [options]',
  options: LASTLOG_OPTIONS,
  privilege: {
    appliesWhen: (args) => args.some((a) => a === '-C' || a === '--clear' || a === '-S' || a === '--set'),
    deny: Deny.withMessage('lastlog: must be root'),
  },
  run: (ctx, args) => ctx.executor.renderLastlog(args),
};
