export const GETOPT_END = -1;

export interface GetoptResult {
  readonly option: string | null;
  readonly argument: string | null;
}

interface OptionSpec {
  readonly takesArgument: boolean;
}

function parseOptstring(optstring: string): Map<string, OptionSpec> {
  const specs = new Map<string, OptionSpec>();
  const text = optstring.startsWith(':') ? optstring.slice(1) : optstring;
  for (let i = 0; i < text.length; i++) {
    const letter = text[i];
    const takesArgument = text[i + 1] === ':';
    specs.set(letter, { takesArgument });
    if (takesArgument) i++;
  }
  return specs;
}

export class Getopt {
  private readonly specs: Map<string, OptionSpec>;
  private readonly nonOptions: string[] = [];
  private index = 1;
  private within: string | null = null;
  private withinPosition = 0;
  private finished = false;
  optionCharacter = '';

  constructor(
    private readonly argv: readonly string[],
    optstring: string,
    private readonly report: (message: string) => void,
  ) {
    this.specs = parseOptstring(optstring);
  }

  private programName(): string {
    return this.argv[0] ?? '';
  }

  next(): GetoptResult | typeof GETOPT_END {
    if (this.finished) return GETOPT_END;
    for (;;) {
      if (this.within === null) {
        if (this.index >= this.argv.length) return this.finish();
        const arg = this.argv[this.index];
        if (arg === '--') {
          this.index++;
          while (this.index < this.argv.length) this.nonOptions.push(this.argv[this.index++]);
          return this.finish();
        }
        if (arg.length < 2 || arg[0] !== '-') {
          this.nonOptions.push(arg);
          this.index++;
          continue;
        }
        this.within = arg;
        this.withinPosition = 1;
        this.index++;
      }
      const arg = this.within as string;
      const letter = arg[this.withinPosition++];
      const atEnd = this.withinPosition >= arg.length;
      const spec = this.specs.get(letter);
      if (spec === undefined || letter === ':') {
        this.optionCharacter = letter;
        this.report(`${this.programName()}: invalid option -- '${letter}'`);
        if (atEnd) this.within = null;
        return { option: '?', argument: null };
      }
      if (!spec.takesArgument) {
        if (atEnd) this.within = null;
        return { option: letter, argument: null };
      }
      if (!atEnd) {
        this.within = null;
        return { option: letter, argument: arg.slice(this.withinPosition) };
      }
      this.within = null;
      if (this.index >= this.argv.length) {
        this.optionCharacter = letter;
        this.report(`${this.programName()}: option requires an argument -- '${letter}'`);
        return { option: '?', argument: null };
      }
      const value = this.argv[this.index++];
      return { option: letter, argument: value };
    }
  }

  private finish(): typeof GETOPT_END {
    this.finished = true;
    return GETOPT_END;
  }

  operands(): string[] {
    return this.nonOptions;
  }
}
