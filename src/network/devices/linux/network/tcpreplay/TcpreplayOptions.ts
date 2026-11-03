import { TCPREPLAY_EXTENDED_USAGE_LINES, TCPREPLAY_USAGE_LINES, TCPREPLAY_VERSION_LINES } from './TcpreplayHelp';
import { TCPREPLAY_PROGRAM, TCPREPLAY_PROGRAM_PATH } from './TcpreplayDiagnostics';

type ArgumentKind = 'none' | 'number' | 'string' | 'optional';
type OptionAction = 'pid' | 'version' | 'less-help' | 'help' | 'more-help' | 'listnics' | 'save-opts' | 'load-opts';

interface NumericRange {
  readonly min: number;
  readonly max: number | null;
}

interface OptionSpec {
  readonly name: string;
  readonly flag: string | null;
  readonly argument: ArgumentKind;
  readonly immediate?: boolean;
  readonly mustSet?: boolean;
  readonly must?: readonly string[];
  readonly cant?: readonly string[];
  readonly range?: NumericRange;
  readonly action?: OptionAction;
}

const OPTIONS: readonly OptionSpec[] = [
  { name: 'dbug', flag: 'd', argument: 'number', immediate: true, range: { min: 0, max: 5 } },
  { name: 'quiet', flag: 'q', argument: 'none' },
  { name: 'timer', flag: 'T', argument: 'string' },
  { name: 'maxsleep', flag: null, argument: 'number' },
  { name: 'verbose', flag: 'v', argument: 'none', immediate: true },
  { name: 'decode', flag: 'A', argument: 'string', must: ['verbose'] },
  { name: 'preload-pcap', flag: 'K', argument: 'none' },
  { name: 'cachefile', flag: 'c', argument: 'string', cant: ['dualfile'], must: ['intf2'] },
  { name: 'dualfile', flag: '2', argument: 'none', cant: ['cachefile'], must: ['intf2'] },
  { name: 'intf1', flag: 'i', argument: 'string', mustSet: true },
  { name: 'intf2', flag: 'I', argument: 'string' },
  { name: 'listnics', flag: null, argument: 'none', immediate: true, action: 'listnics' },
  { name: 'loop', flag: 'l', argument: 'number', range: { min: 0, max: null } },
  { name: 'loopdelay-ms', flag: null, argument: 'number', must: ['loop'], range: { min: 0, max: null } },
  { name: 'pktlen', flag: null, argument: 'none' },
  { name: 'limit', flag: 'L', argument: 'number', range: { min: 1, max: null } },
  { name: 'duration', flag: null, argument: 'number', range: { min: 1, max: null } },
  { name: 'multiplier', flag: 'x', argument: 'string', cant: ['pps', 'mbps', 'oneatatime', 'topspeed'] },
  { name: 'pps', flag: 'p', argument: 'string', cant: ['multiplier', 'mbps', 'oneatatime', 'topspeed'] },
  { name: 'mbps', flag: 'M', argument: 'string', cant: ['multiplier', 'pps', 'oneatatime', 'topspeed'] },
  { name: 'topspeed', flag: 't', argument: 'none', cant: ['mbps', 'multiplier', 'pps', 'oneatatime'] },
  { name: 'oneatatime', flag: 'o', argument: 'none', cant: ['mbps', 'pps', 'multiplier', 'topspeed'] },
  { name: 'pps-multi', flag: null, argument: 'number', must: ['pps'], range: { min: 1, max: null } },
  { name: 'unique-ip', flag: null, argument: 'none', must: ['loop'] },
  { name: 'unique-ip-loops', flag: null, argument: 'string', must: ['unique-ip'] },
  { name: 'no-flow-stats', flag: null, argument: 'none' },
  { name: 'flow-expiry', flag: null, argument: 'number', cant: ['no-flow-stats'], range: { min: 0, max: null } },
  { name: 'pid', flag: 'P', argument: 'none', action: 'pid' },
  { name: 'stats', flag: null, argument: 'number', range: { min: 0, max: null } },
  { name: 'version', flag: 'V', argument: 'none', action: 'version' },
  { name: 'less-help', flag: 'h', argument: 'none', immediate: true, action: 'less-help' },
  { name: 'help', flag: 'H', argument: 'none', immediate: true, action: 'help' },
  { name: 'more-help', flag: '!', argument: 'none', immediate: true, action: 'more-help' },
  { name: 'save-opts', flag: null, argument: 'optional', action: 'save-opts' },
  { name: 'load-opts', flag: null, argument: 'string', action: 'load-opts' },
];

const HOME_CONFIGURATION = '/usr/bin/.tcpreplayrc';
const SAVE_COLUMN = 20;

export interface OptionState {
  selected: boolean;
  preset: boolean;
  occurrences: number;
  argument: string | null;
  value: number | null;
}

export type ParsedOptions = ReadonlyMap<string, Readonly<OptionState>>;

export interface ParseHost {
  processId(): number;
  emit(fd: 1 | 2, text: string): void;
  readConfiguration(path: string): { text: string } | { error: string };
  writeConfiguration(path: string, content: string): void;
  saveHeaderDate(): string;
}

export type ParseOutcome =
  | { readonly kind: 'exit'; readonly exitCode: number }
  | { readonly kind: 'list-interfaces' }
  | { readonly kind: 'run'; readonly options: ParsedOptions; readonly operands: readonly string[] };

class UsageExit extends Error {
  constructor(readonly exitCode: number) {
    super('usage');
  }
}

class Finished extends Error {
  constructor(readonly outcome: ParseOutcome) {
    super('finished');
  }
}

function usageText(lines: readonly string[]): string {
  return lines.join('\n') + '\n';
}

function equivalent(character: string): string {
  const lower = character.toLowerCase();
  return lower === '_' || lower === '^' ? '-' : lower;
}

function prefixMatches(typed: string, name: string): boolean {
  if (typed.length > name.length) return false;
  for (let i = 0; i < typed.length; i++) if (equivalent(typed[i]) !== equivalent(name[i])) return false;
  return true;
}

export function parseNumber(text: string): number | null {
  const match = /^[ \t\n\v\f\r]*([+-]?)(0[xX](?=[0-9a-fA-F])[0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)/.exec(text);
  if (match === null) return null;
  if (match[0].length !== text.length) return null;
  const digits = match[2];
  let magnitude: bigint;
  if (/^0[xX]/.test(digits)) magnitude = BigInt(digits);
  else if (digits.length > 1 && digits.startsWith('0')) magnitude = BigInt('0o' + digits.slice(1));
  else magnitude = BigInt(digits);
  const signed = match[1] === '-' ? -magnitude : magnitude;
  if (signed > 0x7fffffffffffffffn || signed < -0x8000000000000000n) return null;
  return Number(signed);
}

function rangeText(range: NumericRange): string {
  return range.max === null ? `greater than or equal to ${range.min}` : `${range.min} to ${range.max}`;
}

class Parser {
  readonly states = new Map<string, OptionState>(OPTIONS.map((spec) => [spec.name, { selected: false, preset: false, occurrences: 0, argument: null, value: null }]));
  private index = 1;
  private cluster: string | null = null;

  constructor(private readonly argv: readonly string[], private readonly host: ParseHost) {}

  run(): ParseOutcome {
    try {
      this.pass('immediate');
      this.index = 1;
      this.cluster = null;
      this.loadHomeConfiguration();
      this.pass('regular');
      this.saveWhenAsked();
      this.checkConsistency();
      return { kind: 'run', options: this.states, operands: this.argv.slice(this.index) };
    } catch (stop) {
      if (stop instanceof Finished) return stop.outcome;
      if (stop instanceof UsageExit) return { kind: 'exit', exitCode: stop.exitCode };
      throw stop;
    }
  }

  private fail(message: string): never {
    this.host.emit(2, `${message}\n`);
    this.host.emit(2, usageText(TCPREPLAY_USAGE_LINES));
    throw new UsageExit(1);
  }

  private pass(kind: 'immediate' | 'regular'): void {
    for (;;) {
      const found = this.nextOption();
      if (found === null) return;
      const immediate = found.spec.immediate === true;
      if (kind === 'immediate' && !immediate) continue;
      if (kind === 'regular' && immediate) continue;
      this.handle(found.spec, found.argument, kind === 'regular');
    }
  }

  private nextOption(): { spec: OptionSpec; argument: string | null } | null {
    if (this.cluster === null || this.cluster === '') {
      if (this.index >= this.argv.length) return null;
      const token = this.argv[this.index];
      if (token[0] !== '-' || token.length === 1) return null;
      this.index++;
      if (token[1] === '-') {
        if (token.length === 2) return null;
        return this.completeLong(token.slice(2));
      }
      this.cluster = token.slice(1);
    }
    return this.completeShort();
  }

  private completeLong(text: string): { spec: OptionSpec; argument: string | null } {
    const equals = text.indexOf('=');
    const name = equals < 0 ? text : text.slice(0, equals);
    let argument: string | null = equals < 0 ? null : text.slice(equals + 1);
    if (name.length <= 1) this.fail(`${TCPREPLAY_PROGRAM}: invalid option name: ${text}`);
    const matches = OPTIONS.filter((spec) => prefixMatches(name, spec.name));
    const exact = matches.find((spec) => spec.name.length === name.length);
    if (exact === undefined && matches.length === 0) this.fail(`${TCPREPLAY_PROGRAM_PATH}: illegal option -- ${name}`);
    if (exact === undefined && matches.length > 1) {
      let message = `${TCPREPLAY_PROGRAM_PATH}: ambiguous option name: ${name} (matches ${matches.length} options)`;
      if (matches.length <= 4) message += '\n  The following options match:\n' + matches.map((spec) => `  --${spec.name}`).join('\n');
      this.fail(message);
    }
    const spec = exact ?? matches[0];
    argument = this.longArgument(spec, argument);
    return { spec, argument };
  }

  private longArgument(spec: OptionSpec, glued: string | null): string | null {
    if (spec.argument === 'none') {
      if (glued !== null) this.fail(`${TCPREPLAY_PROGRAM_PATH}: The '${spec.name}' option cannot have an argument.`);
      this.cluster = null;
      return null;
    }
    this.cluster = null;
    if (spec.argument === 'optional') {
      if (glued !== null) return glued;
      const lookahead = this.argv[this.index];
      if (lookahead === undefined || lookahead[0] === '-') return null;
      this.index++;
      return lookahead;
    }
    if (glued !== null) return glued;
    const next = this.argv[this.index++];
    if (next === undefined) this.fail(`${TCPREPLAY_PROGRAM_PATH}: The '${spec.name}' option requires an argument.`);
    return next;
  }

  private completeShort(): { spec: OptionSpec; argument: string | null } {
    const flag = this.cluster![0];
    const spec = OPTIONS.find((candidate) => candidate.flag === flag);
    if (spec === undefined) this.fail(`${TCPREPLAY_PROGRAM_PATH}: illegal option -- ${flag}`);
    const rest = this.cluster!.slice(1);
    if (spec.argument === 'none') {
      this.cluster = rest;
      return { spec, argument: null };
    }
    this.cluster = null;
    if (spec.argument === 'optional') {
      if (rest !== '') return { spec, argument: rest };
      const lookahead = this.argv[this.index];
      if (lookahead === undefined || lookahead[0] === '-') return { spec, argument: null };
      this.index++;
      return { spec, argument: lookahead };
    }
    if (rest !== '') return { spec, argument: rest };
    const next = this.argv[this.index++];
    if (next === undefined) this.fail(`${TCPREPLAY_PROGRAM_PATH}: The '${spec.name}' option requires an argument.`);
    return { spec, argument: next };
  }

  private handle(spec: OptionSpec, argument: string | null, counted: boolean): void {
    const state = this.states.get(spec.name)!;
    if (counted && ++state.occurrences > 1) this.fail(`${TCPREPLAY_PROGRAM} error:  only one ${spec.name} option allowed`);
    state.selected = true;
    state.argument = argument;
    if (spec.argument === 'number') this.convertNumber(spec, state);
    if (spec.action !== undefined) this.perform(spec.action, argument);
  }

  private convertNumber(spec: OptionSpec, state: OptionState, loading = false): void {
    let value = parseNumber(state.argument!);
    if (value === null) {
      const message = `${TCPREPLAY_PROGRAM} error:  '${state.argument}' is not a recognizable number.`;
      if (!loading) this.fail(message);
      this.host.emit(2, `${message}\n`);
      value = -1;
    }
    state.value = value;
    const range = spec.range;
    if (range === undefined) return;
    if (value < range.min || (range.max !== null && value > range.max)) {
      this.fail(`${TCPREPLAY_PROGRAM} error:  ${spec.name} option value ${value} is out of range.\nit must be in the range:\n\t${rangeText(range)}`);
    }
  }

  private perform(action: OptionAction, argument: string | null): void {
    switch (action) {
      case 'pid':
        this.host.emit(2, `PID: ${this.host.processId()}\n`);
        return;
      case 'version':
        this.host.emit(2, usageText(TCPREPLAY_VERSION_LINES));
        throw new UsageExit(0);
      case 'less-help':
        this.host.emit(2, usageText(TCPREPLAY_USAGE_LINES));
        throw new UsageExit(1);
      case 'help':
      case 'more-help':
        this.host.emit(1, usageText(TCPREPLAY_EXTENDED_USAGE_LINES));
        throw new UsageExit(0);
      case 'listnics':
        throw new Finished({ kind: 'list-interfaces' });
      case 'save-opts':
        return;
      case 'load-opts':
        this.loadConfiguration(argument!, 'set');
        return;
    }
  }

  private loadHomeConfiguration(): void {
    const content = this.host.readConfiguration(HOME_CONFIGURATION);
    if ('text' in content) this.applyLines(content.text, 'preset');
  }

  private loadConfiguration(path: string, mode: 'set' | 'preset'): void {
    const content = this.host.readConfiguration(path);
    if ('error' in content) {
      this.host.emit(2, `${TCPREPLAY_PROGRAM} error 2 (${content.error}) calling stat for '${path}'\n`);
      throw new UsageExit(1);
    }
    this.applyLines(content.text, mode);
  }

  private applyLines(text: string, mode: 'set' | 'preset'): void {
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (line === '' || line.startsWith('#')) continue;
      const match = /^([^\s=:]+)\s*[=:]?\s*(.*)$/.exec(line);
      if (match === null) continue;
      const name = match[1];
      const matches = OPTIONS.filter((spec) => prefixMatches(name, spec.name));
      const spec = matches.find((candidate) => candidate.name.length === name.length) ?? (matches.length === 1 ? matches[0] : undefined);
      if (spec === undefined || spec.action === 'help' || spec.action === 'less-help' || spec.action === 'more-help'
        || spec.action === 'version' || spec.action === 'listnics' || spec.action === 'save-opts' || spec.action === 'load-opts') continue;
      let value: string | null = null;
      if (spec.argument !== 'none') {
        value = match[2].replace(/^(["'])(.*)\1$/, '$2');
      }
      const state = this.states.get(spec.name)!;
      if (mode === 'set') state.selected = true;
      else state.preset = true;
      state.argument = value;
      if (spec.argument === 'number') this.convertNumber(spec, state, true);
      if (spec.action === 'pid' && mode === 'set') this.host.emit(2, `PID: ${this.host.processId()}\n`);
    }
  }

  private saveWhenAsked(): void {
    const request = this.states.get('save-opts')!;
    if (!request.selected) return;
    let content = `#  ${TCPREPLAY_PROGRAM} (${TCPREPLAY_PROGRAM}) - Replay network traffic stored in pcap files\n#  preset/initialization file\n#  ${this.host.saveHeaderDate()}\n#\n`;
    for (const spec of OPTIONS) {
      const state = this.states.get(spec.name)!;
      if (!state.selected || spec.action === 'help' || spec.action === 'less-help' || spec.action === 'more-help' || spec.action === 'version'
        || spec.action === 'listnics' || spec.action === 'save-opts' || spec.action === 'load-opts') continue;
      content += spec.argument === 'none' ? `${spec.name}\n` : `${`${spec.name} =`.padEnd(SAVE_COLUMN)}${state.argument}\n`;
    }
    this.host.writeConfiguration(request.argument ?? HOME_CONFIGURATION, content);
    throw new UsageExit(0);
  }

  private isSet(name: string): boolean {
    const state = this.states.get(name)!;
    return state.selected || state.preset;
  }

  private checkConsistency(): void {
    for (const spec of OPTIONS) {
      const state = this.states.get(spec.name)!;
      if (state.selected) {
        for (const required of spec.must ?? []) {
          if (!this.isSet(required)) this.fail(`${TCPREPLAY_PROGRAM} error:  ${spec.name} option requires the ${required} option`);
        }
        for (const forbidden of spec.cant ?? []) {
          if (this.states.get(forbidden)!.selected) this.fail(`${TCPREPLAY_PROGRAM} error:  the '${spec.name}' and '${forbidden}' options conflict`);
        }
      }
      if (spec.mustSet === true && !state.selected && !state.preset) this.fail(`${TCPREPLAY_PROGRAM} error:  The ${spec.name} option is required`);
    }
    if (this.argv.length <= this.index) this.fail(`${TCPREPLAY_PROGRAM}: Command line arguments required`);
  }
}

export function parseTcpreplayArguments(argv: readonly string[], host: ParseHost): ParseOutcome {
  return new Parser([TCPREPLAY_PROGRAM, ...argv], host).run();
}

export function optionOf(options: ParsedOptions, name: string): Readonly<OptionState> {
  return options.get(name) ?? { selected: false, preset: false, occurrences: 0, argument: null, value: null };
}

export function isSet(options: ParsedOptions, name: string): boolean {
  const state = optionOf(options, name);
  return state.selected || state.preset;
}
