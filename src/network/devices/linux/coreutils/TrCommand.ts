import { getoptDiagnostic, shortOptions, type LongOption } from '../commands/Getopt';
import { Streams, docsResult, quoteLocale, usageFailure, type CoreutilsIO, type CoreutilsRun } from './CoreutilsKit';

const LONG_OPTIONS: readonly LongOption[] = [
  { name: 'complement', letter: 'c', takesArgument: false },
  { name: 'delete', letter: 'd', takesArgument: false },
  { name: 'squeeze-repeats', letter: 's', takesArgument: false },
  { name: 'truncate-set1', letter: 't', takesArgument: false },
  { name: 'help', letter: 'H', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
];

class TrError extends Error {
  constructor(message: string, readonly usage = false) { super(message); }
}

const CLASSES: Readonly<Record<string, (byte: number) => boolean>> = {
  alnum: (b) => (b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122),
  alpha: (b) => (b >= 65 && b <= 90) || (b >= 97 && b <= 122),
  blank: (b) => b === 32 || b === 9,
  cntrl: (b) => b < 32 || b === 127,
  digit: (b) => b >= 48 && b <= 57,
  graph: (b) => b > 32 && b < 127,
  lower: (b) => b >= 97 && b <= 122,
  print: (b) => b >= 32 && b < 127,
  punct: (b) => (b > 32 && b < 127) && !((b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122)),
  space: (b) => b === 32 || (b >= 9 && b <= 13),
  upper: (b) => b >= 65 && b <= 90,
  xdigit: (b) => (b >= 48 && b <= 57) || (b >= 65 && b <= 70) || (b >= 97 && b <= 102),
};

const SIMPLE_ESCAPES: Readonly<Record<string, number>> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92 };

type Element =
  | { readonly kind: 'byte'; readonly value: number }
  | { readonly kind: 'range'; readonly from: number; readonly to: number }
  | { readonly kind: 'class'; readonly name: string }
  | { readonly kind: 'repeat'; readonly value: number; readonly count: number | null };

function unescape(source: Buffer): Array<{ value: number; escaped: boolean }> {
  const out: Array<{ value: number; escaped: boolean }> = [];
  for (let i = 0; i < source.length; i++) {
    const byte = source[i];
    if (byte !== 92) { out.push({ value: byte, escaped: false }); continue; }
    const next = source[i + 1];
    if (next === undefined) { out.push({ value: 92, escaped: true }); continue; }
    const letter = String.fromCharCode(next);
    if (letter in SIMPLE_ESCAPES) { out.push({ value: SIMPLE_ESCAPES[letter], escaped: true }); i++; continue; }
    if (next >= 48 && next <= 55) {
      let digits = '';
      let j = i + 1;
      while (digits.length < 3 && source[j] >= 48 && source[j] <= 55) { digits += String.fromCharCode(source[j]); j++; }
      out.push({ value: parseInt(digits, 8) & 0xff, escaped: true });
      i = j - 1;
      continue;
    }
    out.push({ value: next, escaped: true });
    i++;
  }
  return out;
}

function parseElements(text: string): Element[] {
  const chars = unescape(Buffer.from(text, 'utf8'));
  const elements: Element[] = [];
  let i = 0;
  const at = (index: number): number | undefined => chars[index]?.value;
  const plain = (index: number, byte: number): boolean => chars[index] !== undefined && !chars[index].escaped && chars[index].value === byte;
  while (i < chars.length) {
    if (plain(i, 91)) {
      if (plain(i + 1, 58)) {
        let j = i + 2;
        while (j < chars.length && !(plain(j, 58) && plain(j + 1, 93))) j++;
        if (j < chars.length) {
          const name = Buffer.from(chars.slice(i + 2, j).map((c) => c.value)).toString('latin1');
          if (!(name in CLASSES)) throw new TrError(`invalid character class ${quoteLocale(name)}`);
          elements.push({ kind: 'class', name });
          i = j + 2;
          continue;
        }
      }
      if (plain(i + 1, 61)) {
        let j = i + 2;
        while (j < chars.length && !(plain(j, 61) && plain(j + 1, 93))) j++;
        if (j < chars.length && j === i + 3) {
          elements.push({ kind: 'byte', value: chars[i + 2].value });
          i = j + 2;
          continue;
        }
        if (j < chars.length) throw new TrError(`${Buffer.from(chars.slice(i + 2, j).map((c) => c.value)).toString('latin1')}: equivalence class operand must be a single character`);
      }
      if (at(i + 1) !== undefined && plain(i + 2, 42)) {
        let j = i + 3;
        let digits = '';
        while (j < chars.length && !plain(j, 93)) { digits += String.fromCharCode(chars[j].value); j++; }
        if (j < chars.length && /^\d*$/.test(digits)) {
          const count = digits === '' ? null : digits.startsWith('0') ? parseInt(digits, 8) : parseInt(digits, 10);
          elements.push({ kind: 'repeat', value: chars[i + 1].value, count: count === 0 ? null : count });
          i = j + 1;
          continue;
        }
      }
    }
    if (i + 2 < chars.length && plain(i + 1, 45)) {
      const from = chars[i].value;
      const to = chars[i + 2].value;
      if (from > to) {
        throw new TrError(`range-endpoints of '${String.fromCharCode(from)}-${String.fromCharCode(to)}' are in reverse collating sequence order`);
      }
      elements.push({ kind: 'range', from, to });
      i += 3;
      continue;
    }
    elements.push({ kind: 'byte', value: chars[i].value });
    i++;
  }
  return elements;
}

function expand(elements: readonly Element[], limit: number | null): number[] {
  const out: number[] = [];
  for (const element of elements) {
    if (element.kind === 'byte') out.push(element.value);
    else if (element.kind === 'range') for (let b = element.from; b <= element.to; b++) out.push(b);
    else if (element.kind === 'class') for (let b = 0; b < 256; b++) { if (CLASSES[element.name](b)) out.push(b); }
    else {
      const count = element.count ?? (limit === null ? 0 : Math.max(0, limit - out.length));
      for (let n = 0; n < count; n++) out.push(element.value);
    }
  }
  return out;
}

export function runTr(args: readonly string[], io: CoreutilsIO): CoreutilsRun {
  let complement = false;
  let remove = false;
  let squeeze = false;
  let truncate = false;
  const operands: string[] = [];
  for (const item of shortOptions(args, '+cCdst', LONG_OPTIONS)) {
    if (item.kind === 'operand') { operands.push(item.value); continue; }
    if (item.kind !== 'option') return usageFailure('tr', getoptDiagnostic('tr', item));
    switch (item.letter) {
      case 'H': return docsResult('tr', 'help');
      case 'V': return docsResult('tr', 'version');
      case 'c': case 'C': complement = true; break;
      case 'd': remove = true; break;
      case 's': squeeze = true; break;
      case 't': truncate = true; break;
      default: break;
    }
  }
  const fail = (lines: string[]): CoreutilsRun => {
    const streams = new Streams();
    for (const line of lines) streams.diagnostic(line);
    streams.diagnostic("Try 'tr --help' for more information.");
    streams.exitCode = 1;
    return streams.result();
  };
  if (operands.length === 0) return fail(['tr: missing operand']);
  const min = remove && !squeeze ? 1 : squeeze && !remove ? 1 : 2;
  const max = remove && !squeeze ? 1 : 2;
  if (operands.length < min) {
    const reason = remove && squeeze ? 'Two strings must be given when both deleting and squeezing repeats.' : 'Two strings must be given when translating.';
    return fail([`tr: missing operand after ${quoteLocale(operands[operands.length - 1])}`, reason]);
  }
  if (operands.length > max) {
    const reason = remove && !squeeze && operands.length === 2 ? ['Only one string may be given when deleting without squeezing repeats.'] : [];
    return fail([`tr: extra operand ${quoteLocale(operands[max])}`, ...reason]);
  }

  let set1: number[];
  let set2: number[] = [];
  try {
    const elements1 = parseElements(operands[0]);
    if (elements1.some((e) => e.kind === 'repeat')) throw new TrError('the [c*] repeat construct may not appear in string1');
    set1 = expand(elements1, null);
    if (operands.length === 2) {
      const elements2 = parseElements(operands[1]);
      if (!remove || squeeze) {
        const classes = elements2.filter((e) => e.kind === 'class' && e.name !== 'upper' && e.name !== 'lower');
        if (classes.length > 0 && !(remove && squeeze)) throw new TrError("when translating, the only character classes that may appear in\nstring2 are 'upper' and 'lower'");
      }
      if (!remove) {
        elements2.forEach((element, index) => {
          if (element.kind !== 'class' || (element.name !== 'upper' && element.name !== 'lower')) return;
          const mate = elements1[index];
          const opposite = element.name === 'upper' ? 'lower' : 'upper';
          if (mate === undefined || mate.kind !== 'class' || mate.name !== opposite) throw new TrError('misaligned [:upper:] and/or [:lower:] construct');
        });
      }
      set2 = expand(elements2, Math.max(set1.length, 0));
    }
  } catch (error) {
    if (!(error instanceof TrError)) throw error;
    const streams = new Streams();
    for (const line of `tr: ${error.message}`.split('\n')) streams.diagnostic(line);
    if (error.usage) streams.diagnostic("Try 'tr --help' for more information.");
    streams.exitCode = 1;
    return streams.result();
  }

  const complementSet = (set: readonly number[]): number[] => {
    const present = new Set(set);
    const out: number[] = [];
    for (let b = 0; b < 256; b++) if (!present.has(b)) out.push(b);
    return out;
  };
  const source = complement ? complementSet(set1) : set1;
  const deleteSet = new Set<number>(remove ? source : []);
  const mapping = new Map<number, number>();
  if (operands.length === 2 && !(remove && squeeze === false)) {
    if (!remove) {
      let targets = set2;
      let from = source;
      if (truncate) from = source.slice(0, targets.length);
      else if (targets.length < from.length && targets.length > 0) {
        targets = [...targets, ...new Array<number>(from.length - targets.length).fill(targets[targets.length - 1])];
      }
      from.forEach((b, index) => { if (index < targets.length && !mapping.has(b)) mapping.set(b, targets[index]); });
      if (targets.length === 0 && from.length > 0) {
        return usageFailure('tr', 'tr: when not truncating set1, string2 must be non-empty');
      }
    }
  }
  const squeezeTargets = squeeze ? (operands.length === 2 ? new Set(set2) : new Set(source)) : new Set<number>();
  const streams = new Streams();
  if (operands.some((operand) => /(^|[^\\])(\\\\)*\\$/.test(operand))) {
    streams.diagnostic('tr: warning: an unescaped backslash at end of string is not portable');
  }
  const input = Buffer.from(io.stdin ?? '', 'utf8');
  const out: number[] = [];
  let previous = -1;
  for (const byte of input) {
    if (deleteSet.has(byte)) continue;
    const mapped = mapping.has(byte) ? (mapping.get(byte) as number) : byte;
    if (squeeze && squeezeTargets.has(mapped) && mapped === previous) continue;
    out.push(mapped);
    previous = mapped;
  }
  streams.stdout(Buffer.from(out).toString('utf8'));
  return streams.result();
}
