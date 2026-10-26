import { compileEre, PosixRegexError, type CompiledEre } from '@/network/devices/linux/regex/PosixEre';
import { parseCombination, type ColorCombination } from './NanoPaint';

export interface RcLocation {
  readonly file: string;
  readonly line: number;
}

export type Jot = (message: string, at?: RcLocation) => void;

export interface ColorRule {
  readonly start: CompiledEre;
  readonly end: CompiledEre | null;
  readonly combination: ColorCombination;
  readonly id: number;
}

interface Augmentation {
  readonly file: string;
  readonly line: number;
  readonly data: string;
}

export interface SyntaxDefinition {
  readonly name: string;
  readonly file: string;
  readonly line: number;
  readonly sourceLines: readonly string[];
  readonly extensions: CompiledEre[];
  readonly headers: CompiledEre[];
  readonly augmentations: Augmentation[];
  rules: ColorRule[];
  multiCount: number;
  comment: string;
  tab: string | null;
  linter: string | null;
  formatter: string | null;
  loaded: boolean;
}

export interface SyntaxSelection {
  readonly syntax: SyntaxDefinition | null;
  readonly alert: string | null;
}

export const GENERAL_COMMENT = '#';

function isBlank(character: string | undefined): boolean {
  return character === ' ' || character === '\t';
}

function skipBlanks(text: string, from: number): number {
  let at = from;
  while (isBlank(text[at])) at++;
  return at;
}

export function nextWord(text: string): [string, string] {
  let at = 0;
  while (at < text.length && !isBlank(text[at])) at++;
  return [text.slice(0, at), text.slice(skipBlanks(text, at))];
}

type RegexKind = 'extension' | 'header';

class RegexReader {
  constructor(private readonly jot: Jot) {}

  next(text: string, at: number): { regex: string; rest: string } | null {
    if (text[at - 1] !== '"') {
      this.jot('Regex strings must begin and end with a " character');
      return null;
    }
    let end = at;
    while (end < text.length && (text[end] !== '"' || (end + 1 < text.length && !isBlank(text[end + 1])))) end++;
    if (end >= text.length) {
      this.jot('Regex strings must begin and end with a " character');
      return null;
    }
    if (end === at) {
      this.jot('Empty regex string');
      return null;
    }
    return { regex: text.slice(at, end), rest: text.slice(skipBlanks(text, end + 1)) };
  }

  compile(expression: string, ignoreCase: boolean): CompiledEre | null {
    try {
      return compileEre(expression, ignoreCase);
    } catch (error) {
      if (!(error instanceof PosixRegexError)) throw error;
      this.jot(`Bad regex "${expression}": ${error.message}`);
      return null;
    }
  }
}

export class SyntaxCatalog {
  private readonly list: SyntaxDefinition[] = [];
  private live: SyntaxDefinition | null = null;
  private open = false;
  private seenColorCommand = false;

  get definitions(): readonly SyntaxDefinition[] {
    return this.list;
  }

  get isEmpty(): boolean {
    return this.list.length === 0;
  }

  checkNonEmpty(jot: Jot): void {
    if (this.open && !this.seenColorCommand) jot(`Syntax "${this.live!.name}" has no color commands`, { file: this.live!.file, line: this.live!.line });
    this.open = false;
  }

  begin(argument: string, location: RcLocation, sourceLines: readonly string[], jot: Jot): void {
    if (argument === '' || (argument[0] === '"' && (argument.length === 1 || argument[1] === '"'))) {
      jot('Missing syntax name');
      return;
    }
    const [token, rest] = nextWord(argument);
    if ((token[0] === '"') !== (token[token.length - 1] === '"')) {
      jot('Unpaired quote in syntax name');
      return;
    }
    const name = token[0] === '"' ? token.slice(1, -1) : token;
    if (name === 'none') {
      jot('The "none" syntax is reserved');
      return;
    }
    const syntax: SyntaxDefinition = {
      name, file: location.file, line: location.line, sourceLines, extensions: [], headers: [], augmentations: [],
      rules: [], multiCount: 0, comment: GENERAL_COMMENT, tab: null, linter: null, formatter: null, loaded: false,
    };
    this.list.unshift(syntax);
    this.live = syntax;
    this.open = true;
    this.seenColorCommand = false;
    if (name === 'default' && rest !== '') {
      jot('The "default" syntax does not accept extensions');
      return;
    }
    if (rest !== '') this.grab('extension', rest, syntax.extensions, jot);
  }

  header(argument: string, jot: Jot): void {
    this.grab('header', argument, this.live?.headers ?? [], jot);
  }

  noteBodyCommand(keyword: string, jot: Jot): void {
    if (!this.open) jot(`A '${keyword}' command requires a preceding 'syntax' command`);
    if ('icolor'.includes(keyword)) this.seenColorCommand = true;
  }

  extend(argument: string, location: RcLocation, jot: Jot): { applyImmediately: string | null } {
    this.checkNonEmpty(jot);
    const [name, afterName] = nextWord(argument);
    const target = this.list.find((candidate) => candidate.name === name);
    if (target === undefined) {
      jot(`Could not find syntax "${name}" to extend`);
      return { applyImmediately: null };
    }
    const [keyword] = nextWord(afterName);
    if (keyword === 'header' || keyword === 'magic') {
      this.live = target;
      this.open = true;
      return { applyImmediately: afterName };
    }
    target.augmentations.push({ file: location.file, line: location.line, data: afterName });
    return { applyImmediately: null };
  }

  closeImmediateExtension(): void {
    this.open = false;
  }

  private grab(kind: RegexKind, argument: string, storage: CompiledEre[], jot: Jot): void {
    if (!this.open) {
      jot(`A '${kind}' command requires a preceding 'syntax' command`);
      return;
    }
    if (this.live!.name === 'default' && argument !== '') {
      jot(`The "default" syntax does not accept '${kind}' regexes`);
      return;
    }
    if (argument === '') {
      jot(`Missing regex string after '${kind}' command`);
      return;
    }
    const reader = new RegexReader(jot);
    let rest = argument;
    while (rest !== '') {
      const found = reader.next(rest, 1);
      if (found === null) return;
      rest = found.rest;
      const compiled = reader.compile(found.regex, false);
      if (compiled !== null) storage.push(compiled);
    }
  }

  select(override: string | null, fullName: string, firstLine: string, jot: Jot): SyntaxSelection {
    if (this.list.length === 0) return { syntax: null, alert: null };
    let syntax: SyntaxDefinition | null = null;
    let alert: string | null = null;
    if (override !== null) {
      if (override === 'none') return { syntax: null, alert: null };
      syntax = this.list.find((candidate) => candidate.name === override) ?? null;
      if (syntax === null) alert = `Unknown syntax name: ${override}`;
    }
    if (syntax === null) syntax = this.list.find((candidate) => candidate.extensions.some((regex) => regex.exec(fullName, 0) !== null)) ?? null;
    if (syntax === null) syntax = this.list.find((candidate) => candidate.headers.some((regex) => regex.exec(firstLine, 0) !== null)) ?? null;
    if (syntax === null) syntax = this.list.find((candidate) => candidate.name === 'default') ?? null;
    if (syntax !== null && !syntax.loaded) this.load(syntax, jot);
    return { syntax, alert };
  }

  private load(syntax: SyntaxDefinition, jot: Jot): void {
    syntax.loaded = true;
    for (let index = syntax.line; index < syntax.sourceLines.length; index++) {
      const at: RcLocation = { file: syntax.file, line: index + 1 };
      const text = syntax.sourceLines[index].replace(/\r$/, '');
      const line = text.slice(skipBlanks(text, 0));
      if (line === '' || line[0] === '#') continue;
      const [keyword, rest] = nextWord(line);
      if (keyword === 'syntax' || keyword === 'set' || keyword === 'unset' || keyword === 'bind' || keyword === 'unbind' || keyword === 'include' || keyword === 'extendsyntax') break;
      this.command(syntax, keyword, rest, (message) => jot(message, at));
    }
    for (const extra of syntax.augmentations) {
      const [keyword, rest] = nextWord(extra.data);
      const at: RcLocation = { file: extra.file, line: extra.line };
      if (!this.command(syntax, keyword, rest, (message) => jot(message, at))) jot(`Command "${keyword}" not understood`, at);
    }
  }

  private command(syntax: SyntaxDefinition, keyword: string, rest: string, jot: (message: string) => void): boolean {
    if (keyword === 'color') this.rule(syntax, rest, false, jot);
    else if (keyword === 'icolor') this.rule(syntax, rest, true, jot);
    else if (keyword === 'comment') syntax.comment = this.name('comment', rest, jot) ?? syntax.comment;
    else if (keyword === 'tabgives') syntax.tab = this.name('tabgives', rest, jot) ?? syntax.tab;
    else if (keyword === 'linter') syntax.linter = this.name('linter', rest, jot) ?? syntax.linter;
    else if (keyword === 'formatter') syntax.formatter = this.name('formatter', rest, jot) ?? syntax.formatter;
    else return false;
    return true;
  }

  private name(kind: string, argument: string, jot: (message: string) => void): string | null {
    if (argument === '') {
      jot(`Missing argument after '${kind}'`);
      return null;
    }
    if (argument[0] !== '"') return argument;
    const closing = argument.lastIndexOf('"');
    if (closing <= 0) {
      jot(`Argument of '${kind}' lacks closing "`);
      return null;
    }
    return argument.slice(1, closing);
  }

  private rule(syntax: SyntaxDefinition, argument: string, ignoreCase: boolean, jot: (message: string) => void): void {
    if (argument === '') {
      jot('Missing color name');
      return;
    }
    const [names, afterNames] = nextWord(argument);
    const outcome = parseCombination(names);
    if ('error' in outcome) {
      jot(outcome.error);
      return;
    }
    if (afterNames === '') {
      jot("Missing regex string after 'color' command");
      return;
    }
    const reader = new RegexReader(jot);
    let rest = afterNames;
    while (rest !== '') {
      const expectsEnd = rest.startsWith('start=');
      if (expectsEnd) rest = rest.slice(6);
      const first = reader.next(rest, 1);
      if (first === null) return;
      const start = reader.compile(first.regex, ignoreCase);
      if (start === null) return;
      rest = first.rest;
      let end: CompiledEre | null = null;
      if (expectsEnd) {
        if (!rest.startsWith('end=')) {
          jot('"start=" requires a corresponding "end="');
          return;
        }
        const second = reader.next(rest, 5);
        if (second === null) return;
        end = reader.compile(second.regex, ignoreCase);
        if (end === null) return;
        rest = second.rest;
      }
      syntax.rules.push({ start, end, combination: outcome.combination, id: expectsEnd ? syntax.multiCount++ : -1 });
    }
  }
}
