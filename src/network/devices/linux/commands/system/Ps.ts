import type { LinuxCommand } from '../LinuxCommand';
import { PsProcHost, type PsHostSource } from './ps/PsProcHost';
import { runPs, type PsOutcome } from './ps/PsRun';

function runWithHost(source: PsHostSource, args: readonly string[]): PsOutcome {
  const host = new PsProcHost(source, args);
  try {
    return runPs(host, args);
  } finally {
    host.release();
  }
}

function withoutFinalNewline(text: string): string {
  return text.replace(/\n$/, '');
}

export function runPsCommand(source: PsHostSource, args: readonly string[]): { output: string; exitCode: number; stderr?: string; interleaved?: string } {
  const outcome = runWithHost(source, args);
  const output = withoutFinalNewline(outcome.stdout);
  if (outcome.stderr === '') return { output, exitCode: outcome.exitCode };
  return { output, stderr: withoutFinalNewline(outcome.stderr), interleaved: withoutFinalNewline(outcome.interleaved), exitCode: outcome.exitCode };
}

export const psCommand: LinuxCommand = {
  name: 'ps',
  package: 'procps',
  needsNetworkContext: false,
  manSection: 1,
  usage: 'ps [options]',
  help: 'Report a snapshot of the current processes.',
  ownsHelpOption: true,
  options: [
    { flag: '-e', description: 'Select all processes.', aliases: ['-A'] },
    { flag: '-a', description: 'Select all processes except session leaders and processes not associated with a terminal.' },
    { flag: '-f', description: 'Do full-format listing.' },
    { flag: '-l', description: 'Long format.' },
    { flag: '-o format', description: 'User-defined format.', takesArg: true, argName: 'format' },
    { flag: '-p pidlist', description: 'Select by process ID.', takesArg: true, argName: 'pidlist' },
    { flag: '-C cmdlist', description: 'Select by command name.', takesArg: true, argName: 'cmdlist' },
    { flag: '-u userlist', description: 'Select by effective user ID.', takesArg: true, argName: 'userlist' },
    { flag: '--forest', description: 'ASCII art process hierarchy.' },
    { flag: '--sort spec', description: 'Specify sorting order.', takesArg: true, argName: 'spec' },
    { flag: '-V', description: 'Print the procps-ng version.' },
  ],
  runWithStatusSync: (ctx, args) => runPsCommand(ctx, args),
  run: (ctx, args) => withoutFinalNewline(runWithHost(ctx, args).interleaved),
};
