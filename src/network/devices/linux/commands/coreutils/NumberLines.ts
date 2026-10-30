import { shortOptions } from '../Getopt';
import { GNU_OPTION_SETS } from '../../GnuOptionGuard';

type Style = { readonly kind: 'all' | 'nonEmpty' | 'none' } | { readonly kind: 'pattern'; readonly pattern: RegExp };
type Format = 'ln' | 'rn' | 'rz';

export interface NumberingPlan {
  readonly files: string[];
  readonly header: Style;
  readonly body: Style;
  readonly footer: Style;
  readonly format: Format;
  readonly width: number;
  readonly separator: string;
  readonly start: number;
  readonly increment: number;
  readonly joinBlank: number;
  readonly renumber: boolean;
  readonly delimiter: string;
}

export type NumberingParse = { readonly plan: NumberingPlan } | { readonly error: string };

function positive(value: string): number | null {
  return /^\d+$/.test(value) && Number(value) > 0 ? Number(value) : null;
}

function integer(value: string): number | null {
  return /^[+-]?\d+$/.test(value) ? Number(value) : null;
}

function style(value: string): Style | null {
  if (value === 'a') return { kind: 'all' };
  if (value === 't') return { kind: 'nonEmpty' };
  if (value === 'n') return { kind: 'none' };
  if (value.startsWith('p') && value.length > 1) {
    try { return { kind: 'pattern', pattern: new RegExp(value.slice(1)) }; } catch { return null; }
  }
  return null;
}

export function parseNumbering(args: readonly string[]): NumberingParse {
  const set = GNU_OPTION_SETS.nl;
  const plan = {
    files: [] as string[], header: { kind: 'none' } as Style, body: { kind: 'nonEmpty' } as Style,
    footer: { kind: 'none' } as Style, format: 'rn' as Format, width: 6, separator: '\t', start: 1,
    increment: 1, joinBlank: 1, renumber: true, delimiter: '\\:',
  };
  for (const item of shortOptions(args, set.optstring, set.long)) {
    if (item.kind === 'operand') { plan.files.push(item.value); continue; }
    if (item.kind !== 'option') continue;
    const value = item.argument ?? '';
    switch (item.letter) {
      case 'b': case 'h': case 'f': {
        const parsed = style(value);
        if (parsed === null) return { error: `nl: invalid ${item.letter === 'b' ? 'body' : item.letter === 'h' ? 'header' : 'footer'} numbering style: '${value}'` };
        if (item.letter === 'b') plan.body = parsed; else if (item.letter === 'h') plan.header = parsed; else plan.footer = parsed;
        break;
      }
      case 'n':
        if (value !== 'ln' && value !== 'rn' && value !== 'rz') return { error: `nl: invalid line numbering format: '${value}'` };
        plan.format = value;
        break;
      case 'w': {
        const width = positive(value);
        if (width === null) return { error: `nl: invalid line number field width: '${value}'` };
        plan.width = width;
        break;
      }
      case 'v': {
        const start = integer(value);
        if (start === null) return { error: `nl: invalid starting line number: '${value}'` };
        plan.start = start;
        break;
      }
      case 'i': {
        const increment = integer(value);
        if (increment === null) return { error: `nl: invalid line number increment: '${value}'` };
        plan.increment = increment;
        break;
      }
      case 'l': {
        const join = positive(value);
        if (join === null) return { error: `nl: invalid line number of blank lines: '${value}'` };
        plan.joinBlank = join;
        break;
      }
      case 'p': plan.renumber = false; break;
      case 's': plan.separator = value; break;
      case 'd': plan.delimiter = value.length === 1 ? `${value}:` : value.slice(0, 2); break;
      default: break;
    }
  }
  return { plan };
}

function formatted(plan: NumberingPlan, number: number): string {
  const digits = String(Math.abs(number));
  if (plan.format === 'ln') return `${number}`.padEnd(plan.width);
  if (plan.format === 'rz') return `${number < 0 ? '-' : ''}${digits.padStart(plan.width - (number < 0 ? 1 : 0), '0')}`;
  return `${number}`.padStart(plan.width);
}

export function numberLines(plan: NumberingPlan, contents: readonly string[], toLines: (content: string) => string[]): string {
  const out: string[] = [];
  const markers = new Map<string, 'header' | 'body' | 'footer'>([
    [plan.delimiter.repeat(3), 'header'], [plan.delimiter.repeat(2), 'body'], [plan.delimiter, 'footer'],
  ]);
  let section: 'header' | 'body' | 'footer' = 'body';
  let next = plan.start;
  let blanks = 0;
  for (const content of contents) {
    for (const line of toLines(content)) {
      const marker = markers.get(line);
      if (marker !== undefined) {
        section = marker;
        if (plan.renumber && marker === 'header') next = plan.start;
        blanks = 0;
        out.push('');
        continue;
      }
      const selected = section === 'header' ? plan.header : section === 'footer' ? plan.footer : plan.body;
      let numbered = false;
      if (selected.kind === 'all') {
        if (line === '') { blanks += 1; numbered = blanks >= plan.joinBlank; if (numbered) blanks = 0; } else { blanks = 0; numbered = true; }
      } else if (selected.kind === 'nonEmpty') numbered = line !== '';
      else if (selected.kind === 'pattern') numbered = selected.pattern.test(line);
      if (!numbered) { out.push(line === '' ? '' : `${' '.repeat(plan.width)}${' '.repeat(plan.separator.length)}${line}`); continue; }
      out.push(`${formatted(plan, next)}${plan.separator}${line}`);
      next += plan.increment;
    }
  }
  return out.join('\n');
}
