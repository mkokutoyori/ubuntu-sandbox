export interface OutputFilter {
  readonly patterns: readonly string[];
  readonly ignoreCase: boolean;
  readonly invert: boolean;
  readonly countOnly: boolean;
  readonly wholeBlock: boolean;
  readonly before: number;
  readonly after: number;
}

export interface FilteredLine {
  readonly command: string;
  readonly filter: OutputFilter | null;
  readonly error: string | null;
}

const PIPE = /\s\|\s*grep\s+/;

export function splitPipe(line: string): FilteredLine {
  const at = line.search(PIPE);
  if (at < 0) return { command: line, filter: null, error: null };

  const command = line.slice(0, at).trim();
  const tail = line.slice(at).replace(PIPE, '').trim();
  if (tail.length === 0) {
    return { command, filter: null, error: 'grep: no pattern given' };
  }
  return { command, filter: parseGrep(tail), error: null };
}

function parseGrep(tail: string): OutputFilter {
  let ignoreCase = false;
  let invert = false;
  let countOnly = false;
  let wholeBlock = false;
  let before = 0;
  let after = 0;

  const patterns: string[] = [];
  let rest = tail;
  for (;;) {
    const option = /^(-[A-Za-z]+)(\d*)\s*/.exec(rest);
    if (!option) break;
    if (option[1] === '-e') {
      rest = rest.slice(option[0].length);
      const value = /^("[^"]*"|\S+)\s*/.exec(rest);
      if (!value) break;
      patterns.push(unquotePattern(value[1]));
      rest = rest.slice(value[0].length);
      continue;
    }
    const context = /^-([ABC])$/.exec(option[1]);
    if (context) {
      rest = rest.slice(option[0].length);
      let amount = option[2].length > 0 ? Number(option[2]) : 0;
      if (amount === 0) {
        const number = /^(\d+)\s*/.exec(rest);
        if (number) { amount = Number(number[1]); rest = rest.slice(number[0].length); }
      }
      if (context[1] !== 'A') before = amount;
      if (context[1] !== 'B') after = amount;
      continue;
    }
    if (!/^-[ivcf]+$/.test(option[1])) break;
    ignoreCase ||= option[1].includes('i');
    invert ||= option[1].includes('v');
    countOnly ||= option[1].includes('c');
    wholeBlock ||= option[1].includes('f');
    rest = rest.slice(option[0].length);
  }

  const trailing = rest.trim();
  if (trailing.length > 0) patterns.push(unquotePattern(trailing));
  return { patterns, ignoreCase, invert, countOnly, wholeBlock, before, after };
}

function unquotePattern(raw: string): string {
  const stripped = raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2
    ? raw.slice(1, -1)
    : raw;
  return stripped.replace(/\\"/g, '"');
}

function matches(line: string, filter: OutputFilter): boolean {
  const subject = filter.ignoreCase ? line.toLowerCase() : line;
  const hit = filter.patterns.some(pattern =>
    subject.includes(filter.ignoreCase ? pattern.toLowerCase() : pattern));
  return filter.invert ? !hit : hit;
}

export function applyFilter(text: string, filter: OutputFilter): string {
  const lines = text.split('\n');
  if (filter.wholeBlock) return blocksMatching(lines, filter).join('\n');

  const keep = new Set<number>();
  let count = 0;
  for (let index = 0; index < lines.length; index++) {
    if (!matches(lines[index], filter)) continue;
    count++;
    for (let at = index - filter.before; at <= index + filter.after; at++) {
      if (at >= 0 && at < lines.length) keep.add(at);
    }
  }
  if (filter.countOnly) return String(count);
  return lines.filter((_line, index) => keep.has(index)).join('\n');
}

function blocksMatching(lines: readonly string[], filter: OutputFilter): string[] {
  const out: string[] = [];
  let block: string[] = [];
  let hit = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('edit ')) {
      block = [line];
      hit = matches(line, filter);
      continue;
    }
    if (block.length === 0) continue;

    block.push(line);
    if (matches(line, filter)) hit = true;
    if (trimmed === 'next') {
      if (hit) out.push(...block);
      block = [];
      hit = false;
    }
  }
  return out;
}
