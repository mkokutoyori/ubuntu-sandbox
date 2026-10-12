import type { LinuxCommand, LinuxCommandOption } from '../LinuxCommand';
import { Satisfy } from '../../iam/policy/CommandPrivilegePolicy';

const AUDITCTL_OPTIONS: readonly LinuxCommandOption[] = [
  { flag: '-a', dest: 'append', takesArg: true, argName: 'list,action', description: 'Append rule to end of list with action' },
  { flag: '-A', dest: 'prepend', takesArg: true, argName: 'list,action', description: 'Add rule at beginning of list with action' },
  { flag: '-b', dest: 'backlog', takesArg: true, argName: 'backlog', description: 'Set max number of outstanding audit buffers allowed' },
  { flag: '-c', dest: 'continue', description: 'Continue through errors in rules' },
  { flag: '-C', dest: 'compare', takesArg: true, argName: 'f=f', description: 'Compare collected fields if available' },
  { flag: '-d', dest: 'delete', takesArg: true, argName: 'list,action', description: 'Delete rule from list with action' },
  { flag: '-D', dest: 'deleteAll', description: 'Delete all rules and watches' },
  { flag: '-e', dest: 'enabled', takesArg: true, argName: '0..2', description: 'Set enabled flag' },
  { flag: '-f', dest: 'failureMode', takesArg: true, argName: '0..2', description: 'Set failure flag' },
  { flag: '-F', dest: 'field', takesArg: true, argName: 'f=v', description: 'Build rule: field name, operator, value' },
  { flag: '-h', dest: 'help', description: 'Help' },
  { flag: '-i', dest: 'ignoreErrors', description: 'Ignore errors when reading rules from file' },
  { flag: '-k', dest: 'key', takesArg: true, argName: 'key', description: 'Set filter key on audit rule' },
  { flag: '-l', dest: 'list', description: 'List rules' },
  { flag: '-m', dest: 'message', takesArg: true, argName: 'text', description: 'Send a user-space message' },
  { flag: '-p', dest: 'perms', takesArg: true, argName: 'r|w|x|a', description: 'Set permissions filter on watch' },
  { flag: '-q', dest: 'subtree', takesArg: true, argName: 'mount,subtree', description: "Make subtree part of mount point's dir watches" },
  { flag: '-r', dest: 'rate', takesArg: true, argName: 'rate', description: 'Set limit in messages/sec (0=none)' },
  { flag: '-R', dest: 'readFile', takesArg: true, argName: 'file', description: 'Read rules from file' },
  { flag: '-s', dest: 'status', description: 'Report status' },
  { flag: '-S', dest: 'syscall', takesArg: true, argName: 'syscall', description: 'Build rule: syscall name or number' },
  { flag: '--signal', dest: 'signal', takesArg: true, argName: 'signal', description: 'Send the specified signal to the daemon' },
  { flag: '-t', dest: 'trim', description: 'Trim directory watches' },
  { flag: '-v', dest: 'version', description: 'Version' },
  { flag: '-w', dest: 'watchAdd', takesArg: true, argName: 'path', description: 'Insert watch at path' },
  { flag: '-W', dest: 'watchRemove', takesArg: true, argName: 'path', description: 'Remove watch at path' },
  { flag: '--loginuid-immutable', dest: 'loginuidImmutable', description: 'Make loginuids unchangeable once set' },
  { flag: '--backlog_wait_time', dest: 'backlogWaitTime', takesArg: true, argName: 'time', description: 'Set the kernel backlog_wait_time' },
  { flag: '--reset-lost', dest: 'resetLost', description: 'Reset the lost record counter' },
  { flag: '--reset_backlog_wait_time_actual', dest: 'resetBacklogWaitTimeActual', description: 'Reset the actual backlog wait time counter' },
];

export const auditctlCommand: LinuxCommand = {
  name: 'auditctl',
  needsNetworkContext: false,
  usage: 'auditctl [options]',
  options: AUDITCTL_OPTIONS,
  privilege: { satisfiedBy: Satisfy.root },
  run: (ctx, args) => {
    const result = ctx.executor.handleAuditctl(args);
    return result.output;
  },
  runWithStatus: (ctx, args) => Promise.resolve(ctx.executor.handleAuditctl(args)),
};
