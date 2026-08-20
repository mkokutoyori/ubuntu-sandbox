export interface DiffFs {
  readFile(path: string): string | null;
  normalizePath(path: string, cwd: string): string;
}

export interface DiffResult {
  output: string;
  exitCode: number;
}

interface Hunk {
  aStart: number;
  aLines: string[];
  bStart: number;
  bLines: string[];
}

export function cmdDiff(fs: DiffFs, cwd: string, args: string[]): DiffResult {
  const paths = args.filter(a => !a.startsWith('-'));
  if (paths.length !== 2) {
    return { output: 'diff: missing operand', exitCode: 2 };
  }
  const contents: string[] = [];
  for (const p of paths) {
    const content = fs.readFile(fs.normalizePath(p, cwd));
    if (content === null) {
      return { output: `diff: ${p}: No such file or directory`, exitCode: 2 };
    }
    contents.push(content);
  }
  const a = splitLines(contents[0]);
  const b = splitLines(contents[1]);
  const hunks = computeHunks(a, b);
  if (hunks.length === 0) return { output: '', exitCode: 0 };
  return { output: hunks.map(renderHunk).join('\n'), exitCode: 1 };
}

function splitLines(content: string): string[] {
  const lines = content.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function computeHunks(a: string[], b: string[]): Hunk[] {
  const lcs = lcsTable(a, b);
  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i++; j++;
      continue;
    }
    const hunk: Hunk = { aStart: i, aLines: [], bStart: j, bLines: [] };
    while (i < a.length && (j >= b.length || lcs[i + 1][j] >= lcs[i][j + 1]) && (j >= b.length || a[i] !== b[j])) {
      hunk.aLines.push(a[i]);
      i++;
    }
    while (j < b.length && (i >= a.length || lcs[i][j + 1] > lcs[i + 1][j]) && (i >= a.length || a[i] !== b[j])) {
      hunk.bLines.push(b[j]);
      j++;
    }
    if (hunk.aLines.length === 0 && hunk.bLines.length === 0) break;
    hunks.push(hunk);
  }
  return hunks;
}

function lcsTable(a: string[], b: string[]): number[][] {
  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  return table;
}

function renderHunk(h: Hunk): string {
  const lines: string[] = [renderHeader(h)];
  for (const l of h.aLines) lines.push(`< ${l}`);
  if (h.aLines.length > 0 && h.bLines.length > 0) lines.push('---');
  for (const l of h.bLines) lines.push(`> ${l}`);
  return lines.join('\n');
}

function renderHeader(h: Hunk): string {
  const aRange = rangeLabel(h.aStart, h.aLines.length);
  const bRange = rangeLabel(h.bStart, h.bLines.length);
  const op = h.aLines.length === 0 ? 'a' : h.bLines.length === 0 ? 'd' : 'c';
  return `${aRange}${op}${bRange}`;
}

function rangeLabel(start: number, count: number): string {
  if (count === 0) return String(start);
  if (count === 1) return String(start + 1);
  return `${start + 1},${start + count}`;
}
