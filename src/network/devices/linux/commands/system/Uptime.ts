import { getoptDiagnostic, shortOptions, type LongOption } from '../Getopt';
import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { cmdUptime } from '../../system/SystemInfo';

const LONG_OPTIONS: readonly LongOption[] = [
  { name: 'pretty', letter: 'p', takesArgument: false },
  { name: 'help', letter: 'h', takesArgument: false },
  { name: 'since', letter: 's', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
];

const USAGE = `
Usage:
 uptime [options]

Options:
 -p, --pretty   show uptime in pretty format
 -h, --help     display this help and exit
 -s, --since    system up since
 -V, --version  output version information and exit

For more details see uptime(1).
`;

const VERSION = 'uptime from procps-ng 3.3.17';

type Outcome = { readonly output: string; readonly exitCode: number; readonly stderr?: string; readonly interleaved?: string };

function uptimeOutcome(ctx: LinuxCommandContext, args: string[]): Outcome {
  let pretty = false;
  let since = false;
  let operands = 0;
  for (const item of shortOptions(args, 'psVh', LONG_OPTIONS)) {
    if (item.kind === 'operand') { operands++; continue; }
    if (item.kind !== 'option') {
      const text = `${getoptDiagnostic('uptime', item)}\n${USAGE}`;
      return { output: '', stderr: text, interleaved: text, exitCode: 1 };
    }
    if (item.letter === 'h') return { output: USAGE.replace(/\n$/, ''), exitCode: 0 };
    if (item.letter === 'V') return { output: VERSION, exitCode: 0 };
    if (item.letter === 's') since = true;
    else pretty = true;
  }
  if (operands > 0) return { output: '', stderr: USAGE, interleaved: USAGE, exitCode: 1 };
  const shown = cmdUptime(since ? ['-s'] : pretty ? ['-p'] : [], ctx.executor.lifecycle, { nowMs: ctx.executor.simulatedDate().getTime(), zone: ctx.executor.localZone() });
  return { output: shown, exitCode: 0 };
}

export const uptimeCommand: LinuxCommand = {
  name: 'uptime',
  needsNetworkContext: true,
  usage: 'uptime [options]',
  run(ctx: LinuxCommandContext, args: string[]): string {
    return uptimeOutcome(ctx, args).output;
  },
  runWithStatus(ctx: LinuxCommandContext, args: string[]): Promise<Outcome> {
    return Promise.resolve(uptimeOutcome(ctx, args));
  },
  runWithStatusSync(ctx: LinuxCommandContext, args: string[]): Outcome {
    return uptimeOutcome(ctx, args);
  },
};
