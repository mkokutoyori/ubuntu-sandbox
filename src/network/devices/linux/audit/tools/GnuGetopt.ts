export interface LongOption {
  name: string;
  hasArg: 0 | 1 | 2;
  val: number;
}

export interface GetoptResult {
  code: number;
  optarg: string | null;
  longIndex: number;
}

export const END_OF_OPTIONS = -1;

export interface GetoptDiagnostics {
  program: string;
  write(text: string): void;
}

const NONE = 0;
const REQUIRED = 1;
const OPTIONAL = 2;

export class GnuGetopt {
  optind = 0;
  optopt = 0;
  private nextchar: string | null = null;
  private firstNonopt = 1;
  private lastNonopt = 1;
  private initialized = false;
  private readonly permute: boolean;
  private readonly returnInOrder: boolean;
  private readonly shortOptions: string;

  constructor(
    readonly argv: string[],
    optstring: string,
    private readonly longOptions: readonly LongOption[],
    private readonly diagnostics: GetoptDiagnostics | null = null,
  ) {
    this.permute = !(optstring.startsWith('+') || optstring.startsWith('-'));
    this.returnInOrder = optstring.startsWith('-');
    this.shortOptions = optstring.replace(/^[+-]/, '');
  }

  private isNonOption(index: number): boolean {
    const arg = this.argv[index];
    return arg[0] !== '-' || arg.length === 1;
  }

  private exchange(): void {
    const bottom = this.firstNonopt;
    const middle = this.lastNonopt;
    const top = this.optind;
    const first = this.argv.slice(bottom, middle);
    const second = this.argv.slice(middle, top);
    this.argv.splice(bottom, top - bottom, ...second, ...first);
    this.firstNonopt += this.optind - this.lastNonopt;
    this.lastNonopt = this.optind;
  }

  private initialize(): void {
    this.firstNonopt = this.lastNonopt = this.optind = 1;
    this.nextchar = null;
    this.initialized = true;
  }

  next(): GetoptResult {
    let optarg: string | null = null;
    if (this.optind === 0 || !this.initialized) this.initialize();
    const argc = this.argv.length;
    if (this.nextchar === null || this.nextchar === '') {
      if (this.lastNonopt > this.optind) this.lastNonopt = this.optind;
      if (this.firstNonopt > this.optind) this.firstNonopt = this.optind;
      if (this.permute) {
        if (this.firstNonopt !== this.lastNonopt && this.lastNonopt !== this.optind) this.exchange();
        else if (this.lastNonopt !== this.optind) this.firstNonopt = this.optind;
        while (this.optind < argc && this.isNonOption(this.optind)) this.optind++;
        this.lastNonopt = this.optind;
      }
      if (this.optind !== argc && this.argv[this.optind] === '--') {
        this.optind++;
        if (this.firstNonopt !== this.lastNonopt && this.lastNonopt !== this.optind) this.exchange();
        else if (this.firstNonopt === this.lastNonopt) this.firstNonopt = this.optind;
        this.lastNonopt = argc;
        this.optind = argc;
      }
      if (this.optind === argc) {
        if (this.firstNonopt !== this.lastNonopt) this.optind = this.firstNonopt;
        return { code: END_OF_OPTIONS, optarg: null, longIndex: 0 };
      }
      if (this.isNonOption(this.optind)) {
        if (this.returnInOrder) {
          optarg = this.argv[this.optind++];
          return { code: 1, optarg, longIndex: 0 };
        }
        return { code: END_OF_OPTIONS, optarg: null, longIndex: 0 };
      }
      this.nextchar = this.argv[this.optind].slice(this.argv[this.optind][1] === '-' ? 2 : 1);
    }
    if (this.argv[this.optind][1] === '-') return this.processLong();
    return this.processShort();
  }

  private processLong(): GetoptResult {
    const text = this.nextchar!;
    const eq = text.indexOf('=');
    const name = eq >= 0 ? text.slice(0, eq) : text;
    let match = -1;
    let ambiguous = false;
    const ambiguousSet: number[] = [];
    for (let i = 0; i < this.longOptions.length; i++) {
      const option = this.longOptions[i];
      if (option.name.startsWith(name)) {
        if (option.name.length === name.length) {
          match = i;
          ambiguous = false;
          break;
        }
        if (match === -1) match = i;
        else if (this.longOptions[match].hasArg !== option.hasArg || this.longOptions[match].val !== option.val) {
          ambiguous = true;
          if (ambiguousSet.length === 0) ambiguousSet.push(match);
          ambiguousSet.push(i);
        }
      }
    }
    this.nextchar = null;
    if (ambiguous) {
      if (this.diagnostics) {
        const names = ambiguousSet.map((index) => ` '--${this.longOptions[index].name}'`).join('');
        this.diagnostics.write(`${this.diagnostics.program}: option '--${text}' is ambiguous; possibilities:${names}\n`);
      }
      this.optind++;
      this.optopt = 0;
      return { code: 63, optarg: null, longIndex: 0 };
    }
    if (match < 0) {
      this.diagnostics?.write(`${this.diagnostics.program}: unrecognized option '--${text}'\n`);
      this.optind++;
      this.optopt = 0;
      return { code: 63, optarg: null, longIndex: 0 };
    }
    const option = this.longOptions[match];
    this.optind++;
    let optarg: string | null = null;
    if (eq >= 0) {
      if (option.hasArg !== NONE) optarg = text.slice(eq + 1);
      else {
        this.diagnostics?.write(`${this.diagnostics.program}: option '--${option.name}' doesn't allow an argument\n`);
        this.optopt = option.val;
        return { code: 63, optarg: null, longIndex: match };
      }
    } else if (option.hasArg === REQUIRED) {
      if (this.optind < this.argv.length) optarg = this.argv[this.optind++];
      else {
        this.diagnostics?.write(`${this.diagnostics.program}: option '--${option.name}' requires an argument\n`);
        this.optopt = option.val;
        return { code: 63, optarg: null, longIndex: match };
      }
    }
    void OPTIONAL;
    return { code: option.val, optarg, longIndex: match };
  }

  private processShort(): GetoptResult {
    const text = this.nextchar!;
    const c = text[0];
    this.nextchar = text.slice(1);
    const last = this.nextchar === '';
    const at = this.shortOptions.indexOf(c);
    if (last) this.optind++;
    if (at < 0 || c === ':' || c === ';') {
      this.diagnostics?.write(`${this.diagnostics.program}: invalid option -- '${c}'\n`);
      this.optopt = c.charCodeAt(0);
      return { code: 63, optarg: null, longIndex: 0 };
    }
    if (this.shortOptions[at + 1] === ':') {
      if (this.shortOptions[at + 2] === ':') {
        let optarg: string | null = null;
        if (!last) {
          optarg = this.nextchar;
          this.optind++;
        }
        this.nextchar = null;
        return { code: c.charCodeAt(0), optarg, longIndex: 0 };
      }
      if (!last) {
        const optarg = this.nextchar;
        this.optind++;
        this.nextchar = null;
        return { code: c.charCodeAt(0), optarg, longIndex: 0 };
      }
      if (this.optind === this.argv.length) {
        this.diagnostics?.write(`${this.diagnostics.program}: option requires an argument -- '${c}'\n`);
        this.optopt = c.charCodeAt(0);
        this.nextchar = null;
        return { code: 63, optarg: null, longIndex: 0 };
      }
      const optarg = this.argv[this.optind++];
      this.nextchar = null;
      return { code: c.charCodeAt(0), optarg, longIndex: 0 };
    }
    return { code: c.charCodeAt(0), optarg: null, longIndex: 0 };
  }
}
