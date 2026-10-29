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
  free: {
    optstring: 'bkmghHlLtvVwc:s:',
    long: [
      flag('bytes', 'b'), flag('kilo'), flag('mega'), flag('giga'), flag('tera'), flag('peta'),
      flag('kibi', 'k'), flag('mebi', 'm'), flag('gibi', 'g'), flag('tebi'), flag('pebi'),
      flag('human', 'h'), flag('si'), flag('lohi', 'l'), flag('total', 't'), flag('wide', 'w'),
      valued('seconds', 's'), valued('count', 'c'), flag('help'), flag('version', 'V'),
    ],
    operands: false,
  },
  env: {
    optstring: '+i0u:C:S:vh',
    long: [
      flag('ignore-environment', 'i'), flag('null', '0'), valued('unset', 'u'), valued('chdir', 'C'),
      valued('split-string', 'S'), flag('debug', 'v'), ...HELP_VERSION,
    ],
    operands: true,
  },
  mkdir: {
    optstring: 'm:pvZ',
    long: [valued('mode', 'm'), flag('parents', 'p'), flag('verbose', 'v'), valued('context'), ...HELP_VERSION],
    operands: true,
  },
  rmdir: {
    optstring: 'pv',
    long: [flag('ignore-fail-on-non-empty'), flag('parents', 'p'), flag('verbose', 'v'), ...HELP_VERSION],
    operands: true,
  },
  rm: {
    optstring: 'fiIrRdv',
    long: [
      flag('force', 'f'), flag('interactive'), flag('one-file-system'), flag('no-preserve-root'),
      flag('preserve-root'), flag('recursive', 'r'), flag('dir', 'd'), flag('verbose', 'v'), ...HELP_VERSION,
    ],
    operands: true,
  },
  cat: {
    optstring: 'AbeEnstTuv',
    long: [
      flag('show-all', 'A'), flag('number-nonblank', 'b'), flag('show-ends', 'E'), flag('number', 'n'),
      flag('squeeze-blank', 's'), flag('show-tabs', 'T'), flag('show-nonprinting', 'v'), ...HELP_VERSION,
    ],
    operands: true,
  },
  wc: {
    optstring: 'cmlLw',
    long: [
      flag('bytes', 'c'), flag('chars', 'm'), flag('lines', 'l'), valued('files0-from'),
      flag('max-line-length', 'L'), flag('words', 'w'), valued('total'), ...HELP_VERSION,
    ],
    operands: true,
  },
  tac: {
    optstring: 'brs:',
    long: [flag('before', 'b'), flag('regex', 'r'), valued('separator', 's'), ...HELP_VERSION],
    operands: true,
  },
  tee: {
    optstring: 'aip',
    long: [flag('append', 'a'), flag('ignore-interrupts', 'i'), valued('output-error'), ...HELP_VERSION],
    operands: true,
  },
  basename: {
    optstring: 'as:z',
    long: [flag('multiple', 'a'), valued('suffix', 's'), flag('zero', 'z'), ...HELP_VERSION],
    operands: true,
  },
  dirname: { optstring: 'z', long: [flag('zero', 'z'), ...HELP_VERSION], operands: true },
  printenv: { optstring: '0', long: [flag('null', '0'), ...HELP_VERSION], operands: true },
  uname: {
    optstring: 'asnrvmpio',
    long: [
      flag('all', 'a'), flag('kernel-name', 's'), flag('nodename', 'n'), flag('kernel-release', 'r'),
      flag('kernel-version', 'v'), flag('machine', 'm'), flag('processor', 'p'),
      flag('hardware-platform', 'i'), flag('operating-system', 'o'), ...HELP_VERSION,
    ],
    operands: false,
  },
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
