import { shortOptions, type LongOption } from '../Getopt';
import { quoteLocale } from '../../coreutils/CoreutilsKit';
import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';

const LONG_OPTIONS: readonly LongOption[] = [
  { name: 'all', letter: 'a', takesArgument: false },
  { name: 'ignore', letter: 'i', takesArgument: true },
];

const MAXIMUM_IGNORE = 18446744073709551615n;

type Outcome = { readonly output: string; readonly exitCode: number; readonly stderr?: string; readonly interleaved?: string };

function nprocOutcome(ctx: LinuxCommandContext, args: string[]): Outcome {
  let ignore = 0n;
  for (const item of shortOptions(args, '', LONG_OPTIONS)) {
    if (item.kind !== 'option' || item.long !== 'ignore') continue;
    const text = item.argument ?? '';
    if (!/^\d+$/.test(text)) {
      const line = `nproc: invalid number: ${quoteLocale(text)}\n`;
      return { output: '', stderr: line, interleaved: line, exitCode: 1 };
    }
    ignore = BigInt(text);
    if (ignore > MAXIMUM_IGNORE) {
      const line = `nproc: invalid number: ${quoteLocale(text)}: Value too large for defined data type\n`;
      return { output: '', stderr: line, interleaved: line, exitCode: 1 };
    }
  }
  const cpus = BigInt(ctx.executor.hardware.cpu.logicalCpus);
  return { output: String(ignore >= cpus ? 1n : cpus - ignore), exitCode: 0 };
}

export const nprocCommand: LinuxCommand = {
  name: 'nproc',
  needsNetworkContext: true,
  usage: 'nproc',
  run(ctx: LinuxCommandContext, args: string[]): string {
    return nprocOutcome(ctx, args).output;
  },
  runWithStatus(ctx: LinuxCommandContext, args: string[]): Promise<Outcome> {
    return Promise.resolve(nprocOutcome(ctx, args));
  },
  runWithStatusSync(ctx: LinuxCommandContext, args: string[]): Outcome {
    return nprocOutcome(ctx, args);
  },
};
