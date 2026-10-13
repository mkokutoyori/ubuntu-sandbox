import { advanceOver, breadth, isBlankChar, wideness } from './NanoText';

export const DEFAULT_QUOTE_PATTERN = '^([ \\t]*([!#%:;>|}]|/{2}))+';
export const DEFAULT_PUNCTUATION = '!.?';
export const DEFAULT_BRACKETS = '"\')>]}';

const RECURSION_LIMIT = 222;

export interface JustifyContext {
  readonly quote: RegExp;
  readonly bookstyle: boolean;
  readonly autoindent: boolean;
  readonly trimblanks: boolean;
  readonly wrapAt: number;
  readonly tabsize: number;
}

export function indentLength(text: string): number {
  let length = 0;
  while (length < text.length && isBlankChar(text[length])) length++;
  return length;
}

export function quoteLength(text: string, quote: RegExp): number {
  const match = quote.exec(text);
  return match === null ? 0 : match.index + match[0].length;
}

export function leadLength(text: string, quote: RegExp): number {
  const quoted = quoteLength(text, quote);
  return quoted + indentLength(text.slice(quoted));
}

export function inParagraph(text: string, quote: RegExp): boolean {
  return leadLength(text, quote) < text.length;
}

export function beginsParagraph(lines: readonly string[], index: number, depth: number, context: JustifyContext): boolean {
  if (index === 0) return true;
  if (depth > RECURSION_LIMIT) return false;
  const line = lines[index];
  const previous = lines[index - 1];
  const quoted = quoteLength(line, context.quote);
  const indent = indentLength(line.slice(quoted));
  if (line.length === quoted + indent) return false;
  if (context.bookstyle && !context.autoindent && isBlankChar(line[0])) return true;
  if (quoted !== quoteLength(previous, context.quote) || line.slice(0, quoted) !== previous.slice(0, quoted)) return true;
  const previousIndent = indentLength(previous.slice(quoted));
  if (previous.length === quoted + previousIndent) return true;
  if (wideness(previous, quoted + previousIndent, context.tabsize) === wideness(line, quoted + indent, context.tabsize)) return false;
  return !beginsParagraph(lines, index - 1, depth + 1, context);
}

export function paragraphStart(lines: readonly string[], index: number, context: JustifyContext): number {
  let line = index > 0 ? index - 1 : index;
  while (!beginsParagraph(lines, line, 0, context)) line--;
  return line;
}

export function paragraphEnd(lines: readonly string[], index: number, context: JustifyContext): number {
  let line = index;
  while (line < lines.length - 1 && !inParagraph(lines[line], context.quote)) line++;
  while (line < lines.length - 1 && inParagraph(lines[line + 1], context.quote) && !beginsParagraph(lines, line + 1, 0, context)) line++;
  return line;
}

export function findParagraph(lines: readonly string[], from: number, context: JustifyContext): { first: number; count: number } | null {
  let first = from;
  while (!inParagraph(lines[first], context.quote) && first < lines.length - 1) first++;
  const last = paragraphEnd(lines, first, context);
  if (!inParagraph(lines[last], context.quote)) return null;
  return { first, count: last - first + 1 };
}

export function concatenateParagraph(lines: string[], first: number, count: number, quote: RegExp): void {
  for (let remaining = count; remaining > 1; remaining--) {
    const next = lines[first + 1];
    const nextLead = leadLength(next, quote);
    let joined = lines[first];
    if (joined.length > 0 && joined[joined.length - 1] !== ' ') joined += ' ';
    lines[first] = joined + next.slice(nextLead);
    lines.splice(first + 1, 1);
  }
}

export function squeeze(text: string, skip: number, punctuation = DEFAULT_PUNCTUATION, brackets = DEFAULT_BRACKETS): string {
  let result = text.slice(0, skip);
  let from = skip;
  const blankAt = (index: number): boolean => index < text.length && isBlankChar(text[index]);
  while (from < text.length) {
    if (blankAt(from)) {
      from++;
      result += ' ';
      while (blankAt(from)) from++;
    } else if (punctuation.includes(text[from])) {
      result += text[from++];
      if (from < text.length && brackets.includes(text[from])) result += text[from++];
      if (blankAt(from)) {
        from++;
        result += ' ';
      }
      if (blankAt(from)) {
        from++;
        result += ' ';
      }
      while (blankAt(from)) from++;
    } else {
      result += text[from++];
    }
  }
  let end = result.length;
  while (end > skip && result[end - 1] === ' ') end--;
  return result.slice(0, end);
}

export function breakLine(text: string, goal: number, tabsize: number): number {
  let pointer = 0;
  let column = 0;
  let lastBlank = -1;
  const step = (): void => {
    const advance = advanceOver(text, pointer, column, tabsize);
    pointer += advance.length;
    column += advance.width;
  };
  while (pointer < text.length && isBlankChar(text[pointer])) step();
  while (pointer < text.length && column <= goal) {
    if (isBlankChar(text[pointer])) lastBlank = pointer;
    step();
  }
  if (column <= goal) return pointer;
  while (lastBlank < 0) {
    if (pointer >= text.length) return -1;
    if (isBlankChar(text[pointer])) lastBlank = pointer;
    else pointer += advanceOver(text, pointer, column, tabsize).length;
  }
  pointer = lastBlank + 1;
  while (pointer < text.length && isBlankChar(text[pointer])) {
    lastBlank = pointer;
    pointer++;
  }
  return lastBlank;
}

export function rewrapParagraph(lines: string[], start: number, leadString: string, context: JustifyContext): number {
  let index = start;
  const leadLen = leadString.length;
  while (breadth(lines[index], context.tabsize) > context.wrapAt) {
    const line = lines[index];
    let breakPos = breakLine(line.slice(leadLen), context.wrapAt - wideness(line, leadLen, context.tabsize), context.tabsize);
    if (breakPos < 0 || leadLen + breakPos === line.length) break;
    breakPos += leadLen + 1;
    lines.splice(index + 1, 0, leadString + line.slice(breakPos));
    if (context.trimblanks) {
      while (breakPos > 0 && line[breakPos - 1] === ' ') breakPos--;
    }
    lines[index] = line.slice(0, breakPos);
    index++;
  }
  return index < lines.length - 1 ? index + 1 : index;
}

export function justifyParagraph(lines: string[], start: number, count: number, context: JustifyContext): number {
  const sample = count === 1 ? lines[start] : lines[start + 1];
  const quoted = quoteLength(sample, context.quote);
  const leadLen = quoted + indentLength(sample.slice(quoted));
  const leadString = sample.slice(0, leadLen);
  concatenateParagraph(lines, start, count, context.quote);
  const first = lines[start];
  lines[start] = squeeze(first, quoted + indentLength(first.slice(quoted)));
  return rewrapParagraph(lines, start, leadString, context);
}
