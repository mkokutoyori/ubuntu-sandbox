import type { LinuxCommand, LinuxCommandOption } from '../LinuxCommand';
import { cmdAusearch } from '../../audit/AuditCommands';
import { Satisfy } from '../../iam/policy/CommandPrivilegePolicy';

const AUSEARCH_OPTIONS: readonly LinuxCommandOption[] = [
  { flag: '-m', aliases: ['--message'], dest: 'message', takesArg: true, argName: 'type', description: 'Search for an event of this message type' },
  { flag: '-ui', aliases: ['--uid'], dest: 'uid', takesArg: true, argName: 'id', description: 'Search for events with this user ID' },
  { flag: '-ua', aliases: ['--loginuid'], dest: 'loginuid', takesArg: true, argName: 'id', description: 'Search for events with this login user ID' },
  { flag: '-u', aliases: ['--user'], dest: 'user', takesArg: true, argName: 'id|name', description: 'Search for events matching a UID or login name' },
  { flag: '-x', aliases: ['--exe'], dest: 'exe', takesArg: true, argName: 'path', description: 'Search for events by executable path' },
  { flag: '-c', aliases: ['--comm'], dest: 'comm', takesArg: true, argName: 'name', description: 'Search for events by command name' },
  { flag: '-k', aliases: ['--key'], dest: 'key', takesArg: true, argName: 'key', description: 'Search for events matching an audit rule key' },
  { flag: '-f', aliases: ['--file'], dest: 'file', takesArg: true, argName: 'path', description: 'Search for events by file name' },
  { flag: '-i', aliases: ['--interpret'], dest: 'interpret', description: 'Interpret numeric IDs into human-readable names' },
  { flag: '--success', dest: 'success', takesArg: true, argName: 'yes|no', description: 'Search for events with the given success value' },
  { flag: '-ts', aliases: ['--start'], dest: 'start', takesArg: true, argName: 'date', description: 'Search for events after this time' },
  { flag: '-te', aliases: ['--end'], dest: 'end', takesArg: true, argName: 'date', description: 'Search for events before this time' },
  { flag: '-p', aliases: ['--pid'], dest: 'pid', takesArg: true, argName: 'pid', description: 'Search for events with this process ID' },
  { flag: '-b', aliases: ['--boot'], dest: 'boot', takesArg: true, argName: 'n', description: 'Search back n boots' },
];

export const ausearchCommand: LinuxCommand = {
  name: 'ausearch',
  needsNetworkContext: false,
  usage: 'ausearch [options]',
  options: AUSEARCH_OPTIONS,
  privilege: { satisfiedBy: Satisfy.root },
  run: (ctx, args) => cmdAusearch(ctx.executor.auditLog, ctx.executor.resolveAusearchUserArgs(args)),
};
