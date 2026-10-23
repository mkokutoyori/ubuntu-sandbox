export type CommandLineOutcome =
  | { readonly kind: 'help' }
  | { readonly kind: 'version' }
  | { readonly kind: 'fatal'; readonly message: string }
  | {
    readonly kind: 'parsed';
    readonly verbose: boolean;
    readonly recoverable: boolean;
    readonly fileName: string | null;
    readonly noArguments: boolean;
    readonly settings: readonly (string | null)[];
  };

type OptionCode = 'a' | 'g' | 'F' | 'debug' | 'help' | 'version' | 'other' | 'end';

interface OptionResult {
  readonly code: OptionCode;
  readonly argument: string;
}

interface LongOption {
  readonly name: string;
  readonly code: OptionCode;
  readonly takesArgument: boolean;
}

const LONG_OPTIONS: readonly LongOption[] = [
  { name: 'all', code: 'a', takesArgument: false },
  { name: 'save', code: 'g', takesArgument: false },
  { name: 'file', code: 'F', takesArgument: true },
  { name: '-debug', code: 'debug', takesArgument: false },
  { name: 'help', code: 'help', takesArgument: false },
  { name: 'version', code: 'version', takesArgument: false },
];

const NO_ARGUMENT_WORDS = new Set(['-drain', 'drain']);

class OptionScanner {
  optind = 1;
  private nextChar = 0;

  constructor(private readonly argv: readonly (string | null)[], private readonly base: number) {}

  private element(index: number): string | undefined {
    return this.argv[this.base + index] ?? undefined;
  }

  next(): OptionResult {
    if (this.nextChar > 0) return this.nextShort(this.element(this.optind) as string);
    const word = this.element(this.optind);
    if (word === undefined) return { code: 'end', argument: '' };
    if (word === '--') {
      this.optind++;
      return { code: 'end', argument: '' };
    }
    if (!word.startsWith('-') || word === '-') {
      this.optind++;
      return { code: 'other', argument: word };
    }
    if (word.startsWith('--')) return this.nextLong(word);
    this.nextChar = 1;
    return this.nextShort(word);
  }

  private nextLong(word: string): OptionResult {
    const equals = word.indexOf('=');
    const name = word.slice(2, equals < 0 ? undefined : equals);
    const exact = LONG_OPTIONS.find((option) => option.name === name);
    const candidates = exact ? [exact] : LONG_OPTIONS.filter((option) => option.name.startsWith(name));
    this.optind++;
    if (candidates.length !== 1) return { code: 'other', argument: word };
    const option = candidates[0];
    if (equals >= 0) {
      if (!option.takesArgument) return { code: 'other', argument: word };
      return { code: option.code, argument: word.slice(equals + 1) };
    }
    if (!option.takesArgument) return { code: option.code, argument: '' };
    const value = this.element(this.optind);
    if (value === undefined) return { code: 'other', argument: word };
    this.optind++;
    return { code: option.code, argument: value };
  }

  private nextShort(word: string): OptionResult {
    const letter = word[this.nextChar++];
    const last = this.nextChar >= word.length;
    if (letter === 'a' || letter === 'g') {
      if (last) this.finishElement();
      return { code: letter, argument: '' };
    }
    if (letter === 'F') {
      if (!last) {
        const rest = word.slice(this.nextChar);
        this.finishElement();
        return { code: 'F', argument: rest };
      }
      this.finishElement();
      const value = this.element(this.optind);
      if (value === undefined) return { code: 'other', argument: word };
      this.optind++;
      return { code: 'F', argument: value };
    }
    if (last) this.finishElement();
    return { code: 'other', argument: word };
  }

  private finishElement(): void {
    this.optind++;
    this.nextChar = 0;
  }
}

export function parseCommandLine(args: readonly string[]): CommandLineOutcome {
  const argv: (string | null)[] = ['stty', ...args];
  let argi = 0;
  let opti = 1;
  let verbose = false;
  let recoverable = false;
  let noArguments = true;
  let fileName: string | null = null;
  let scanner = new OptionScanner(argv, argi);
  for (;;) {
    const result = scanner.next();
    if (result.code === 'end') break;
    if (result.code === 'a') verbose = true;
    else if (result.code === 'g') recoverable = true;
    else if (result.code === 'F') {
      if (fileName !== null) return { kind: 'fatal', message: 'only one device may be specified' };
      fileName = result.argument;
    } else if (result.code === 'help') return { kind: 'help' };
    else if (result.code === 'version') return { kind: 'version' };
    else if (result.code === 'other') {
      if (!NO_ARGUMENT_WORDS.has(argv[argi + opti] as string)) noArguments = false;
      argi += opti;
      opti = 1;
      scanner = new OptionScanner(argv, argi);
      continue;
    }
    while (opti < scanner.optind) argv[argi + opti++] = null;
  }
  return { kind: 'parsed', verbose, recoverable, fileName, noArguments, settings: argv };
}
