import type { LinuxCommand, LinuxCommandOption } from '../LinuxCommand';
import { runAureport } from '../../audit/tools/AureportTool';
import { auditToolHost } from '../../audit/tools/LinuxAuditToolHost';
import { Satisfy } from '../../iam/policy/CommandPrivilegePolicy';

const AUREPORT_OPTIONS: readonly LinuxCommandOption[] = [
  { flag: '-x', aliases: ['--executable'], dest: 'executable', description: 'Executable summary report' },
  { flag: '-p', aliases: ['--pid'], dest: 'pid', description: 'PID summary report' },
  { flag: '-u', aliases: ['--user'], dest: 'user', description: 'User ID summary report' },
  { flag: '-g', aliases: ['--group'], dest: 'group', description: 'Group ID summary report' },
  { flag: '-f', aliases: ['--file'], dest: 'file', description: 'File summary report' },
  { flag: '-s', aliases: ['--syscall'], dest: 'syscall', description: 'Syscall summary report' },
  { flag: '-t', aliases: ['--terminal'], dest: 'terminal', description: 'Terminal summary report' },
  { flag: '-k', aliases: ['--key'], dest: 'key', description: 'Key summary report' },
  { flag: '-l', aliases: ['--login'], dest: 'login', description: 'Login summary report' },
  { flag: '-a', aliases: ['--anomaly'], dest: 'anomaly', description: 'Anomaly summary report' },
  { flag: '-e', aliases: ['--event'], dest: 'event', description: 'Event summary report' },
  { flag: '-m', aliases: ['--mods'], dest: 'mods', description: 'Mandatory access control summary report' },
  { flag: '-i', aliases: ['--interpret', '--integrity'], dest: 'interpret', description: 'Interpret numeric IDs, or the integrity summary report' },
  { flag: '-h', aliases: ['--host'], dest: 'host', description: 'Host summary report' },
  { flag: '-c', aliases: ['--config'], dest: 'config', description: 'Configuration change summary report' },
];

export const aureportCommand: LinuxCommand = {
  name: 'aureport',
  needsNetworkContext: false,
  usage: 'aureport [options]',
  options: AUREPORT_OPTIONS,
  privilege: { satisfiedBy: Satisfy.root },
  readsStdin: true,
  run: (ctx, args, stdin) => {
    const result = runAureport(auditToolHost(ctx.executor), args, stdin ?? null);
    return result.stdout + result.stderr;
  },
  runWithStatus: (ctx, args, stdin) => {
    const result = runAureport(auditToolHost(ctx.executor), args, stdin ?? null);
    return Promise.resolve({ output: result.stdout, exitCode: result.exitCode, stderr: result.stderr, interleaved: result.interleaved });
  },
};
