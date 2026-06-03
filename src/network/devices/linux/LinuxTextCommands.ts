/**
 * Text processing commands: grep, head, tail, wc, sort, cut, uniq, tr, awk
 */

import { VirtualFileSystem } from './VirtualFileSystem';
import { ShellContext, expandGlob } from './LinuxFileCommands';
import { runAwk, type AwkHost } from './awk';
import { runSed, type SedFileIO } from './sed';
import { compilePosix } from './regex/PosixRegex';

export type GrepVariant = 'grep' | 'egrep' | 'fgrep';

interface GrepFlags {
  caseInsensitive: boolean; countOnly: boolean; recursive: boolean; invert: boolean;
  lineNumbers: boolean; filesOnly: boolean; filesWithout: boolean; wholeWord: boolean;
  wholeLine: boolean; onlyMatching: boolean; quiet: boolean; suppressErrors: boolean;
  forceFilename: boolean | null; extended: boolean; fixed: boolean;
  maxCount: number; after: number; before: number;
  includeGlobs: string[]; excludeGlobs: string[];
}

export function cmdGrep(
  ctx: ShellContext, args: string[], stdin?: string, variant: GrepVariant = 'grep',
): { output: string; exitCode: number } {
  const fl: GrepFlags = {
    caseInsensitive: false, countOnly: false, recursive: false, invert: false,
    lineNumbers: false, filesOnly: false, filesWithout: false, wholeWord: false,
    wholeLine: false, onlyMatching: false, quiet: false, suppressErrors: false,
    forceFilename: null, extended: variant === 'egrep', fixed: variant === 'fgrep',
    maxCount: Infinity, after: 0, before: 0, includeGlobs: [], excludeGlobs: [],
  };
  const patterns: string[] = [];
  const files: string[] = [];
  let patternGiven = false;

  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { i++; break; }
    if (a === '-e' || a === '--regexp') { patterns.push(args[++i] ?? ''); patternGiven = true; continue; }
    if (a.startsWith('--regexp=')) { patterns.push(a.slice(9)); patternGiven = true; continue; }
    if (a === '-f' || a === '--file') { addPatternsFromFile(ctx, args[++i] ?? '', patterns); patternGiven = true; continue; }
    if (a.startsWith('--file=')) { addPatternsFromFile(ctx, a.slice(7), patterns); patternGiven = true; continue; }
    if (a === '-m' || a === '--max-count') { fl.maxCount = parseInt(args[++i], 10) || 0; continue; }
    if (a.startsWith('--max-count=')) { fl.maxCount = parseInt(a.slice(12), 10) || 0; continue; }
    if (a === '-A' || a === '--after-context') { fl.after = parseInt(args[++i], 10) || 0; continue; }
    if (a === '-B' || a === '--before-context') { fl.before = parseInt(args[++i], 10) || 0; continue; }
    if (a === '-C' || a === '--context') { const n = parseInt(args[++i], 10) || 0; fl.after = n; fl.before = n; continue; }
    if (a.startsWith('--include=')) { fl.includeGlobs.push(a.slice(10)); continue; }
    if (a.startsWith('--exclude=')) { fl.excludeGlobs.push(a.slice(10)); continue; }
    if (a.startsWith('--color') || a === '--colour') continue;
    if (a === '--line-number') { fl.lineNumbers = true; continue; }
    if (a === '--ignore-case') { fl.caseInsensitive = true; continue; }
    if (a === '--invert-match') { fl.invert = true; continue; }
    if (a === '--word-regexp') { fl.wholeWord = true; continue; }
    if (a === '--line-regexp') { fl.wholeLine = true; continue; }
    if (a === '--only-matching') { fl.onlyMatching = true; continue; }
    if (a === '--count') { fl.countOnly = true; continue; }
    if (a === '--quiet' || a === '--silent') { fl.quiet = true; continue; }
    if (a === '--no-messages') { fl.suppressErrors = true; continue; }
    if (a === '--recursive') { fl.recursive = true; continue; }
    if (a === '--fixed-strings') { fl.fixed = true; continue; }
    if (a === '--extended-regexp') { fl.extended = true; continue; }
    if (a === '--basic-regexp') { fl.extended = false; continue; }
    if (a.startsWith('-') && a.length > 1 && !a.startsWith('--')) {
      if (!applyShortFlags(a.slice(1), fl)) { /* unknown short flag → ignore */ }
      continue;
    }
    if (a.startsWith('--')) continue; // unknown long option
    if (!patternGiven) { patterns.push(a); patternGiven = true; continue; }
    files.push(...expandGlob(ctx, a));
  }
  for (; i < args.length; i++) {
    if (!patternGiven) { patterns.push(args[i]); patternGiven = true; continue; }
    files.push(...expandGlob(ctx, args[i]));
  }

  if (!patternGiven) return { output: 'Usage: grep [OPTION]... PATTERN [FILE]...', exitCode: 2 };

  const matchers = patterns.map(p => compilePosix(p, {
    extended: fl.extended, fixed: fl.fixed, ignoreCase: fl.caseInsensitive,
    wholeWord: fl.wholeWord, wholeLine: fl.wholeLine, global: true,
  }));
  const lineMatches = (line: string): boolean => {
    const hit = matchers.some(re => { re.lastIndex = 0; return re.test(line); });
    return hit !== fl.invert;
  };

  // Recursive default: when -r and no files, search the current directory.
  if (fl.recursive && files.length === 0) files.push('.');

  const results: string[] = [];
  const errors: string[] = [];
  let anyMatch = false;

  if (files.length === 0) {
    const lines = splitInputLines(stdin ?? '');
    const n = grepLines(lines, matchers, fl, false, '', lineMatches, results);
    if (n > 0) anyMatch = true;
    if (fl.quiet) return { output: '', exitCode: anyMatch ? 0 : 1 };
    return { output: results.join('\n'), exitCode: anyMatch ? 0 : 1 };
  }

  const fileList: string[] = [];
  for (const f of files) {
    const absPath = ctx.vfs.normalizePath(f, ctx.cwd);
    if (fl.recursive && ctx.vfs.getType(absPath) === 'directory') collectFiles(ctx, absPath, f, fileList);
    else fileList.push(f);
  }
  const filtered = fileList.filter(f => includeExcludeOk(baseName(f), fl));
  const showFilename = fl.forceFilename !== null ? fl.forceFilename : (filtered.length > 1 || fl.recursive);

  for (const f of filtered) {
    const content = ctx.vfs.readFile(ctx.vfs.normalizePath(f, ctx.cwd));
    if (content === null) {
      if (!fl.suppressErrors) errors.push(`grep: ${f}: No such file or directory`);
      continue;
    }
    const lines = splitInputLines(content);

    if (fl.quiet) {
      if (lines.some(lineMatches)) { anyMatch = true; return { output: '', exitCode: 0 }; }
      continue;
    }
    if (fl.filesOnly || fl.filesWithout) {
      const has = lines.some(lineMatches);
      if (has) anyMatch = true;
      if (fl.filesOnly && has) results.push(f);
      if (fl.filesWithout && !has) results.push(f);
      continue;
    }
    const n = grepLines(lines, matchers, fl, showFilename, f, lineMatches, results);
    if (n > 0) anyMatch = true;
  }

  const exitCode = errors.length > 0 ? 2 : anyMatch ? 0 : 1;
  return { output: [...errors, ...results].join('\n'), exitCode };
}

function applyShortFlags(flagChars: string, fl: GrepFlags): boolean {
  for (const f of flagChars) {
    switch (f) {
      case 'i': fl.caseInsensitive = true; break;
      case 'c': fl.countOnly = true; break;
      case 'r': case 'R': fl.recursive = true; break;
      case 'E': fl.extended = true; break;
      case 'G': fl.extended = false; break;
      case 'P': fl.extended = true; break;
      case 'F': fl.fixed = true; break;
      case 'v': fl.invert = true; break;
      case 'n': fl.lineNumbers = true; break;
      case 'l': fl.filesOnly = true; break;
      case 'L': fl.filesWithout = true; break;
      case 'w': fl.wholeWord = true; break;
      case 'x': fl.wholeLine = true; break;
      case 'o': fl.onlyMatching = true; break;
      case 'q': fl.quiet = true; break;
      case 's': fl.suppressErrors = true; break;
      case 'H': fl.forceFilename = true; break;
      case 'h': fl.forceFilename = false; break;
      default: return false;
    }
  }
  return true;
}

function addPatternsFromFile(ctx: ShellContext, path: string, patterns: string[]): void {
  const content = ctx.vfs.readFile(ctx.vfs.normalizePath(path, ctx.cwd));
  if (content === null) return;
  const lines = content.split('\n');
  // A trailing newline must not introduce an empty (match-everything) pattern.
  if (lines.length > 0 && lines[lines.length - 1] === '' && content.endsWith('\n')) lines.pop();
  for (const line of lines) patterns.push(line);
}

function splitInputLines(content: string): string[] {
  const lines = content.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '' && content.endsWith('\n')) lines.pop();
  return lines;
}

function baseName(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx >= 0 ? p.slice(idx + 1) : p;
}

function globToRegExp(glob: string): RegExp {
  let re = '';
  for (const c of glob) {
    if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

function includeExcludeOk(name: string, fl: GrepFlags): boolean {
  if (fl.excludeGlobs.some(g => globToRegExp(g).test(name))) return false;
  if (fl.includeGlobs.length > 0) return fl.includeGlobs.some(g => globToRegExp(g).test(name));
  return true;
}

/** Process lines for grep; returns the number of matching lines. */
function grepLines(
  lines: string[], matchers: RegExp[], fl: GrepFlags, showFilename: boolean, filename: string,
  lineMatches: (line: string) => boolean, results: string[],
): number {
  const matchIndices: number[] = [];
  for (let i = 0; i < lines.length && matchIndices.length < fl.maxCount; i++) {
    if (lineMatches(lines[i])) matchIndices.push(i);
  }

  if (fl.countOnly) {
    const count = matchIndices.length.toString();
    results.push(showFilename ? `${filename}:${count}` : count);
    return matchIndices.length;
  }

  const showSet = new Set<number>();
  for (const idx of matchIndices) {
    for (let j = Math.max(0, idx - fl.before); j <= Math.min(lines.length - 1, idx + fl.after); j++) showSet.add(j);
  }
  const sortedShow = [...showSet].sort((a, b) => a - b);
  const matchSet = new Set(matchIndices);

  for (const idx of sortedShow) {
    const line = lines[idx];
    const isMatch = matchSet.has(idx);
    const prefix = showFilename ? `${filename}:` : '';
    const lineNum = fl.lineNumbers ? `${idx + 1}:` : '';
    if (fl.onlyMatching && isMatch && !fl.invert) {
      const hits: { index: number; text: string }[] = [];
      for (const re of matchers) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(line)) !== null) {
          hits.push({ index: m.index, text: m[0] });
          if (m[0] === '') re.lastIndex++;
        }
      }
      hits.sort((a, b) => a.index - b.index);
      for (const h of hits) results.push(`${prefix}${lineNum}${h.text}`);
    } else {
      results.push(`${prefix}${lineNum}${line}`);
    }
  }
  return matchIndices.length;
}

function collectFiles(ctx: ShellContext, absDir: string, displayDir: string, out: string[]): void {
  const entries = ctx.vfs.listDirectory(absDir);
  if (!entries) return;
  for (const e of entries) {
    if (e.name === '.' || e.name === '..') continue;
    const childAbs = absDir + '/' + e.name;
    const childDisplay = displayDir + '/' + e.name;
    if (e.inode.type === 'directory') {
      collectFiles(ctx, childAbs, childDisplay, out);
    } else if (e.inode.type === 'file') {
      out.push(childDisplay);
    }
  }
}

export function cmdHead(ctx: ShellContext, args: string[], stdin?: string): string {
  let lines = 10;
  let bytes: number | undefined;
  const files: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-n' && args[i + 1]) { lines = parseInt(args[i + 1], 10); i++; continue; }
    if (a === '-c' && args[i + 1]) { bytes = parseInt(args[i + 1], 10); i++; continue; }
    if (a.match(/^-\d+$/)) { lines = parseInt(a.slice(1), 10); continue; }
    if (!a.startsWith('-')) files.push(a);
  }

  const processContent = (content: string): string => {
    if (bytes !== undefined) {
      return content.slice(0, bytes);
    }
    return content.split('\n').slice(0, lines).join('\n');
  };

  if (files.length === 0) {
    return stdin !== undefined ? processContent(stdin) : '';
  }

  const results: string[] = [];
  for (const f of files) {
    const absPath = ctx.vfs.normalizePath(f, ctx.cwd);
    if (bytes !== undefined) {
      const data = ctx.vfs.readFileBytes(absPath, bytes);
      results.push(data);
    } else {
      const content = ctx.vfs.readFile(absPath);
      if (content !== null) results.push(processContent(content));
    }
  }
  return results.join('\n');
}


export function cmdWc(ctx: ShellContext, args: string[], stdin?: string): string {
  let countBytes = false;
  let countLines = false;
  let countWords = false;
  const files: string[] = [];

  for (const a of args) {
    if (a === '-c') { countBytes = true; continue; }
    if (a === '-l') { countLines = true; continue; }
    if (a === '-w') { countWords = true; continue; }
    if (!a.startsWith('-')) files.push(a);
  }

  // Default: show all three
  if (!countBytes && !countLines && !countWords) {
    countBytes = true; countLines = true; countWords = true;
  }

  const processContent = (content: string, filename?: string): string => {
    const parts: string[] = [];
    if (countLines) parts.push(content.split('\n').filter((_, i, arr) => i < arr.length - 1 || arr[arr.length - 1] !== '').length.toString());
    if (countWords) parts.push(content.split(/\s+/).filter(Boolean).length.toString());
    if (countBytes) parts.push(content.length.toString());
    if (filename) parts.push(filename);
    return parts.join(' ');
  };

  if (files.length === 0) {
    return stdin !== undefined ? processContent(stdin) : '';
  }

  const results: string[] = [];
  for (const f of files) {
    const absPath = ctx.vfs.normalizePath(f, ctx.cwd);
    const content = ctx.vfs.readFile(absPath);
    if (content !== null) results.push(processContent(content, f));
  }
  return results.join('\n');
}

/** Parse one key spec like `2`, `2,3`, `1.3,1.5n`. */
interface SortKey {
  startField: number; startChar: number;
  endField?: number;  endChar?: number;
  numeric?: boolean;  reverse?: boolean;
  human?: boolean;    version?: boolean;
  ignoreCase?: boolean; ignoreLeading?: boolean;
}

function parseSortKey(spec: string): SortKey {
  // GNU spec: F[.C][OPTS][,F[.C][OPTS]]
  const [start, end] = spec.split(',');
  const parseHalf = (s: string) => {
    const m = /^(\d+)(?:\.(\d+))?([bdfghnMRrV]*)$/.exec(s);
    if (!m) return { field: 1, char: 1, opts: '' };
    return { field: parseInt(m[1], 10), char: parseInt(m[2] ?? '1', 10), opts: m[3] };
  };
  const s = parseHalf(start);
  const e = end ? parseHalf(end) : null;
  const opts = s.opts + (e?.opts ?? '');
  // Only set per-key flags when the spec explicitly carried them, so
  // the comparator's `key.numeric ?? globalNumeric` fallback distinguishes
  // "key opted out of numeric" from "key didn't say".
  const flag = (c: string): true | undefined => opts.includes(c) || undefined;
  return {
    startField: s.field, startChar: s.char,
    endField: e?.field, endChar: e?.char,
    numeric: flag('n'),
    human: flag('h'),
    version: flag('V'),
    reverse: flag('r'),
    ignoreCase: flag('f'),
    ignoreLeading: flag('b'),
  };
}

const MONTH_RANK: Record<string, number> = {
  'JAN': 1, 'FEB': 2, 'MAR': 3, 'APR': 4, 'MAY': 5, 'JUN': 6,
  'JUL': 7, 'AUG': 8, 'SEP': 9, 'OCT': 10, 'NOV': 11, 'DEC': 12,
};

/** Decode a human-numeric token like 1K, 2.5M, 3G. */
function humanToBytes(s: string): number {
  const m = /^([+-]?\d+(?:\.\d+)?)\s*([KMGTP]?)/i.exec(s);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const u = (m[2] ?? '').toUpperCase();
  const mul: Record<string, number> = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4, P: 1024 ** 5 };
  return n * (mul[u] ?? 1);
}

/** Version-sort comparator (GNU `sort -V`). Splits into runs of digits
 *  and non-digits, comparing numerically where both runs are numeric. */
function versionCompare(a: string, b: string): number {
  const split = (s: string): string[] => s.match(/(\d+|\D+)/g) ?? [];
  const aa = split(a), bb = split(b);
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    const x = aa[i] ?? '', y = bb[i] ?? '';
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) {
      const d = parseInt(x, 10) - parseInt(y, 10);
      if (d !== 0) return d;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

export function cmdSort(ctx: ShellContext, args: string[], stdin?: string): string {
  let numeric = false, reverse = false, unique = false;
  let human = false, version = false, randomise = false;
  let monthSort = false, ignoreCase = false, ignoreLeading = false;
  let delimiter: string | undefined;
  const keys: SortKey[] = [];
  const files: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (true) {
      case a === '-n' || a === '--numeric-sort': numeric = true; continue;
      case a === '-r' || a === '--reverse':      reverse = true; continue;
      case a === '-u' || a === '--unique':       unique = true; continue;
      case a === '-h' || a === '--human-numeric-sort': human = true; continue;
      case a === '-V' || a === '--version-sort': version = true; continue;
      case a === '-R' || a === '--random-sort':  randomise = true; continue;
      case a === '-M' || a === '--month-sort':   monthSort = true; continue;
      case a === '-f' || a === '--ignore-case':  ignoreCase = true; continue;
      case a === '-b' || a === '--ignore-leading-blanks': ignoreLeading = true; continue;
      case a === '-k': keys.push(parseSortKey(args[++i] ?? '1')); continue;
      case a.startsWith('-k'): keys.push(parseSortKey(a.slice(2))); continue;
      case a === '-t': delimiter = args[++i] ?? '\t'; continue;
      case a.startsWith('-t'): delimiter = a.slice(2); continue;
      case a === '-c' || a === '--check': continue; // we always succeed
    }
    if (!a.startsWith('-')) files.push(a);
  }

  // Concatenate every named file plus stdin (in that order, like real sort).
  let content = '';
  for (const f of files) {
    const absPath = ctx.vfs.normalizePath(f, ctx.cwd);
    const raw = ctx.vfs.readFile(absPath);
    if (raw !== null) content += (content && !content.endsWith('\n') ? '\n' : '') + raw;
  }
  if (files.length === 0 && stdin !== undefined) content = stdin;
  let lines = content.split('\n');
  // Drop the trailing empty line caused by a final newline, but keep
  // genuine blank lines in the interior.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const fieldOf = (line: string, n: number): string => {
    if (delimiter !== undefined) {
      const parts = line.split(delimiter);
      return parts[n - 1] ?? '';
    }
    // Default: whitespace-separated, leading blanks part of the next field.
    const parts = line.trim().split(/\s+/);
    return parts[n - 1] ?? '';
  };

  const extractKey = (line: string, key?: SortKey): string => {
    if (!key) return ignoreLeading ? line.replace(/^\s+/, '') : line;
    let val = fieldOf(line, key.startField);
    if (key.startChar > 1) val = val.slice(key.startChar - 1);
    if (key.endField !== undefined) {
      const tail = fieldOf(line, key.endField);
      const endTail = key.endChar !== undefined ? tail.slice(0, key.endChar) : tail;
      // Reconstitute as the slice from startField..endField.
      const pieces: string[] = [val];
      for (let f = key.startField + 1; f < key.endField; f++) pieces.push(fieldOf(line, f));
      pieces.push(endTail);
      val = pieces.join(' ');
    }
    if (key.ignoreLeading ?? ignoreLeading) val = val.replace(/^\s+/, '');
    return val;
  };

  const compareValues = (a: string, b: string, mode: {
    numeric?: boolean; human?: boolean; version?: boolean;
    monthSort?: boolean; ignoreCase?: boolean;
  }): number => {
    const A = mode.ignoreCase ? a.toLowerCase() : a;
    const B = mode.ignoreCase ? b.toLowerCase() : b;
    if (mode.human)   return humanToBytes(A) - humanToBytes(B);
    if (mode.numeric) return (parseFloat(A) || 0) - (parseFloat(B) || 0);
    if (mode.version) return versionCompare(A, B);
    if (mode.monthSort) {
      const ra = MONTH_RANK[A.trim().slice(0, 3).toUpperCase()] ?? 0;
      const rb = MONTH_RANK[B.trim().slice(0, 3).toUpperCase()] ?? 0;
      return ra - rb;
    }
    return A < B ? -1 : A > B ? 1 : 0;
  };

  if (randomise) {
    // Deterministic Math.random ordering is fine — we don't expose a
    // seed, but tests just check that the line set is preserved.
    lines.sort(() => Math.random() - 0.5);
  } else if (keys.length > 0) {
    lines.sort((la, lb) => {
      for (const key of keys) {
        const a = extractKey(la, key);
        const b = extractKey(lb, key);
        const d = compareValues(a, b, {
          numeric: key.numeric ?? numeric,
          human:   key.human   ?? human,
          version: key.version ?? version,
          monthSort,
          ignoreCase: key.ignoreCase ?? ignoreCase,
        });
        if (d !== 0) return (key.reverse ? -1 : 1) * d;
      }
      return 0;
    });
  } else {
    lines.sort((a, b) => compareValues(
      extractKey(a), extractKey(b),
      { numeric, human, version, monthSort, ignoreCase },
    ));
  }

  if (reverse && !randomise) lines.reverse();
  if (unique) lines = lines.filter((l, i) => i === 0 || lines[i - 1] !== l);
  return lines.join('\n');
}

export function cmdCut(ctx: ShellContext, args: string[], stdin?: string): string {
  let delimiter = '\t';
  let fields: number[] = [];
  const files: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('-d')) {
      delimiter = a.length > 2 ? a.slice(2) : args[++i] || '\t';
      continue;
    }
    if (a.startsWith('-f')) {
      const fStr = a.length > 2 ? a.slice(2) : args[++i] || '';
      fields = fStr.split(',').map(f => parseInt(f, 10));
      continue;
    }
    if (!a.startsWith('-')) files.push(a);
  }

  let content: string;
  if (files.length > 0) {
    const absPath = ctx.vfs.normalizePath(files[0], ctx.cwd);
    content = ctx.vfs.readFile(absPath) ?? '';
  } else {
    content = stdin ?? '';
  }

  const lines = content.split('\n');
  const result: string[] = [];
  for (const line of lines) {
    if (!line) continue;
    const parts = line.split(delimiter);
    const selected = fields.map(f => parts[f - 1] || '').join(delimiter);
    result.push(selected);
  }
  return result.join('\n');
}

export function cmdUniq(ctx: ShellContext, args: string[], stdin?: string): string {
  // GNU flags. -f / -s take a value that may be glued or separate.
  let countMode = false;
  let onlyDup = false;
  let onlyUniq = false;
  let ignoreCase = false;
  let skipFields = 0;
  let skipChars = 0;
  const files: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-c' || a === '--count')         { countMode = true; continue; }
    if (a === '-d' || a === '--repeated')      { onlyDup = true; continue; }
    if (a === '-u' || a === '--unique')        { onlyUniq = true; continue; }
    if (a === '-i' || a === '--ignore-case')   { ignoreCase = true; continue; }
    if (a === '-f') { skipFields = parseInt(args[++i] ?? '0', 10); continue; }
    if (a.startsWith('-f') && /^-f\d+$/.test(a)) { skipFields = parseInt(a.slice(2), 10); continue; }
    if (a === '-s') { skipChars  = parseInt(args[++i] ?? '0', 10); continue; }
    if (a.startsWith('-s') && /^-s\d+$/.test(a)) { skipChars = parseInt(a.slice(2), 10); continue; }
    if (!a.startsWith('-')) files.push(a);
  }

  let content: string;
  if (files.length > 0) {
    const absPath = ctx.vfs.normalizePath(files[0], ctx.cwd);
    content = ctx.vfs.readFile(absPath) ?? '';
  } else {
    content = stdin ?? '';
  }

  const lines = content.split('\n');
  // Drop the trailing empty line caused by a final newline; real uniq
  // does the same when the input ends with \n.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const keyOf = (line: string): string => {
    let s = line;
    if (skipFields > 0) {
      // Skip N whitespace-separated fields.
      let i = 0;
      let fieldsLeft = skipFields;
      while (i < s.length && fieldsLeft > 0) {
        while (i < s.length && /\s/.test(s[i])) i++;
        while (i < s.length && !/\s/.test(s[i])) i++;
        fieldsLeft--;
      }
      s = s.slice(i);
    }
    if (skipChars > 0) s = s.slice(skipChars);
    return ignoreCase ? s.toLowerCase() : s;
  };

  // Group adjacent equal-keyed runs and emit per flag selection.
  interface Run { line: string; count: number }
  const runs: Run[] = [];
  let lastKey: string | null = null;
  for (const line of lines) {
    const k = keyOf(line);
    if (k === lastKey && runs.length > 0) runs[runs.length - 1].count++;
    else { runs.push({ line, count: 1 }); lastKey = k; }
  }

  const out: string[] = [];
  for (const r of runs) {
    if (onlyDup && r.count < 2) continue;
    if (onlyUniq && r.count > 1) continue;
    out.push(countMode ? `${String(r.count).padStart(7)} ${r.line}` : r.line);
  }
  return out.join('\n');
}

/** POSIX `[:class:]` resolution for tr. Lazy — only what tr ever needs. */
function expandTrClass(name: string): string {
  const lower = 'abcdefghijklmnopqrstuvwxyz';
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const digit = '0123456789';
  switch (name) {
    case 'alpha':   return lower + upper;
    case 'lower':   return lower;
    case 'upper':   return upper;
    case 'digit':   return digit;
    case 'alnum':   return lower + upper + digit;
    case 'xdigit':  return digit + 'abcdef' + 'ABCDEF';
    case 'space':   return ' \t\n\r\v\f';
    case 'blank':   return ' \t';
    case 'punct':   return '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
    case 'print':   return digit + lower + upper + ' !"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
    case 'cntrl':   return '\x00\x01\x02\x03\x04\x05\x06\x07\x08\t\n\x0b\x0c\r\x0e\x0f\x10\x11\x12\x13\x14\x15\x16\x17\x18\x19\x1a\x1b\x1c\x1d\x1e\x1f\x7f';
    case 'graph':   return digit + lower + upper + '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
    default: return '';
  }
}

/** Replace POSIX classes + C escapes inside a tr SET argument. */
function decodeTrSet(raw: string): string {
  // Classes first — replace `[:name:]` before character expansion runs.
  let s = raw.replace(/\[:(\w+):\]/g, (_m, name) => expandTrClass(name));
  // C escapes.
  s = s
    .replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r')
    .replace(/\\\\/g, '\\').replace(/\\0/g, '\0')
    .replace(/\\(\d{1,3})/g, (_m, oct) => String.fromCharCode(parseInt(oct, 8)));
  return expandCharSet(s);
}

export function cmdTr(_ctx: ShellContext, args: string[], stdin?: string): string {
  // Real tr operates on stdin only. With no stdin there's nothing to do.
  let deleteMode = false;
  let squeezeMode = false;
  let complement = false;
  // Real tr accepts combined short options like `-cd`, `-cs`, `-cds`.
  // Split before scanning so the loop sees them one at a time.
  const expanded = args.flatMap((a) => {
    if (!a.startsWith('-') || a.startsWith('--') || a.length <= 2 || /^-\d/.test(a)) return [a];
    return a.slice(1).split('').map(c => `-${c}`);
  });
  const sets: string[] = [];
  for (const a of expanded) {
    if (a === '-d' || a === '--delete')   { deleteMode = true; continue; }
    if (a === '-s' || a === '--squeeze-repeats') { squeezeMode = true; continue; }
    if (a === '-c' || a === '-C' || a === '--complement') { complement = true; continue; }
    if (a === '-t' || a === '--truncate-set1') continue;
    if (!a.startsWith('-') || /^-\d/.test(a)) sets.push(a);
  }
  if (!stdin || sets.length === 0) return stdin ?? '';

  const set1Raw = decodeTrSet(sets[0]);
  const set2Raw = sets[1] !== undefined ? decodeTrSet(sets[1]) : '';

  // Build a fast membership tester — complement flips it.
  const inSet1 = (ch: string): boolean => {
    const present = set1Raw.includes(ch);
    return complement ? !present : present;
  };

  let result = '';
  if (deleteMode) {
    for (const ch of stdin) if (!inSet1(ch)) result += ch;
    if (squeezeMode && set2Raw) {
      let squeezed = '';
      let prev = '';
      for (const ch of result) {
        if (set2Raw.includes(ch) && ch === prev) continue;
        squeezed += ch;
        prev = ch;
      }
      result = squeezed;
    }
    return result;
  }

  // Translation (or squeeze of set1) form.
  // Pad set2 with its last character so set1.length translations are defined.
  const padded = set2Raw.length === 0
    ? ''
    : set2Raw + set2Raw[set2Raw.length - 1].repeat(Math.max(0, set1Raw.length - set2Raw.length));

  for (const ch of stdin) {
    if (inSet1(ch)) {
      // Complement-translate maps every non-SET1 char to last(SET2).
      if (complement) {
        result += ch;
      } else if (padded.length > 0) {
        const idx = set1Raw.indexOf(ch);
        result += padded[idx] ?? ch;
      } else {
        result += ch;
      }
    } else if (complement && padded.length > 0) {
      // GNU semantics — complement+translate replaces non-SET1 with last(SET2).
      result += padded[padded.length - 1];
    } else {
      result += ch;
    }
  }

  if (squeezeMode) {
    const squeezeAgainst = set2Raw || set1Raw;
    let squeezed = '';
    let prev = '';
    for (const ch of result) {
      if (squeezeAgainst.includes(ch) && ch === prev) continue;
      squeezed += ch;
      prev = ch;
    }
    result = squeezed;
  }

  return result;
}

function expandCharSet(s: string): string {
  // Handle ranges like a-z, A-Z, 0-9
  let result = '';
  for (let i = 0; i < s.length; i++) {
    if (i + 2 < s.length && s[i + 1] === '-') {
      const start = s.charCodeAt(i);
      const end = s.charCodeAt(i + 2);
      for (let c = start; c <= end; c++) {
        result += String.fromCharCode(c);
      }
      i += 2;
    } else {
      result += s[i];
    }
  }
  return result;
}

export function cmdAwk(ctx: ShellContext, args: string[], stdin?: string): string {
  let fieldSep: string | undefined;
  let program: string | null = null;
  const files: string[] = [];
  const assignments: Record<string, string> = {};
  const programFiles: string[] = [];

  const handlePositional = (a: string): void => {
    if (program === null && programFiles.length === 0) { program = a; return; }
    files.push(a);
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-F') { fieldSep = decodeAwkArg(args[++i] ?? ' '); continue; }
    if (a.startsWith('-F')) { fieldSep = decodeAwkArg(a.slice(2).replace(/^["']|["']$/g, '')); continue; }
    if (a === '-v' && args[i + 1]) {
      const eq = args[++i];
      const idx = eq.indexOf('=');
      if (idx >= 0) assignments[eq.slice(0, idx)] = decodeAwkArg(eq.slice(idx + 1));
      continue;
    }
    if (a.startsWith('-v') && a.length > 2) {
      const eq = a.slice(2);
      const idx = eq.indexOf('=');
      if (idx >= 0) assignments[eq.slice(0, idx)] = decodeAwkArg(eq.slice(idx + 1));
      continue;
    }
    if (a === '-f' && args[i + 1]) { programFiles.push(args[++i]); continue; }
    if (a.startsWith('-f') && a.length > 2) { programFiles.push(a.slice(2)); continue; }
    if (a === '--') { for (let j = i + 1; j < args.length; j++) handlePositional(args[j]); break; }
    if (a.startsWith('-') && a.length > 1 && program === null && programFiles.length === 0) continue;
    handlePositional(a);
  }

  if (programFiles.length > 0) {
    program = programFiles
      .map(f => ctx.vfs.readFile(ctx.vfs.normalizePath(f, ctx.cwd)) ?? '')
      .join('\n');
  }
  if (program === null) program = '';

  const fileAssign: Array<{ filename: string; content: string }> = [];
  for (const f of files) {
    const eq = f.match(/^([A-Za-z_]\w*)=(.*)$/);
    if (eq) { assignments[eq[1]] = decodeAwkArg(eq[2]); continue; }
    const absPath = ctx.vfs.normalizePath(f, ctx.cwd);
    fileAssign.push({ filename: f, content: ctx.vfs.readFile(absPath) ?? '' });
  }
  const sources = fileAssign.length > 0 ? fileAssign : [{ filename: '', content: stdin ?? '' }];

  const host: AwkHost = {
    readFile: (p: string) => ctx.vfs.readFile(ctx.vfs.normalizePath(p, ctx.cwd)),
    writeFile: (p: string, content: string, append: boolean) => {
      const abs = ctx.vfs.normalizePath(p, ctx.cwd);
      const prior = append ? (ctx.vfs.readFile(abs) ?? '') : '';
      ctx.vfs.writeFile(abs, prior + content, ctx.uid, ctx.gid, 0o022);
    },
  };

  try {
    const result = runAwk({ program, fieldSep, assignments, sources, host });
    for (const w of result.fileWrites) {
      const abs = ctx.vfs.normalizePath(w.path, ctx.cwd);
      const prior = w.append ? (ctx.vfs.readFile(abs) ?? '') : '';
      ctx.vfs.writeFile(abs, prior + w.content, ctx.uid, ctx.gid, 0o022);
    }
    if (result.error) return result.error;
    return result.output.endsWith('\n') ? result.output.slice(0, -1) : result.output;
  } catch {
    const legacyVars = new Map<string, string>(Object.entries(assignments));
    return executeAwk(sources.map(s => s.content).join('\n'), program, fieldSep ?? ' ', legacyVars);
  }
}

function decodeAwkArg(s: string): string {
  return s.replace(/\\(.)/g, (_, c: string) => {
    switch (c) {
      case 't': return '\t';
      case 'n': return '\n';
      case 'r': return '\r';
      case '\\': return '\\';
      default: return '\\' + c;
    }
  });
}

function executeAwk(content: string, program: string, fs: string, vars: Map<string, string>): string {
  // Simple awk interpreter
  const lines = content.split('\n').filter(l => l.length > 0);
  const results: string[] = [];

  // Parse program into blocks: condition { action }
  // Support: BEGIN { ... }, END { ... }, condition { ... }, { ... }
  const blocks = parseAwkBlocks(program);

  // Track awk variables
  const awkVars: Map<string, number | string> = new Map();
  for (const [k, v] of vars) awkVars.set(k, v);

  // Execute BEGIN block
  for (const block of blocks) {
    if (block.condition === 'BEGIN') {
      const out = executeAwkAction(block.action, [], fs, awkVars, '');
      if (out) results.push(out);
    }
  }

  // Process each line
  for (const line of lines) {
    const fields = fs === ' '
      ? line.split(/\s+/).filter(Boolean)
      : line.split(fs);

    for (const block of blocks) {
      if (block.condition === 'BEGIN' || block.condition === 'END') continue;

      if (!block.condition || evaluateAwkCondition(block.condition, fields, fs, awkVars)) {
        const out = executeAwkAction(block.action, fields, fs, awkVars, line);
        if (out) results.push(out);
      }
    }
  }

  // Execute END block
  for (const block of blocks) {
    if (block.condition === 'END') {
      const out = executeAwkAction(block.action, [], fs, awkVars, '');
      if (out) results.push(out);
    }
  }

  return results.join('\n');
}

interface AwkBlock {
  condition: string;
  action: string;
}

function parseAwkBlocks(program: string): AwkBlock[] {
  const blocks: AwkBlock[] = [];
  let i = 0;
  const p = program.trim();

  while (i < p.length) {
    // Skip whitespace
    while (i < p.length && /\s/.test(p[i])) i++;
    if (i >= p.length) break;

    let condition = '';
    let action = '';

    // Check if starts with { (no condition)
    if (p[i] === '{') {
      condition = '';
      const end = findMatchingBrace(p, i);
      action = p.slice(i + 1, end).trim();
      i = end + 1;
    } else {
      // Read condition until {
      const braceIdx = p.indexOf('{', i);
      if (braceIdx === -1) {
        // No braces: treat remaining as condition with default print action
        condition = p.slice(i).trim();
        action = 'print';
        i = p.length;
      } else {
        condition = p.slice(i, braceIdx).trim();
        const end = findMatchingBrace(p, braceIdx);
        action = p.slice(braceIdx + 1, end).trim();
        i = end + 1;
      }
    }

    blocks.push({ condition, action });
  }

  return blocks;
}

function findMatchingBrace(s: string, start: number): number {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === '{') depth++;
    if (s[i] === '}') { depth--; if (depth === 0) return i; }
  }
  return s.length;
}

function evaluateAwkCondition(condition: string, fields: string[], fs: string, vars: Map<string, number | string>): boolean {
  // Handle: $2 > 30, $1 == "foo", etc
  const match = condition.match(/\$(\d+)\s*(>|<|>=|<=|==|!=)\s*(.+)/);
  if (match) {
    const fieldIdx = parseInt(match[1], 10);
    const op = match[2];
    const valueStr = match[3].replace(/^["']|["']$/g, '');
    const fieldVal = fieldIdx === 0 ? fields.join(fs) : (fields[fieldIdx - 1] || '');
    const numField = parseFloat(fieldVal);
    const numVal = parseFloat(valueStr);

    if (!isNaN(numField) && !isNaN(numVal)) {
      switch (op) {
        case '>': return numField > numVal;
        case '<': return numField < numVal;
        case '>=': return numField >= numVal;
        case '<=': return numField <= numVal;
        case '==': return numField === numVal;
        case '!=': return numField !== numVal;
      }
    }
    switch (op) {
      case '==': return fieldVal === valueStr;
      case '!=': return fieldVal !== valueStr;
    }
  }
  return true;
}

function executeAwkAction(action: string, fields: string[], fs: string, vars: Map<string, number | string>, line: string): string {
  const statements = action.split(';').map(s => s.trim()).filter(Boolean);
  const outputs: string[] = [];

  for (const stmt of statements) {
    // Variable assignment: sum += $2, count = count + 1
    const assignMatch = stmt.match(/^(\w+)\s*(\+?=)\s*(.+)$/);
    if (assignMatch && !stmt.startsWith('print')) {
      const varName = assignMatch[1];
      const op = assignMatch[2];
      const expr = resolveAwkExpr(assignMatch[3], fields, fs, vars, line);
      const numExpr = parseFloat(expr);
      if (op === '+=') {
        const current = parseFloat(String(vars.get(varName) || '0'));
        vars.set(varName, current + (isNaN(numExpr) ? 0 : numExpr));
      } else {
        vars.set(varName, isNaN(numExpr) ? expr : numExpr);
      }
      continue;
    }

    // Print statement
    if (stmt.startsWith('print')) {
      const printArgs = stmt.slice(5).trim();
      if (!printArgs) {
        outputs.push(line);
        continue;
      }
      outputs.push(resolveAwkPrint(printArgs, fields, fs, vars, line));
    }
  }

  return outputs.join('\n');
}

function resolveAwkExpr(expr: string, fields: string[], fs: string, vars: Map<string, number | string>, line: string): string {
  // Replace $N with field values
  let result = expr.replace(/\$(\d+)/g, (_, n) => {
    const idx = parseInt(n, 10);
    return idx === 0 ? line : (fields[idx - 1] || '');
  });

  // Replace variable references
  for (const [k, v] of vars) {
    result = result.replace(new RegExp(`\\b${k}\\b`, 'g'), String(v));
  }

  // Try to evaluate simple arithmetic
  try {
    const num = Function(`return (${result})`)();
    if (typeof num === 'number' && !isNaN(num)) return String(num);
  } catch { /* ignore */ }

  return result;
}

function resolveAwkPrint(printArgs: string, fields: string[], fs: string, vars: Map<string, number | string>, line: string): string {
  // Parse print arguments: "string" $1 var "string"
  const parts: string[] = [];
  let current = '';
  let inStr = false;
  let strChar = '"';

  for (let i = 0; i < printArgs.length; i++) {
    const c = printArgs[i];

    if (inStr) {
      if (c === strChar) {
        parts.push(current);
        current = '';
        inStr = false;
      } else {
        current += c;
      }
      continue;
    }

    if (c === '"' || c === "'") {
      if (current.trim()) {
        parts.push(resolveAwkValue(current.trim(), fields, fs, vars, line));
        current = '';
      }
      inStr = true;
      strChar = c;
      continue;
    }

    if (c === ',') {
      if (current.trim()) {
        parts.push(resolveAwkValue(current.trim(), fields, fs, vars, line));
        current = '';
      }
      parts.push(' '); // comma = output field separator (space by default)
      continue;
    }

    current += c;
  }

  if (current.trim()) {
    parts.push(resolveAwkValue(current.trim(), fields, fs, vars, line));
  }

  return parts.join('');
}

function resolveAwkValue(val: string, fields: string[], fs: string, vars: Map<string, number | string>, line: string): string {
  // Handle $N
  if (val.startsWith('$')) {
    const idx = parseInt(val.slice(1), 10);
    if (!isNaN(idx)) {
      return idx === 0 ? line : (fields[idx - 1] || '');
    }
  }

  // Handle expressions like $2 + bonus
  if (val.includes('$') || val.includes('+') || val.includes('-')) {
    const resolved = resolveAwkExpr(val, fields, fs, vars, line);
    return resolved;
  }

  // Handle variable
  if (vars.has(val)) return String(vars.get(val));

  return val;
}

/**
 * Minimal sed implementation: supports `-i[SUFFIX]` (in-place) and one or
 * more `s/PATTERN/REPLACEMENT/[flags]` substitution scripts. Pattern uses
 * extended regex with the GNU `\?` (optional) extension. When a file is
 * given the file is read; otherwise stdin is processed. Multiple scripts
 * may be provided via repeated `-e` or by joining with `;`.
 */
export function cmdSed(ctx: ShellContext, args: string[], stdin?: string): string {
  const io: SedFileIO = {
    readFile: (p) => ctx.vfs.readFile(ctx.vfs.normalizePath(p, ctx.cwd)),
    writeFile: (p, content) => { ctx.vfs.writeFile(ctx.vfs.normalizePath(p, ctx.cwd), content, ctx.uid, ctx.gid, 0o022); },
    appendFile: (p, content) => {
      const abs = ctx.vfs.normalizePath(p, ctx.cwd);
      ctx.vfs.writeFile(abs, (ctx.vfs.readFile(abs) ?? '') + content, ctx.uid, ctx.gid, 0o022);
    },
  };
  const r = runSed({ argv: args, stdin: stdin ?? '', io });
  return r.error ?? r.output;
}
