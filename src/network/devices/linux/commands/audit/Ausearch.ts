import type { LinuxCommand, LinuxCommandOption } from '../LinuxCommand';
import { runAusearch } from '../../audit/tools/AusearchTool';
import { auditToolHost } from '../../audit/tools/LinuxAuditToolHost';
import { Satisfy } from '../../iam/policy/CommandPrivilegePolicy';

const AUSEARCH_OPTIONS: readonly LinuxCommandOption[] = [
  { flag: '-a', aliases: ['--event'], dest: 'event', takesArg: true, argName: 'id', description: 'Search based on audit event id' },
  { flag: '--arch', dest: 'arch', takesArg: true, argName: 'cpu', description: 'Search based on the CPU architecture' },
  { flag: '-c', aliases: ['--comm'], dest: 'comm', takesArg: true, argName: 'name', description: 'Search based on command line name' },
  { flag: '--checkpoint', dest: 'checkpoint', takesArg: true, argName: 'file', description: 'Search from last complete event' },
  { flag: '-e', aliases: ['--exit'], dest: 'exit', takesArg: true, argName: 'code', description: 'Search based on syscall exit code or errno' },
  { flag: '--eoe-timeout', dest: 'eoeTimeout', takesArg: true, argName: 'secs', description: 'End of event timeout' },
  { flag: '--escape', dest: 'escape', takesArg: true, argName: 'mode', description: 'Escape output' },
  { flag: '-f', aliases: ['--file'], dest: 'file', takesArg: true, argName: 'path', description: 'Search based on file name' },
  { flag: '--format', dest: 'format', takesArg: true, argName: 'fmt', description: 'Results format: raw, default, interpret, csv, text' },
  { flag: '-ga', aliases: ['--gid-all'], dest: 'gidAll', takesArg: true, argName: 'gid', description: 'Search based on all group ids' },
  { flag: '-ge', aliases: ['--gid-effective'], dest: 'gidEffective', takesArg: true, argName: 'gid', description: 'Search based on effective group id' },
  { flag: '-gi', aliases: ['--gid'], dest: 'gid', takesArg: true, argName: 'gid', description: 'Search based on group id' },
  { flag: '-hn', aliases: ['--host'], dest: 'host', takesArg: true, argName: 'name', description: 'Search based on remote host name' },
  { flag: '-if', aliases: ['--input'], dest: 'input', takesArg: true, argName: 'file', description: 'Use this file instead of the current logs' },
  { flag: '-k', aliases: ['--key'], dest: 'key', takesArg: true, argName: 'key', description: 'Search based on key field' },
  { flag: '-m', aliases: ['--message'], dest: 'message', takesArg: true, argName: 'type', description: 'Search based on message type' },
  { flag: '-n', aliases: ['--node'], dest: 'node', takesArg: true, argName: 'name', description: 'Search based on name of the machine' },
  { flag: '-o', aliases: ['--object'], dest: 'object', takesArg: true, argName: 'context', description: 'Search based on context of object' },
  { flag: '-p', aliases: ['--pid'], dest: 'pid', takesArg: true, argName: 'pid', description: 'Search based on process id' },
  { flag: '-pp', aliases: ['--ppid'], dest: 'ppid', takesArg: true, argName: 'pid', description: 'Search based on parent process id' },
  { flag: '-sc', aliases: ['--syscall'], dest: 'syscall', takesArg: true, argName: 'name', description: 'Search based on syscall name or number' },
  { flag: '-se', aliases: ['--context'], dest: 'context', takesArg: true, argName: 'context', description: 'Search based on subject or object context' },
  { flag: '--session', dest: 'session', takesArg: true, argName: 'id', description: 'Search based on login session id' },
  { flag: '-su', aliases: ['--subject'], dest: 'subject', takesArg: true, argName: 'context', description: 'Search based on context of the subject' },
  { flag: '-sv', aliases: ['--success'], dest: 'success', takesArg: true, argName: 'yes|no', description: 'Search based on syscall or event success value' },
  { flag: '-te', aliases: ['--end'], dest: 'end', takesArg: true, argName: 'date', description: 'Ending date and time for search' },
  { flag: '-ts', aliases: ['--start'], dest: 'start', takesArg: true, argName: 'date', description: 'Starting date and time for search' },
  { flag: '-tm', aliases: ['--terminal'], dest: 'terminal', takesArg: true, argName: 'tty', description: 'Search based on terminal' },
  { flag: '-ua', aliases: ['--uid-all'], dest: 'uidAll', takesArg: true, argName: 'uid', description: 'Search based on all user ids' },
  { flag: '-ue', aliases: ['--uid-effective'], dest: 'uidEffective', takesArg: true, argName: 'uid', description: 'Search based on effective user id' },
  { flag: '-ui', aliases: ['--uid'], dest: 'uid', takesArg: true, argName: 'uid', description: 'Search based on user id' },
  { flag: '-ul', aliases: ['--loginuid'], dest: 'loginuid', takesArg: true, argName: 'uid', description: 'Search based on the login id of the user' },
  { flag: '-uu', aliases: ['--uuid'], dest: 'uuid', takesArg: true, argName: 'uuid', description: 'Search for events related to the virtual machine with this UUID' },
  { flag: '-vm', aliases: ['--vm-name'], dest: 'vmName', takesArg: true, argName: 'name', description: 'Search for events related to the virtual machine with this name' },
  { flag: '-x', aliases: ['--executable'], dest: 'executable', takesArg: true, argName: 'path', description: 'Search based on executable name' },
  { flag: '-i', aliases: ['--interpret'], dest: 'interpret', description: 'Interpret results to be human readable' },
  { flag: '-r', aliases: ['--raw'], dest: 'raw', description: 'Output is completely unformatted' },
  { flag: '-w', aliases: ['--word'], dest: 'word', description: 'String matches are whole word' },
  { flag: '--just-one', dest: 'justOne', description: 'Emit just one event' },
  { flag: '--input-logs', dest: 'inputLogs', description: 'Use the logs even if stdin is a pipe' },
  { flag: '-l', aliases: ['--line-buffered'], dest: 'lineBuffered', description: 'Flush output on every line' },
  { flag: '--debug', dest: 'debug', description: 'Write malformed events that are skipped to stderr' },
];

export const ausearchCommand: LinuxCommand = {
  name: 'ausearch',
  needsNetworkContext: false,
  usage: 'ausearch [options]',
  options: AUSEARCH_OPTIONS,
  privilege: { satisfiedBy: Satisfy.root },
  readsStdin: true,
  run: (ctx, args, stdin) => {
    const result = runAusearch(auditToolHost(ctx.executor), args, stdin ?? null);
    return result.stdout + result.stderr;
  },
  runWithStatus: (ctx, args, stdin) => {
    const result = runAusearch(auditToolHost(ctx.executor), args, stdin ?? null);
    return Promise.resolve({ output: result.stdout, exitCode: result.exitCode, stderr: result.stderr, interleaved: result.interleaved });
  },
};
