import type { LinuxCommand, LinuxCommandOption } from '../LinuxCommand';
import { Satisfy } from '../../iam/policy/CommandPrivilegePolicy';

const AUDITCTL_OPTIONS: readonly LinuxCommandOption[] = [
  { flag: '-a', dest: 'append', takesArg: true, argName: 'list,action', description: 'Append rule to the end of a list' },
  { flag: '-A', dest: 'prepend', takesArg: true, argName: 'list,action', description: 'Prepend rule at the start of a list' },
  { flag: '-b', dest: 'backlog', takesArg: true, argName: 'n', description: 'Set the max number of outstanding audit buffers' },
  { flag: '-d', dest: 'delete', takesArg: true, argName: 'list,action', description: 'Delete rule from a list' },
  { flag: '-D', dest: 'deleteAll', description: 'Delete all rules and watches' },
  { flag: '-e', dest: 'enabled', takesArg: true, argName: '0|1|2', description: 'Set enabled flag (0=off, 1=on, 2=locked until reboot)' },
  { flag: '-f', dest: 'failureMode', takesArg: true, argName: '0|1|2', description: 'Set failure mode (0=silent, 1=printk, 2=panic)' },
  { flag: '-F', dest: 'field', takesArg: true, argName: 'f=v', description: 'Build a rule field (name, operator, value)' },
  { flag: '-h', aliases: ['--help'], dest: 'help', description: 'Show help' },
  { flag: '-k', dest: 'key', takesArg: true, argName: 'key', description: 'Set the filter key on an audit rule' },
  { flag: '-l', dest: 'list', description: 'List all rules' },
  { flag: '-p', dest: 'perms', takesArg: true, argName: 'r|w|x|a', description: 'Set permissions filter on a watch' },
  { flag: '-q', dest: 'quiet', description: 'Suppress informational messages' },
  { flag: '-r', dest: 'rate', takesArg: true, argName: 'n', description: 'Set the message rate limit per second (0=none)' },
  { flag: '-R', dest: 'readFile', takesArg: true, argName: 'file', description: 'Read rules from a file' },
  { flag: '-s', dest: 'status', description: 'Report daemon status' },
  { flag: '-S', dest: 'syscall', takesArg: true, argName: 'syscall', description: 'Build a rule for a syscall name or number' },
  { flag: '-v', dest: 'version', description: 'Print version' },
  { flag: '-w', dest: 'watchAdd', takesArg: true, argName: 'path', description: 'Insert a watch at a path' },
  { flag: '-W', dest: 'watchRemove', takesArg: true, argName: 'path', description: 'Remove a watch at a path' },
];

export const auditctlCommand: LinuxCommand = {
  name: 'auditctl',
  needsNetworkContext: false,
  usage: 'auditctl [options]',
  options: AUDITCTL_OPTIONS,
  privilege: { satisfiedBy: Satisfy.root },
  run: (ctx, args) => ctx.executor.handleAuditctl(args).output,
  runWithStatus: (ctx, args) => Promise.resolve(ctx.executor.handleAuditctl(args)),
};
