import type { LinuxCommand, LinuxCommandOption } from '../LinuxCommand';
import { cmdChgrp } from '../../LinuxPermCommands';
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
  run: (ctx, args) => {
    const out = cmdChgrp(ctx.executor.ctx(), args);
    return out;
  },
  runWithStatus: (ctx, args) => {
    const out = cmdChgrp(ctx.executor.ctx(), args);
    return Promise.resolve({ output: out, exitCode: out.startsWith('chgrp:') ? 1 : 0 });
  },
};
