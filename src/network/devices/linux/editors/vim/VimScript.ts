import { ExpressionSession, isExpressionAbort, type ExpressionHost, type UserFunctions, type VimValue } from './VimExpression';

export interface ScriptHost {
  expressionHost(): ExpressionHost;
  runExLine(line: string): string | null;
}

interface UserFunction {
  readonly name: string;
  readonly parameters: readonly string[];
  readonly variadic: boolean;
  readonly abort: boolean;
  readonly range: boolean;
  readonly dict: boolean;
  readonly body: readonly string[];
  readonly listing: readonly string[];
}

type Outcome =
  | { readonly kind: 'next' }
  | { readonly kind: 'break' }
  | { readonly kind: 'continue' }
  | { readonly kind: 'return'; readonly value: VimValue };

const NEXT: Outcome = { kind: 'next' };
const MAX_FUNCTION_DEPTH = 100;
const SCRIPT_WORDS: ReadonlyArray<readonly [string, number]> = [
  ['function', 2], ['endfunction', 4], ['delfunction', 4], ['return', 4], ['if', 2], ['elseif', 5], ['else', 2], ['endif', 2],
  ['while', 2], ['endwhile', 4], ['for', 3], ['endfor', 5], ['break', 4], ['continue', 3], ['call', 3], ['echo', 2],
  ['echon', 5], ['echomsg', 5], ['echoerr', 5], ['execute', 3], ['let', 3], ['unlet', 3], ['const', 4], ['lockvar', 5], ['unlockvar', 4],
  ['try', 3], ['catch', 3], ['finally', 4], ['endtry', 4], ['throw', 2],
];
const BLOCK_OPENERS = new Set(['if', 'while', 'for', 'try']);
const BLOCK_CLOSERS = new Set(['endif', 'endwhile', 'endfor', 'endtry']);
const FUNCTION_HEADER = /^(function)(!?)\s*(.*)$/s;
const FUNCTION_NAME = /^(?:s:|g:)?[A-Z][\w#]*$|^s:[a-z_][\w#]*$/;

interface CommandWord {
  readonly word: string;
  readonly bang: boolean;
  readonly argument: string;
}

function commandWord(line: string): CommandWord {
  const matched = line.match(/^([A-Za-z]+)(!?)\s*(.*)$/s);
  if (matched === null) return { word: '', bang: false, argument: line };
  const typed = matched[1];
  for (const [full, shortest] of SCRIPT_WORDS) {
    if (typed.length >= shortest && full.startsWith(typed)) return { word: full, bang: matched[2] === '!', argument: matched[3] };
  }
  return { word: '', bang: false, argument: line };
}

export function isScriptCommand(line: string): boolean {
  return commandWord(line).word !== '';
}

function barOutside(text: string): number {
  let quote = '';
  let brace = 0;
  for (let at = 0; at < text.length; at++) {
    const character = text[at];
    if (quote !== '') {
      if (character === quote) {
        if (quote === "'" && text[at + 1] === "'") at++;
        else quote = '';
      } else if (character === '\\' && quote === '"') at++;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '{') brace++;
    else if (character === '}') brace--;
    else if (character === '|' && brace <= 0) {
      if (text[at + 1] === '|') at++;
      else return at;
    }
  }
  return -1;
}

interface Logical {
  readonly lines: string[];
  readonly raw: string[];
  readonly origin: number[];
}

function normalise(lines: readonly string[]): Logical {
  const out: Logical = { lines: [], raw: [], origin: [] };
  let physical = 0;
  for (const original of lines) {
    physical++;
    let rest = original.replace(/^[\s:]+/, '');
    let first = true;
    for (;;) {
      if (rest.startsWith('"')) {
        out.lines.push('');
        out.raw.push(first ? original : rest);
        break;
      }
      if (rest === '') {
        if (first) { out.lines.push(''); out.raw.push(original); }
        break;
      }
      const bar = commandWord(rest).word === '' ? -1 : barOutside(rest);
      if (bar === -1) {
        out.lines.push(rest.trimEnd());
        out.raw.push(first ? original : rest);
        break;
      }
      out.lines.push(rest.slice(0, bar).trimEnd());
      out.raw.push(first ? original.slice(0, original.length - rest.length + bar) : rest.slice(0, bar));
      rest = rest.slice(bar + 1).replace(/^[\s:]+/, '');
      first = false;
    }
    while (out.origin.length < out.lines.length) out.origin.push(physical);
  }
  return out;
}

function matching(lines: readonly string[], from: number, end: number): { branches: number[]; close: number } {
  const branches: number[] = [];
  let depth = 0;
  for (let at = from + 1; at < end; at++) {
    const { word } = commandWord(lines[at]);
    if (BLOCK_OPENERS.has(word)) depth++;
    else if (BLOCK_CLOSERS.has(word)) {
      if (depth === 0) return { branches, close: at };
      depth--;
    } else if (depth === 0 && (word === 'elseif' || word === 'else' || word === 'catch' || word === 'finally')) branches.push(at);
  }
  return { branches, close: -1 };
}

class ScriptAbort extends Error {}

class ThrownException extends Error {
  constructor(readonly text: string, readonly point: string) {
    super(text);
  }
}

export class ScriptRuntime implements UserFunctions {
  private readonly functions = new Map<string, UserFunction>();
  private readonly running: string[] = [];
  readonly output: string[] = [];
  private sources: readonly string[] = [];
  private anonymous = 0;
  private tryDepth = 0;
  private sourceName: string | null = null;
  private line = 0;
  private readonly frames: { name: string; caller: number }[] = [];
  private readonly origins = new WeakMap<readonly string[], readonly number[]>();

  location(): string {
    let text = this.sourceName ?? '';
    this.frames.forEach((frame, index) => {
      if (index === 0) text = `${this.sourceName === null ? '' : `${this.sourceName}[${frame.caller}]..`}function ${frame.name}`;
      else text = `${text}[${frame.caller}]..${frame.name}`;
    });
    return text;
  }

  private throwpoint(): string {
    const where = this.location();
    return where === '' ? '' : `${where}, line ${this.line}`;
  }

  constructor(private readonly host: ScriptHost) {}

  has(name: string): boolean {
    return this.functions.has(this.canonical(name));
  }

  private canonical(name: string): string {
    return name.startsWith('g:') ? name.slice(2) : name;
  }

  runScript(lines: readonly string[], keepGoing: boolean, sourceName: string | null): string[] {
    this.output.length = 0;
    this.sourceName = sourceName;
    const session = ExpressionSession.open(this.host.expressionHost());
    const logical = normalise(lines);
    this.sources = logical.raw;
    this.origins.set(logical.lines, logical.origin);
    try {
      this.execute(session, logical.lines, 0, logical.lines.length, keepGoing);
    } catch (failure) {
      if (failure instanceof ThrownException) this.output.push(`E605: Exception not caught: ${failure.text}`);
      else if (!(failure instanceof ScriptAbort)) throw failure;
    }
    return [...session.errors];
  }

  call(name: string, args: VimValue[], session: ExpressionSession, self: Parameters<UserFunctions['call']>[3]): VimValue {
    const fn = this.functions.get(this.canonical(name))!;
    if (args.length < fn.parameters.length) session.fail(`E119: Not enough arguments for function: ${name}`);
    if (args.length > fn.parameters.length && !fn.variadic) session.fail(`E118: Too many arguments for function: ${name}`);
    if (fn.dict && self === null) session.fail(`E725: Calling dict function without Dictionary: ${name}`);
    if (this.running.length >= MAX_FUNCTION_DEPTH) session.fail("E132: Function call depth is higher than 'maxfuncdepth'");
    const frame = new Map<string, VimValue>();
    fn.parameters.forEach((parameter, at) => frame.set(`a:${parameter}`, args[at]));
    const extra = args.slice(fn.parameters.length);
    frame.set('a:0', ExpressionSession.number(extra.length));
    frame.set('a:000', ExpressionSession.list(extra));
    extra.forEach((value, at) => frame.set(`a:${at + 1}`, value));
    if (fn.range) {
      frame.set('a:firstline', ExpressionSession.number(session.host.lineNumber));
      frame.set('a:lastline', ExpressionSession.number(session.host.lineNumber));
    }
    const variables = session.host.variables;
    variables.enter(frame);
    if (fn.dict && self !== null) variables.assign('l:self', self);
    this.running.push(this.canonical(name));
    this.frames.push({ name, caller: this.line });
    const savedLine = this.line;
    try {
      return this.executeBody(session, fn);
    } finally {
      this.line = savedLine;
      this.frames.pop();
      this.running.pop();
      variables.leave();
    }
  }

  private executeBody(session: ExpressionSession, fn: UserFunction): VimValue {
    try {
      const outcome = this.execute(session, fn.body, 0, fn.body.length, !fn.abort);
      return outcome.kind === 'return' ? outcome.value : ExpressionSession.number(0);
    } catch (failure) {
      if (!(failure instanceof ScriptAbort)) throw failure;
      return ExpressionSession.number(-1);
    }
  }

  private execute(session: ExpressionSession, lines: readonly string[], start: number, end: number, keepGoing: boolean): Outcome {
    let at = start;
    while (at < end) {
      let following = at + 1;
      const before = session.errors.length;
      const numbers = this.origins.get(lines);
      if (numbers !== undefined) this.line = numbers[at];
      try {
        const outcome = this.statement(session, lines, at, end, keepGoing, (next) => { following = next; });
        if (this.tryDepth > 0 && session.errors.length > before) throw this.exceptionFrom(session, lines[at]);
        if (outcome.kind !== 'next') return outcome;
      } catch (failure) {
        if (!isExpressionAbort(failure)) throw failure;
        if (this.tryDepth > 0) throw this.exceptionFrom(session, lines[at]);
        if (!keepGoing) throw new ScriptAbort();
      }
      at = following;
    }
    return NEXT;
  }

  private exceptionFrom(session: ExpressionSession, line: string): ThrownException {
    const message = session.popError() ?? '';
    const word = commandWord(line).word || (line.match(/^[A-Za-z]+/)?.[0] ?? '');
    return new ThrownException(`Vim(${word}):${message}`, this.throwpoint());
  }

  private tryStatement(
    session: ExpressionSession, lines: readonly string[], at: number, end: number, keepGoing: boolean, skipTo: (next: number) => void,
  ): Outcome {
    const { branches, close } = matching(lines, at, end);
    skipTo(close === -1 ? end : close + 1);
    if (close === -1) return session.fail('E600: Missing :endtry');
    const arms = [at, ...branches, close];
    const segment = (index: number): { start: number; stop: number } => ({ start: arms[index] + 1, stop: arms[index + 1] });
    const finallyIndex = arms.findIndex((arm, index) => index > 0 && index < arms.length - 1 && commandWord(lines[arm]).word === 'finally');
    const guarded = finallyIndex === -1 ? arms.length - 1 : finallyIndex;
    let outcome: Outcome = NEXT;
    let pending: unknown = null;
    this.tryDepth++;
    try {
      try {
        const body = segment(0);
        outcome = this.execute(session, lines, body.start, body.stop, keepGoing);
      } catch (failure) {
        if (!(failure instanceof ThrownException)) throw failure;
        let handled = false;
        for (let index = 1; index < guarded && !handled; index++) {
          const header = commandWord(lines[arms[index]]);
          const pattern = header.argument.trim();
          const delimiter = pattern[0];
          const source = pattern === '' ? null : pattern.slice(1, pattern.lastIndexOf(delimiter) > 0 ? pattern.lastIndexOf(delimiter) : undefined);
          if (source !== null && !session.matches(source, failure.text)) continue;
          handled = true;
          const saved = ['v:exception', 'v:throwpoint'].map((name) => session.host.variables.lookup(name));
          session.host.variables.assign('v:exception', ExpressionSession.fromScalar(failure.text));
          session.host.variables.assign('v:throwpoint', ExpressionSession.fromScalar(failure.point));
          try {
            const body = segment(index);
            outcome = this.execute(session, lines, body.start, body.stop, keepGoing);
          } finally {
            ['v:exception', 'v:throwpoint'].forEach((name, at) => {
              const previous = saved[at];
              if (previous === undefined) session.host.variables.remove(name);
              else session.host.variables.assign(name, previous);
            });
          }
        }
        if (!handled) throw failure;
      }
    } catch (failure) {
      pending = failure;
    } finally {
      this.tryDepth--;
    }
    if (finallyIndex !== -1) {
      const body = segment(finallyIndex);
      const after = this.execute(session, lines, body.start, body.stop, keepGoing);
      if (after.kind !== 'next') return after;
    }
    if (pending !== null) throw pending;
    return outcome;
  }

  private statement(
    session: ExpressionSession, lines: readonly string[], at: number, end: number, keepGoing: boolean, skipTo: (next: number) => void,
  ): Outcome {
    const { word, bang, argument } = commandWord(lines[at]);
    switch (word) {
      case 'if': {
        const { branches, close } = matching(lines, at, end);
        skipTo(close === -1 ? end : close + 1);
        if (close === -1) session.fail('E171: Missing :endif');
        const arms = [at, ...branches];
        for (let index = 0; index < arms.length; index++) {
          const arm = arms[index];
          const header = commandWord(lines[arm]);
          if (header.word !== 'else' && !session.condition(header.argument)) continue;
          const outcome = this.execute(session, lines, arm + 1, index + 1 < arms.length ? arms[index + 1] : close, keepGoing);
          return outcome;
        }
        return NEXT;
      }
      case 'while': {
        const { close } = matching(lines, at, end);
        skipTo(close === -1 ? end : close + 1);
        if (close === -1) session.fail('E170: Missing :endwhile');
        while (session.condition(argument)) {
          const outcome = this.execute(session, lines, at + 1, close, keepGoing);
          if (outcome.kind === 'break') break;
          if (outcome.kind === 'return') return outcome;
        }
        return NEXT;
      }
      case 'for': {
        const { close } = matching(lines, at, end);
        skipTo(close === -1 ? end : close + 1);
        if (close === -1) session.fail('E170: Missing :endfor');
        const loop = argument.match(/^(\[[^\]]*\]|[A-Za-z_][\w:#]*)\s+in\s+(.*)$/s);
        if (loop === null) return session.fail('E690: Missing "in" after :for');
        const items = session.items(session.evaluate(loop[2]));
        if (items === null) return session.fail('E1098: String, List or Blob required');
        for (const item of items) {
          session.declareLoopVariables(loop[1], item);
          const outcome = this.execute(session, lines, at + 1, close, keepGoing);
          if (outcome.kind === 'break') break;
          if (outcome.kind === 'return') return outcome;
        }
        return NEXT;
      }
      case 'try': return this.tryStatement(session, lines, at, end, keepGoing, skipTo);
      case 'catch': return session.fail(`E603: :catch without :try: ${lines[at]}`);
      case 'finally': return session.fail(`E606: :finally without :try: ${lines[at]}`);
      case 'endtry': return session.fail(`E602: :endtry without :try: ${lines[at]}`);
      case 'throw': throw new ThrownException(session.text(session.evaluate(argument)), this.throwpoint());
      case 'echoerr': return session.fail(session.echo(argument, ' '));
      case 'const': session.assign(argument, true); return NEXT;
      case 'lockvar': session.lock(bang ? `!${argument}` : argument, true); return NEXT;
      case 'unlockvar': session.lock(bang ? `!${argument}` : argument, false); return NEXT;
      case 'function': skipTo(this.define(session, lines, at, end, bang, argument, skipTo)); return NEXT;
      case 'endfunction': return session.fail('E193: :endfunction not inside a function');
      case 'delfunction': this.remove(session, bang, argument); return NEXT;
      case 'break': return { kind: 'break' };
      case 'continue': return { kind: 'continue' };
      case 'return': return { kind: 'return', value: argument.trim() === '' ? ExpressionSession.number(0) : session.evaluate(argument) };
      case 'endif': return session.fail(`E580: :endif without :if: ${lines[at]}`);
      case 'endwhile': return session.fail(`E588: :endwhile without :while: ${lines[at]}`);
      case 'endfor': return session.fail(`E588: :endfor without :for: ${lines[at]}`);
      case 'elseif': return session.fail(`E582: :elseif without :if: ${lines[at]}`);
      case 'else': return session.fail(`E581: :else without :if: ${lines[at]}`);
      case 'let': session.assign(argument); return NEXT;
      case 'unlet': session.unassign(argument, bang); return NEXT;
      case 'call': session.evaluate(argument); return NEXT;
      case 'echo': case 'echomsg': this.output.push(session.echo(argument, ' ')); return NEXT;
      case 'echon': {
        const text = session.echo(argument, '');
        if (this.output.length === 0) this.output.push(text);
        else this.output[this.output.length - 1] += text;
        return NEXT;
      }
      case 'execute': {
        const text = session.sequence(argument).map((value) => session.text(value)).join(' ');
        const logical = normalise(text.split('\n'));
        return this.execute(session, logical.lines, 0, logical.lines.length, keepGoing);
      }
      default: {
        const failure = this.host.runExLine(lines[at]);
        if (failure !== null) session.fail(failure);
        return NEXT;
      }
    }
  }

  private list(session: ExpressionSession, argument: string): void {
    if (argument === '') {
      const names = [...this.functions.values()].filter((fn) => !/^\d+$/.test(fn.name));
      const shown = [...names.filter((fn) => !fn.name.startsWith('s:')).sort((x, y) => (x.name < y.name ? -1 : 1)), ...names.filter((fn) => fn.name.startsWith('s:')).sort((x, y) => (x.name < y.name ? -1 : 1))];
      for (const fn of shown) this.output.push(fn.listing[0].trim());
      return;
    }
    const fn = this.functions.get(this.canonical(argument));
    if (fn === undefined) return session.fail(`E123: Undefined function: ${argument}`);
    this.output.push(...fn.listing);
  }

  private remove(session: ExpressionSession, bang: boolean, argument: string): void {
    const name = this.canonical(argument.trim());
    if (!this.functions.has(name)) {
      if (bang) return;
      session.fail(`E117: Unknown function: ${name}`);
    }
    if (this.running.includes(name)) session.fail(`E131: Cannot delete function ${name}: It is in use`);
    this.functions.delete(name);
  }

  private define(
    session: ExpressionSession, lines: readonly string[], at: number, end: number, bang: boolean, argument: string, skipTo: (next: number) => void,
  ): number {
    if (!argument.includes('(')) {
      this.list(session, argument.trim());
      return at + 1;
    }
    let close = at + 1;
    for (let nesting = 0; close < end; close++) {
      const inner = commandWord(lines[close]);
      if (inner.word === 'function' && inner.argument.includes('(')) nesting++;
      else if (inner.word === 'endfunction' && nesting-- === 0) break;
    }
    const header = argument.match(/^([^\s(]+)\s*\(([^)]*)\)\s*(.*)$/s);
    if (header === null) return session.fail(`E124: Missing '(': ${argument.trim()}`);
    const [, rawName, rawParameters, attributes] = header;
    const member = rawName.match(/^([A-Za-z_][\w:#]*)\.([A-Za-z_]\w*)$/);
    const name = member === null ? this.canonical(rawName) : String(++this.anonymous);
    if (member === null && !FUNCTION_NAME.test(rawName)) session.fail(`E128: Function name must start with a capital or "s:": ${argument.trim()}`);
    const pieces = rawParameters.split(',').map((piece) => piece.trim()).filter((piece) => piece !== '');
    const variadic = pieces[pieces.length - 1] === '...';
    const parameters = variadic ? pieces.slice(0, -1) : pieces;
    const seen = new Set<string>();
    for (const parameter of parameters) {
      if (!/^[A-Za-z_]\w*$/.test(parameter)) session.fail(`E125: Illegal argument: ${rawParameters.slice(rawParameters.indexOf(parameter)).trim()})`);
      if (seen.has(parameter)) session.fail(`E853: Duplicate argument name: ${parameter}`);
      seen.add(parameter);
    }
    skipTo(close < end ? close + 1 : end);
    if (close >= end) session.fail('E126: Missing :endfunction');
    if (member !== null && !bang && session.truth(session.evaluate(`has_key(${member[1]}, '${member[2]}')`))) session.fail('E717: Dictionary entry already exists');
    if (member === null && this.functions.has(name) && !bang) session.fail(`E122: Function ${name} already exists, add ! to replace it`);
    if (this.running.includes(name)) session.fail(`E127: Cannot redefine function ${name}: It is in use`);
    const flags = new Set(attributes.split(/\s+/).filter((word) => word !== ''));
    for (const flag of flags) if (!['abort', 'range', 'dict', 'closure'].includes(flag)) session.fail(`E488: Trailing characters: ${attributes.trim()}`);
    const signature = `${rawName}(${[...parameters, ...(variadic ? ['...'] : [])].join(', ')})${[...flags].map((flag) => ` ${flag}`).join('')}`;
    const body = lines.slice(at + 1, close);
    const numbers = this.origins.get(lines);
    if (numbers !== undefined) this.origins.set(body, numbers.slice(at + 1, close).map((number) => number - numbers[at]));
    this.functions.set(name, {
      name, parameters, variadic, abort: flags.has('abort'), range: flags.has('range'), dict: flags.has('dict') || member !== null,
      body,
      listing: [`   function ${signature.replace(/^s:/, '<SNR>1_')}`, ...this.sources.slice(at + 1, close).map((text, index) => `${String(index + 1).padEnd(3)}${text}`), '   endfunction'],
    });
    if (member !== null) session.assign(`${member[1]}.${member[2]} = function('${name}')`);
    return close + 1;
  }
}
