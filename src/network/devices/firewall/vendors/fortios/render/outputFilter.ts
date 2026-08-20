export interface OutputFilter {
  readonly pattern: string;
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

  const words = tail.match(/"[^"]*"|\S+/g) ?? [];
  const rest: string[] = [];
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    const context = /^-([ABC])(\d*)$/.exec(word);
    if (context) {
      const amount = context[2].length > 0
        ? Number(context[2])
        : Number(words[++index] ?? '0');
      if (context[1] !== 'A') before = amount;
      if (context[1] !== 'B') after = amount;
      continue;
    }
    if (/^-[ivcf]+$/.test(word)) {
      ignoreCase ||= word.includes('i');
      invert ||= word.includes('v');
      countOnly ||= word.includes('c');
      wholeBlock ||= word.includes('f');
      continue;
    }
    rest.push(word.replace(/^"|"$/g, ''));
  }

  return {
    pattern: rest.join(' '), ignoreCase, invert, countOnly, wholeBlock, before, after,
  };
}

function matches(line: string, filter: OutputFilter): boolean {
  const hit = filter.ignoreCase
    ? line.toLowerCase().includes(filter.pattern.toLowerCase())
    : line.includes(filter.pattern);
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
