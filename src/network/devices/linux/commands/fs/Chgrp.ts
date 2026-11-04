import type { LinuxCommand, LinuxCommandOption } from '../LinuxCommand';
import { runChgrp } from '../../coreutils/ChownCommands';
import { Satisfy, Deny } from '../../iam/policy/CommandPrivilegePolicy';

const CHGRP_OPTIONS: readonly LinuxCommandOption[] = [
  { flag: '-R', aliases: ['--recursive'], dest: 'recursive', description: 'Operate on files and directories recursively' },
  { flag: '-v', aliases: ['--verbose'], dest: 'verbose', description: 'Output a diagnostic for every file processed' },
  { flag: '-c', aliases: ['--changes'], dest: 'changes', description: 'Like verbose, but report only when a change is made' },
  { flag: '-f', aliases: ['--silent', '--quiet'], dest: 'silent', description: 'Suppress most error messages' },
  { flag: '--reference', dest: 'reference', takesArg: true, argName: 'RFILE', description: "Use RFILE's group instead of specifying a value" },
  { flag: '-h', aliases: ['--no-dereference'], dest: 'noDereference', description: "Affect a symbolic link's own group, not the file it points to" },
];

export const chgrpCommand: LinuxCommand = {
  name: 'chgrp',
  needsNetworkContext: false,
  usage: 'chgrp GROUP FILE...',
  options: CHGRP_OPTIONS,
  privilege: { satisfiedBy: Satisfy.rootOrGroup('sudo', 'wheel'), deny: Deny.operationNotPermitted },
  run: (ctx, args) => runChgrp(ctx.executor.ctx(), args).stdout,
  runWithStatus: (ctx, args) => {
    const result = runChgrp(ctx.executor.ctx(), args);
    return Promise.resolve({ output: result.stdout, exitCode: result.exitCode, stderr: result.stderr, interleaved: result.interleaved });
  },
};
