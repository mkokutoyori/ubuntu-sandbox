import { getoptDiagnostic, shortOptions, type LongOption } from './commands/Getopt';

export interface GnuOptionSet {
  readonly optstring: string;
  readonly long: readonly LongOption[];
  readonly operands: boolean;
}

const flag = (name: string, letter = ''): LongOption => ({ name, letter, takesArgument: false });
const valued = (name: string, letter = ''): LongOption => ({ name, letter, takesArgument: true });
const HELP_VERSION: readonly LongOption[] = [flag('help'), flag('version')];

export const GNU_OPTION_SETS: Readonly<Record<string, GnuOptionSet>> = {
  whoami: { optstring: '', long: HELP_VERSION, operands: false },
  groups: { optstring: '', long: HELP_VERSION, operands: true },
  tty: { optstring: 's', long: [flag('silent', 's'), flag('quiet', 's'), ...HELP_VERSION], operands: false },
  nproc: { optstring: '', long: [flag('all'), valued('ignore'), ...HELP_VERSION], operands: false },
};

export interface OptionRefusal {
  readonly output: string;
  readonly exitCode: number;
}

export function refuseUnknownGnuOption(command: string, args: readonly string[]): OptionRefusal | null {
  const set = GNU_OPTION_SETS[command];
  if (!set) return null;
  const trailer = `Try '${command} --help' for more information.`;
  for (const item of shortOptions(args, set.optstring, set.long)) {
    if (item.kind === 'operand' && !set.operands) {
      return { output: `${command}: extra operand '${item.value}'\n${trailer}`, exitCode: 1 };
    }
    if (item.kind === 'invalid' || item.kind === 'unrecognized'
      || item.kind === 'missing-argument' || item.kind === 'needless-argument') {
      return { output: `${getoptDiagnostic(command, item)}\n${trailer}`, exitCode: 1 };
    }
  }
  return null;
}
