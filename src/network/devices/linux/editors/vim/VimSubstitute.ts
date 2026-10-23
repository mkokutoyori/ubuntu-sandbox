import { skipRegexp } from './VimRegex';
import { BufferText, type MultiMatch, type VimRegExp } from './VimPattern';
import { lowerCaseChar, upperCaseChar } from './VimEditing';

export interface SubstituteFlags {
  all: boolean;
  ask: boolean;
  count: boolean;
  error: boolean;
  print: boolean;
  number: boolean;
  list: boolean;
  ignoreCase: '' | 'i' | 'I';
}

export function initialSubstituteFlags(): SubstituteFlags {
  return { all: false, ask: false, count: false, error: true, print: false, number: false, list: false, ignoreCase: '' };
}

export type PatternSource = 'substitute' | 'last' | 'search';

export interface SubstituteMemory {
  flags: SubstituteFlags;
  oldReplacement: string | null;
  previousExpansion: string | null;
}

export function freshSubstituteMemory(): SubstituteMemory {
  return { flags: initialSubstituteFlags(), oldReplacement: null, previousExpansion: null };
}

export interface ParsedSubstitute {
  readonly pattern: string | null;
  readonly replacement: string;
  readonly source: PatternSource;
  readonly count: number | null;
  readonly nextCommand: string | null;
  readonly join: boolean;
  readonly joinFlag: string;
  readonly keptCursorColumn: boolean;
}

export type SubstituteParse = { readonly error: string } | { readonly parsed: ParsedSubstitute };

const FLAG_START = '0123456789cegriIp|"';

function isWhite(character: string | undefined): boolean {
  return character === ' ' || character === '\t';
}

function skipReplacement(text: string, from: number, delimiter: string): { replacement: string; next: number } {
  let at = from;
  while (at < text.length) {
    if (text[at] === delimiter) return { replacement: text.slice(from, at), next: at + 1 };
    if (text[at] === '\\' && at + 1 < text.length) at++;
    at += text.codePointAt(at)! > 0xffff ? 2 : 1;
  }
  return { replacement: text.slice(from), next: text.length };
}

export function parseSubstitute(
  name: 's' | '&' | '~',
  argument: string,
  memory: SubstituteMemory,
  gdefault: boolean,
): SubstituteParse {
  let at = 0;
  let pattern: string | null = null;
  let replacement = '';
  let source: PatternSource = name === '~' ? 'last' : 'substitute';
  let keptCursorColumn = false;

  if (name === 's' && argument.length > 0 && !isWhite(argument[0]) && !FLAG_START.includes(argument[0])) {
    if (/[A-Za-z]/.test(argument[0])) return { error: "E146: Regular expressions can't be delimited by letters" };
    let delimiter = argument[0];
    if (delimiter === '\\') {
      const following = argument[1];
      if (following === undefined || !'/?&'.includes(following)) return { error: 'E10: \\ should be followed by /, ? or &' };
      if (following !== '&') source = 'search';
      pattern = '';
      delimiter = following;
      at = 2;
    } else {
      source = 'last';
      const start = 1;
      const end = skipRegexp(argument, start, delimiter);
      pattern = argument.slice(start, end);
      at = end < argument.length ? end + 1 : end;
    }
    const skipped = skipReplacement(argument, at, delimiter);
    replacement = skipped.replacement;
    at = skipped.next;
    memory.oldReplacement = replacement;
  } else {
    if (memory.oldReplacement === null) return { error: 'E33: No previous substitute regular expression' };
    replacement = memory.oldReplacement;
    keptCursorColumn = true;
  }

  const rest = argument.slice(at);
  if (pattern === '\\n' && replacement === '' && (rest === '' || (rest.length === 1 && 'glp#'.includes(rest)))) {
    return {
      parsed: { pattern, replacement, source, count: null, nextCommand: null, join: true, joinFlag: rest, keptCursorColumn },
    };
  }

  const flags = memory.flags;
  let cursor = 0;
  if (rest[0] === '&') {
    cursor = 1;
  } else {
    flags.all = gdefault;
    flags.ask = false;
    flags.error = true;
    flags.print = false;
    flags.list = false;
    flags.count = false;
    flags.number = false;
    flags.ignoreCase = '';
  }
  for (; cursor < rest.length; cursor++) {
    const flag = rest[cursor];
    if (flag === 'g') flags.all = !flags.all;
    else if (flag === 'c') flags.ask = !flags.ask;
    else if (flag === 'n') flags.count = true;
    else if (flag === 'e') flags.error = !flags.error;
    else if (flag === 'r') source = 'last';
    else if (flag === 'p') flags.print = true;
    else if (flag === '#') {
      flags.print = true;
      flags.number = true;
    } else if (flag === 'l') {
      flags.print = true;
      flags.list = true;
    } else if (flag === 'i') flags.ignoreCase = 'i';
    else if (flag === 'I') flags.ignoreCase = 'I';
    else break;
  }
  if (flags.count) flags.ask = false;

  while (isWhite(rest[cursor])) cursor++;
  let count: number | null = null;
  if (rest[cursor] !== undefined && rest[cursor] >= '0' && rest[cursor] <= '9') {
    let digits = '';
    while (rest[cursor] !== undefined && rest[cursor] >= '0' && rest[cursor] <= '9') digits += rest[cursor++];
    count = Number(digits);
    if (count <= 0 && flags.error) return { error: 'E939: Positive count required' };
  }

  while (isWhite(rest[cursor])) cursor++;
  let nextCommand: string | null = null;
  if (cursor < rest.length && rest[cursor] !== '"') {
    if (rest[cursor] === '|' || rest[cursor] === '\n') nextCommand = rest.slice(cursor + 1);
    else return { error: `E488: Trailing characters: ${rest.slice(cursor)}` };
  }

  return {
    parsed: { pattern, replacement, source, count, nextCommand, join: false, joinFlag: '', keptCursorColumn },
  };
}

export function expandTilde(replacement: string, previous: string | null): string {
  let out = '';
  for (let i = 0; i < replacement.length; i++) {
    const character = replacement[i];
    if (character === '~') {
      out += previous ?? '';
    } else if (character === '\\' && i + 1 < replacement.length) {
      out += character + replacement[i + 1];
      i++;
    } else {
      out += character;
    }
  }
  return out;
}

type CaseFunction = (character: string) => string;

export function expandReplacement(template: string, match: Pick<MultiMatch, 'groups'>, forString = false): string {
  let out = '';
  let one: CaseFunction | null = null;
  let all: CaseFunction | null = null;
  const convert = (character: string): string => {
    if (one !== null) {
      const converted = one(character);
      one = null;
      return converted;
    }
    return all !== null ? all(character) : character;
  };
  let i = 0;
  const take = (): string => {
    const character = String.fromCodePoint(template.codePointAt(i)!);
    i += character.length;
    return character;
  };
  while (i < template.length) {
    const character = take();
    let group = -1;
    if (character === '&') {
      group = 0;
    } else if (character === '\\' && i < template.length) {
      const next = template[i];
      if (next >= '0' && next <= '9') {
        group = Number(next);
        i++;
      } else if ('uUlLeE'.includes(next)) {
        i++;
        if (next === 'u') one = upperCaseChar;
        else if (next === 'U') all = upperCaseChar;
        else if (next === 'l') one = lowerCaseChar;
        else if (next === 'L') all = lowerCaseChar;
        else {
          one = null;
          all = null;
        }
        continue;
      }
    }
    if (group < 0) {
      let literal = character;
      if (character === '\\' && i < template.length) {
        const next = template[i];
        if (next === 'r') {
          literal = '\r';
          i++;
        } else if (next === 'n') {
          literal = '\n';
          i++;
        } else if (next === 't') {
          literal = '\t';
          i++;
        } else if (next === 'b') {
          literal = '\b';
          i++;
        } else {
          if (!forString) out += '\\';
          literal = take();
        }
      }
      out += convert(literal);
      continue;
    }
    const text = match.groups[group];
    if (text === undefined) continue;
    for (const piece of text) {
      if (forString) out += convert(piece);
      else if (piece === '\n') out += '\r';
      else if (piece === '\r' || piece === '\\') out += `\\${piece}`;
      else out += convert(piece);
    }
  }
  return out;
}

export function replacementFromExpression(result: string): string {
  const characters = [...result];
  let out = '';
  let hadBackslash = false;
  for (let at = 0; at < characters.length; at++) {
    const character = characters[at];
    if (character === '\n') {
      out += '\r';
    } else if (character === '\\' && at + 1 < characters.length) {
      at++;
      out += `\\${characters[at] === '\n' ? '\r' : characters[at]}`;
      hadBackslash = true;
    } else {
      out += character;
    }
  }
  return hadBackslash ? out.replace(/\\/g, '\\\\') : out;
}

export interface LineTracker {
  inserted(index: number, count: number): void;
  deleted(index: number, count: number): void;
}

export interface AskStep {
  readonly line: number;
  readonly column: number;
  readonly endColumn: number;
  readonly matchText: string;
  readonly template: string;
}

export type AskAnswer = 'y' | 'n' | 'a' | 'q' | 'l';

export interface SubstituteRun {
  readonly lines: string[];
  readonly regex: VimRegExp;
  readonly template: string;
  readonly flags: SubstituteFlags;
  readonly tracker: LineTracker | null;
  expression: ((match: MultiMatch, line: number, column: number) => string) | null;
  line1: number;
  line2: number;
  cursorLine: number;
  cursorColumn: number;
  substitutions: number;
  linesChanged: number;
  gotMatch: boolean;
  gotQuit: boolean;
  firstMatchFrom: { line: number; column: number } | null;
}

function codePointLength(text: string, index: number): number {
  const point = text.codePointAt(index);
  return point !== undefined && point > 0xffff ? 2 : 1;
}

export function* runSubstitution(run: SubstituteRun): Generator<AskStep, void, AskAnswer> {
  const { lines, regex, flags } = run;
  let buffer: BufferText | null = null;
  const touch = (): void => {
    buffer = null;
  };
  let match: MultiMatch | null = null;
  const search = (lnum: number, column: number): number => {
    buffer ??= new BufferText(lines);
    match = regex.execMulti(buffer, lnum - 1, column);
    return match === null ? 0 : match.endLine + 1;
  };
  const insertLine = (index: number, text: string): void => {
    lines.splice(index, 0, text);
    run.tracker?.inserted(index, 1);
    touch();
  };

  let line2 = run.line2;
  let gotQuit = false;
  for (let lnum = run.line1; lnum <= line2 && !gotQuit; lnum++) {
    let nmatch = search(lnum, 0);
    if (nmatch === 0) continue;

    let copycol = 0;
    let matchcol = 0;
    let prevMatchcol = Number.MAX_SAFE_INTEGER;
    let newStart: string | null = null;
    let didSub = false;
    let nmatchTl = 0;
    let skipMatch = false;
    let subFirstlnum = lnum;
    let subFirstline: string | null = null;

    if (!run.gotMatch) {
      run.gotMatch = true;
      run.firstMatchFrom = { line: run.cursorLine, column: run.cursorColumn };
    }

    for (;;) {
      const found = match as unknown as MultiMatch;
      if (found.startLine > 0) {
        lnum += found.startLine;
        subFirstlnum += found.startLine;
        nmatch -= found.startLine;
        subFirstline = null;
      }
      if (lnum > lines.length) break;
      if (subFirstline === null) subFirstline = lines[subFirstlnum - 1];

      run.cursorLine = lnum;
      let doAgain = false;

      let proceed = true;
      if (matchcol === prevMatchcol && found.endLine === 0 && matchcol === found.endCol) {
        if (matchcol >= subFirstline.length) skipMatch = true;
        else matchcol += codePointLength(subFirstline, matchcol);
        proceed = false;
      }

      if (proceed) {
        matchcol = found.endCol;
        prevMatchcol = matchcol;

        if (flags.count) {
          if (nmatch > 1) {
            matchcol = subFirstline.length;
            nmatch = 1;
            skipMatch = true;
          }
          run.substitutions++;
          didSub = true;
          proceed = false;
        }
      }

      if (proceed && flags.ask) {
        const answer: AskAnswer = yield {
          line: lnum, column: found.startCol, endColumn: found.endLine === 0 ? found.endCol : subFirstline.length,
          matchText: found.groups[0] ?? '', template: run.template,
        };
        if (answer === 'q') {
          gotQuit = true;
          proceed = false;
        } else if (answer === 'n') {
          if (nmatch > 1) {
            matchcol = subFirstline.length;
            skipMatch = true;
          }
          proceed = false;
        } else if (answer === 'l') {
          flags.all = false;
          line2 = lnum;
        } else if (answer === 'a') {
          flags.ask = false;
        }
      }

      if (proceed) {
        run.cursorColumn = found.startCol;
        const expanded = run.expression !== null && run.template.startsWith('\\=')
          ? replacementFromExpression(run.expression(found, lnum, found.startCol))
          : expandReplacement(run.template, found);

        if (nmatch > lines.length - subFirstlnum + 1) {
          nmatch = lines.length - subFirstlnum + 1;
          skipMatch = true;
        }
        if (nmatch !== 1) nmatchTl += nmatch - 1;

        let current = (newStart ?? '') + subFirstline.slice(copycol, found.startCol);
        run.substitutions++;
        didSub = true;
        run.cursorColumn = 0;

        if (nmatch > 1) {
          subFirstlnum += nmatch - 1;
          subFirstline = lines[subFirstlnum - 1];
          if (subFirstlnum <= line2) doAgain = true;
          else flags.all = false;
        }
        copycol = found.endCol;
        if (skipMatch) {
          subFirstline = '';
          copycol = 0;
        }

        for (let index = 0; index < expanded.length;) {
          const character = expanded[index];
          if (character === '\\' && index + 1 < expanded.length) {
            const escaped = String.fromCodePoint(expanded.codePointAt(index + 1)!);
            current += escaped;
            index += 1 + escaped.length;
          } else if (character === '\r') {
            insertLine(lnum - 1, current);
            current = '';
            subFirstlnum++;
            lnum++;
            line2++;
            run.cursorLine++;
            index++;
          } else {
            current += character;
            index++;
          }
        }
        newStart = current;
      }

      const lastOne = skipMatch || gotQuit || lnum > line2 || !(flags.all || doAgain)
        || (matchcol >= subFirstline.length && nmatch <= 1 && !regex.matchesLineBreaks);
      nmatch = -1;

      let evaluated = false;
      let moreMatches = false;
      if (!(lastOne || nmatchTl > 0)) {
        nmatch = search(subFirstlnum, matchcol);
        evaluated = true;
        moreMatches = nmatch !== 0 && (match as unknown as MultiMatch).startLine <= 0;
      }
      if (!moreMatches) {
        if (newStart !== null) {
          newStart += subFirstline.slice(copycol);
          const matchFromEnd = subFirstline.length - matchcol;
          const previousFromEnd = subFirstline.length - prevMatchcol;
          lines[lnum - 1] = newStart;
          touch();
          if (nmatchTl > 0) {
            lnum++;
            lines.splice(lnum - 1, nmatchTl);
            run.tracker?.deleted(lnum - 1, nmatchTl);
            touch();
            lnum--;
            line2 -= nmatchTl;
            nmatchTl = 0;
          }
          subFirstlnum = lnum;
          subFirstline = newStart;
          newStart = null;
          matchcol = subFirstline.length - matchFromEnd;
          prevMatchcol = subFirstline.length - previousFromEnd;
          copycol = 0;
        }
        if (nmatch === -1 && !lastOne && !evaluated) nmatch = search(subFirstlnum, matchcol);
        if (nmatch <= 0) {
          if (nmatch === -1) lnum -= (match as unknown as MultiMatch | null)?.startLine ?? 0;
          break;
        }
      }
    }

    if (didSub) run.linesChanged++;
  }
  run.line2 = line2;
  run.gotQuit = gotQuit;
}

export function substitutionMessage(substitutions: number, linesChanged: number, countOnly: boolean): string {
  const noun = countOnly ? (substitutions === 1 ? 'match' : 'matches') : (substitutions === 1 ? 'substitution' : 'substitutions');
  return `${substitutions} ${noun} on ${linesChanged} line${linesChanged === 1 ? '' : 's'}`;
}

export function joinedCursorColumn(lines: readonly string[], firstLine: number, count: number): number {
  const lastLength = lines[firstLine + count - 1].length;
  let total = 0;
  for (let i = 0; i < count; i++) total += lines[firstLine + i].length;
  return total - lastLength;
}
