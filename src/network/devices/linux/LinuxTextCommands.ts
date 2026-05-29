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

export function cmdTail(ctx: ShellContext, args: string[], stdin?: string): string {
  let lines = 10;
  let follow = false;
  const files: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-n' && args[i + 1]) { lines = parseInt(args[i + 1], 10); i++; continue; }
    if (a === '-f') { follow = true; continue; }
    if (a.match(/^-\d+$/)) { lines = parseInt(a.slice(1), 10); continue; }
    if (!a.startsWith('-')) files.push(a);
  }

  const processContent = (content: string): string => {
    const allLines = content.split('\n');
    // Remove trailing empty line if content ends with \n
    if (allLines.length > 0 && allLines[allLines.length - 1] === '') allLines.pop();
    return allLines.slice(-lines).join('\n');
  };

  if (files.length === 0) {
    return stdin !== undefined ? processContent(stdin) : '';
  }

  const results: string[] = [];
  for (const f of files) {
    const absPath = ctx.vfs.normalizePath(f, ctx.cwd);
    const content = ctx.vfs.readFile(absPath);
    if (content !== null) results.push(processContent(content));
  }
  // tail -f just returns content for our simulator
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

export function cmdSort(ctx: ShellContext, args: string[], stdin?: string): string {
  let numeric = false;
  let reverse = false;
  const files: string[] = [];

  for (const a of args) {
    if (a === '-n') { numeric = true; continue; }
    if (a === '-r') { reverse = true; continue; }
    if (!a.startsWith('-')) files.push(a);
  }

  let content: string;
  if (files.length > 0) {
    const absPath = ctx.vfs.normalizePath(files[0], ctx.cwd);
    content = ctx.vfs.readFile(absPath) ?? '';
  } else {
    content = stdin ?? '';
  }

  let lines = content.split('\n').filter(l => l.length > 0);

  if (numeric) {
    lines.sort((a, b) => parseFloat(a) - parseFloat(b));
  } else {
    lines.sort();
  }

  if (reverse) lines.reverse();
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
  const files: string[] = [];
  for (const a of args) {
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
  let prevLine: string | null = null;
  for (const line of lines) {
    if (line !== prevLine) {
      result.push(line);
      prevLine = line;
    }
  }
  // Remove trailing empty line
  while (result.length > 0 && result[result.length - 1] === '') result.pop();
  return result.join('\n');
}

export function cmdTr(ctx: ShellContext, args: string[], stdin?: string): string {
  if (args.length < 2 || !stdin) return stdin ?? '';

  const set1 = expandCharSet(args[0]);
  const set2 = expandCharSet(args[1]);

  let result = '';
  for (const c of stdin) {
    const idx = set1.indexOf(c);
    if (idx !== -1 && idx < set2.length) {
      result += set2[idx];
    } else {
      result += c;
    }
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
