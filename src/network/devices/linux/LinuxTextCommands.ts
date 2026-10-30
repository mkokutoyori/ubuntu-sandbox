/**
 * Text processing commands: grep, head, tail, wc, sort, cut, uniq, tr, awk
 */

import { fileTextToBytes } from '@/crypto/encoding';
import { ShellContext, expandGlob } from './LinuxFileCommands';
import { runAwk, type AwkHost } from './awk';
import { runSed, type SedFileIO } from './sed';
import { compilePosix } from './regex/PosixRegex';
import { PosixRegexError } from './regex/PosixEre';
import { shortOptions } from './commands/Getopt';
import { GNU_OPTION_SETS } from './GnuOptionGuard';

export type GrepVariant = 'grep' | 'egrep' | 'fgrep';

interface GrepFlags {
  caseInsensitive: boolean; countOnly: boolean; recursive: boolean; invert: boolean;
  lineNumbers: boolean; filesOnly: boolean; filesWithout: boolean; wholeWord: boolean;
  wholeLine: boolean; onlyMatching: boolean; quiet: boolean; suppressErrors: boolean;
  forceFilename: boolean | null; extended: boolean; fixed: boolean; perl: boolean;
  maxCount: number; after: number; before: number;
  includeGlobs: string[]; excludeGlobs: string[];
  excludeDirGlobs: string[];
  nullSeparator: boolean; byteOffset: boolean; label: string; directories: 'read' | 'skip' | 'recurse';
  binaryFiles: 'binary' | 'text' | 'without-match'; nullData: boolean; initialTab: boolean;
  contextGiven: boolean; groupSeparator: string | null;
  /**
   * `--color` etait analyse puis JETE — un `continue` sans rien
   * stocker — donc `grep --color=always` rendait exactement la meme
   * sortie que sans, et le motif trouve ne se distinguait de rien.
   */
  color: boolean;
}

/**
 * Ce que GNU grep met autour d'une correspondance : `ms=01;31` dans
 * GREP_COLORS, c'est-a-dire gras rouge. La sequence de fin est `\e[m`
 * (et non `\e[0m`), comme le vrai binaire l'ecrit.
 */
const GREP_MATCH_ON = '\u001b[01;31m\u001b[K';
const GREP_MATCH_OFF = '\u001b[m\u001b[K';

/** Entoure chaque correspondance de la ligne, sans toucher au reste. */
function colorierCorrespondances(ligne: string, matchers: RegExp[]): string {
  const bornes: Array<[number, number]> = [];
  for (const re of matchers) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(ligne)) !== null) {
      if (m[0] !== '') bornes.push([m.index, m.index + m[0].length]);
      else re.lastIndex++;
      if (!re.global) break;
    }
  }
  if (bornes.length === 0) return ligne;
  // Plusieurs motifs (`-e a -e b`) peuvent se recouvrir : les fusionner
  // evite d'imbriquer deux sequences sur les memes caracteres.
  bornes.sort((a, b) => a[0] - b[0]);
  const fusion: Array<[number, number]> = [];
  for (const [d, f] of bornes) {
    const dernier = fusion[fusion.length - 1];
    if (dernier && d <= dernier[1]) dernier[1] = Math.max(dernier[1], f);
    else fusion.push([d, f]);
  }
  let out = '';
  let pos = 0;
  for (const [d, f] of fusion) {
    out += ligne.slice(pos, d) + GREP_MATCH_ON + ligne.slice(d, f) + GREP_MATCH_OFF;
    pos = f;
  }
  return out + ligne.slice(pos);
}

/**
 * `-P` (Perl-compatible regex): JS's native RegExp already covers the
 * common PCRE subset (character classes, quantifiers, groups,
 * alternation, lookaheads/lookbehinds). The one construct it lacks that
 * real-world one-liners actually reach for is `\K` ("keep": discard the
 * match so far, keep matching from here) — translated into the
 * equivalent lookbehind, which JS supports natively (including
 * variable-length lookbehinds).
 */
function compilePcre(
  pattern: string,
  opts: { ignoreCase: boolean; wholeWord: boolean; wholeLine: boolean; global: boolean },
): RegExp {
  let p = pattern;
  const kIndex = p.indexOf('\\K');
  if (kIndex !== -1) {
    p = `(?<=${p.slice(0, kIndex)})${p.slice(kIndex + 2)}`;
  }
  if (opts.wholeWord) p = `\\b(?:${p})\\b`;
  if (opts.wholeLine) p = `^(?:${p})$`;
  let flags = '';
  if (opts.global) flags += 'g';
  if (opts.ignoreCase) flags += 'i';
  return new RegExp(p, flags);
}

const GREP_VERSION = `grep (GNU grep) 3.7
Copyright (C) 2021 Free Software Foundation, Inc.
License GPLv3+: GNU GPL version 3 or later <https://gnu.org/licenses/gpl.html>.
This is free software: you are free to change and redistribute it.
There is NO WARRANTY, to the extent permitted by law.

Written by Mike Haertel and others; see
<https://git.sv.gnu.org/cgit/grep.git/tree/AUTHORS>.`;

const GREP_HELP = `Usage: grep [OPTION]... PATTERNS [FILE]...
Search for PATTERNS in each FILE.
Example: grep -i 'hello world' menu.h main.c
PATTERNS can contain multiple patterns separated by newlines.

Pattern selection and interpretation:
  -E, --extended-regexp     PATTERNS are extended regular expressions
  -F, --fixed-strings       PATTERNS are strings
  -G, --basic-regexp        PATTERNS are basic regular expressions
  -P, --perl-regexp         PATTERNS are Perl regular expressions
  -e, --regexp=PATTERNS     use PATTERNS for matching
  -f, --file=FILE           take PATTERNS from FILE
  -i, --ignore-case         ignore case distinctions in patterns and data
      --no-ignore-case      do not ignore case distinctions (default)
  -w, --word-regexp         match only whole words
  -x, --line-regexp         match only whole lines
  -z, --null-data           a data line ends in 0 byte, not newline

Miscellaneous:
  -s, --no-messages         suppress error messages
  -v, --invert-match        select non-matching lines
  -V, --version             display version information and exit
      --help                display this help text and exit

Output control:
  -m, --max-count=NUM       stop after NUM selected lines
  -b, --byte-offset         print the byte offset with output lines
  -n, --line-number         print line number with output lines
      --line-buffered       flush output on every line
  -H, --with-filename       print file name with output lines
  -h, --no-filename         suppress the file name prefix on output
      --label=LABEL         use LABEL as the standard input file name prefix
  -o, --only-matching       show only nonempty parts of lines that match
  -q, --quiet, --silent     suppress all normal output
      --binary-files=TYPE   assume that binary files are TYPE;
                            TYPE is 'binary', 'text', or 'without-match'
  -a, --text                equivalent to --binary-files=text
  -I                        equivalent to --binary-files=without-match
  -d, --directories=ACTION  how to handle directories;
                            ACTION is 'read', 'recurse', or 'skip'
  -D, --devices=ACTION      how to handle devices, FIFOs and sockets;
                            ACTION is 'read' or 'skip'
  -r, --recursive           like --directories=recurse
  -R, --dereference-recursive  likewise, but follow all symlinks
      --include=GLOB        search only files that match GLOB (a file pattern)
      --exclude=GLOB        skip files that match GLOB
      --exclude-from=FILE   skip files that match any file pattern from FILE
      --exclude-dir=GLOB    skip directories that match GLOB
  -L, --files-without-match  print only names of FILEs with no selected lines
  -l, --files-with-matches  print only names of FILEs with selected lines
  -c, --count               print only a count of selected lines per FILE
  -T, --initial-tab         make tabs line up (if needed)
  -Z, --null                print 0 byte after FILE name

Context control:
  -B, --before-context=NUM  print NUM lines of leading context
  -A, --after-context=NUM   print NUM lines of trailing context
  -C, --context=NUM         print NUM lines of output context
  -NUM                      same as --context=NUM
      --color[=WHEN],
      --colour[=WHEN]       use markers to highlight the matching strings;
                            WHEN is 'always', 'never', or 'auto'
  -U, --binary              do not strip CR characters at EOL (MSDOS/Windows)

When FILE is '-', read standard input.  With no FILE, read '.' if
recursive, '-' otherwise.  With fewer than two FILEs, assume -h.
Exit status is 0 if any line is selected, 1 otherwise;
if any error occurs and -q is not given, the exit status is 2.

Report bugs to: bug-grep@gnu.org
GNU grep home page: <https://www.gnu.org/software/grep/>
General help using GNU software: <https://www.gnu.org/gethelp/>`;

export function cmdGrep(
  ctx: ShellContext, args: string[], stdin?: string, variant: GrepVariant = 'grep',
): { output: string; exitCode: number } {
  const fl: GrepFlags = {
    caseInsensitive: false, countOnly: false, recursive: false, invert: false,
    lineNumbers: false, filesOnly: false, filesWithout: false, wholeWord: false,
    wholeLine: false, onlyMatching: false, quiet: false, suppressErrors: false,
    forceFilename: null, extended: variant === 'egrep', fixed: variant === 'fgrep', perl: false,
    maxCount: Infinity, after: 0, before: 0, includeGlobs: [], excludeGlobs: [], color: false,
    excludeDirGlobs: [], nullSeparator: false, byteOffset: false, label: '(standard input)', directories: 'read',
    binaryFiles: 'binary', nullData: false, initialTab: false, contextGiven: false, groupSeparator: '--',
  };
  const patterns: string[] = [];
  const operands: string[] = [];
  let patternGiven = false;
  let previousWasDigit = false;
  const set = GNU_OPTION_SETS.grep;

  for (const item of shortOptions(args, set.optstring, set.long)) {
    if (item.kind === 'operand') { operands.push(item.value); previousWasDigit = false; continue; }
    if (item.kind !== 'option') continue;
    const value = item.argument ?? '';
    const isDigit = /^[0-9]$/.test(item.letter);
    if (isDigit) {
      const digits = (previousWasDigit ? String(fl.after) : '') + item.letter;
      fl.after = fl.before = parseInt(digits, 10);
      fl.contextGiven = true;
    }
    previousWasDigit = isDigit;
    if (isDigit) continue;
    if (item.letter === '') {
      switch (item.long) {
        case 'help': return { output: GREP_HELP, exitCode: 0 };
        case 'no-ignore-case': fl.caseInsensitive = false; break;
        case 'color': case 'colour': fl.color = !['never', 'no', 'none'].includes(item.argument ?? 'auto'); break;
        case 'label': fl.label = value; break;
        case 'group-separator': fl.groupSeparator = value; break;
        case 'no-group-separator': fl.groupSeparator = null; break;
        case 'binary-files': {
          if (value !== 'binary' && value !== 'text' && value !== 'without-match') return { output: 'grep: unknown binary-files type', exitCode: 2 };
          fl.binaryFiles = value;
          break;
        }
        case 'exclude': fl.excludeGlobs.push(value); break;
        case 'include': fl.includeGlobs.push(value); break;
        case 'exclude-dir': fl.excludeDirGlobs.push(value); break;
        case 'exclude-from': {
          const text = ctx.vfs.readFile(ctx.vfs.normalizePath(value, ctx.cwd));
          if (text === null) return { output: `grep: ${value}: No such file or directory`, exitCode: 2 };
          fl.excludeGlobs.push(...splitInputLines(text));
          break;
        }
        default: break;
      }
      continue;
    }
    switch (item.letter) {
      case 'e': patterns.push(value); patternGiven = true; break;
      case 'f': {
        const text = ctx.vfs.readFile(ctx.vfs.normalizePath(value, ctx.cwd));
        if (text === null) return { output: `grep: ${value}: No such file or directory`, exitCode: 2 };
        addPatternsFromFile(ctx, value, patterns);
        patternGiven = true;
        break;
      }
      case 'm': fl.maxCount = parseInt(value, 10) || 0; break;
      case 'A': fl.after = parseInt(value, 10) || 0; fl.contextGiven = true; break;
      case 'B': fl.before = parseInt(value, 10) || 0; fl.contextGiven = true; break;
      case 'C': fl.after = fl.before = parseInt(value, 10) || 0; fl.contextGiven = true; break;
      case 'a': fl.binaryFiles = 'text'; break;
      case 'I': fl.binaryFiles = 'without-match'; break;
      case 'z': fl.nullData = true; break;
      case 'T': fl.initialTab = true; break;
      case 'd':
        if (value !== 'read' && value !== 'skip' && value !== 'recurse') return { output: `grep: invalid argument '${value}' for '--directories'\nValid arguments are:\n  - 'read'\n  - 'recurse'\n  - 'skip'\nUsage: grep [OPTION]... PATTERNS [FILE]...\nTry 'grep --help' for more information.`, exitCode: 2 };
        fl.directories = value;
        if (value === 'recurse') fl.recursive = true;
        break;
      case 'y': fl.caseInsensitive = true; break;
      case 'Z': fl.nullSeparator = true; break;
      case 'b': fl.byteOffset = true; break;
      case 'V': return { output: GREP_VERSION, exitCode: 0 };
      default: applyShortFlags(item.letter, fl);
    }
  }
  const files: string[] = [];
  const remaining = [...operands];
  if (!patternGiven && remaining.length > 0) { patterns.push(remaining.shift() as string); patternGiven = true; }
  for (const operand of remaining) files.push(...expandGlob(ctx, operand));

  if (!patternGiven) return { output: "Usage: grep [OPTION]... PATTERNS [FILE]...\nTry 'grep --help' for more information.", exitCode: 2 };

  let matchers: RegExp[];
  try {
    matchers = patterns.map(p => fl.perl
      ? compilePcre(p, { ignoreCase: fl.caseInsensitive, wholeWord: fl.wholeWord, wholeLine: fl.wholeLine, global: true })
      : compilePosix(p, {
          extended: fl.extended, fixed: fl.fixed, ignoreCase: fl.caseInsensitive,
          wholeWord: fl.wholeWord, wholeLine: fl.wholeLine, global: true,
        }));
  } catch (error) {
    if (error instanceof PosixRegexError) return { output: `grep: ${error.message}`, exitCode: 2 };
    throw error;
  }
  const lineMatches = (line: string): boolean => {
    const hit = matchers.some(re => { re.lastIndex = 0; return re.test(line); });
    return hit !== fl.invert;
  };

  if (fl.recursive && files.length === 0) files.push('.');

  const run: GrepRun = { fl, matchers, lineMatches, showFilename: false, out: '', printedAny: false };
  let anyMatch = false;
  let errorCount = 0;
  const failWith = (message: string): void => {
    errorCount++;
    if (!fl.suppressErrors) { run.out += `${message}\n`; }
  };
  const finish = (): { output: string; exitCode: number } => ({
    output: fl.nullData ? run.out : run.out.replace(/\n$/, ''),
    exitCode: anyMatch && fl.quiet ? 0 : errorCount > 0 ? 2 : anyMatch ? 0 : 1,
  });
  const listName = (name: string): string => `${grepPaint(fl.color, GREP_FILENAME, name)}${fl.nullSeparator ? '\0' : '\n'}`;

  if (files.length === 0) {
    run.showFilename = fl.forceFilename === true;
    const content = stdin ?? '';
    if (fl.quiet) {
      const lines = splitInputLines(content);
      return { output: '', exitCode: lines.some(lineMatches) ? 0 : 1 };
    }
    if (fl.filesOnly || fl.filesWithout) {
      const has = splitInputLines(content).some(lineMatches);
      if (has) anyMatch = true;
      if ((fl.filesOnly && has) || (fl.filesWithout && !has)) run.out += listName(fl.label);
      return finish();
    }
    if (grepStream(run, content, fl.label) > 0) anyMatch = true;
    return finish();
  }

  const fileList: string[] = [];
  for (const f of files) {
    const absPath = ctx.vfs.normalizePath(f, ctx.cwd);
    const isDirectory = ctx.vfs.getType(absPath) === 'directory';
    if (fl.recursive && isDirectory) collectFiles(ctx, absPath, f, fileList, fl.excludeDirGlobs);
    else if (isDirectory && fl.directories === 'skip') continue;
    else if (isDirectory) { failWith(`grep: ${f}: Is a directory`); continue; }
    else fileList.push(f);
  }
  const filtered = fileList.filter(f => includeExcludeOk(baseName(f), fl));
  const directoryOperand = files.some((f) => ctx.vfs.getType(ctx.vfs.normalizePath(f, ctx.cwd)) === 'directory');
  run.showFilename = fl.forceFilename !== null ? fl.forceFilename : (files.length > 1 || (fl.recursive && directoryOperand));

  for (const f of filtered) {
    const content = ctx.vfs.readFile(ctx.vfs.normalizePath(f, ctx.cwd));
    if (content === null) {
      failWith(`grep: ${f}: No such file or directory`);
      continue;
    }
    if (fl.quiet) {
      if (splitInputLines(content).some(lineMatches)) return { output: '', exitCode: 0 };
      continue;
    }
    if (fl.filesOnly || fl.filesWithout) {
      const has = splitInputLines(content).some(lineMatches);
      if (has) anyMatch = true;
      if ((fl.filesOnly && has) || (fl.filesWithout && !has)) run.out += listName(f);
      continue;
    }
    if (grepStream(run, content, f) > 0) anyMatch = true;
  }
  return finish();
}

function applyShortFlags(flagChars: string, fl: GrepFlags): boolean {
  for (const f of flagChars) {
    switch (f) {
      case 'i': fl.caseInsensitive = true; break;
      case 'c': fl.countOnly = true; break;
      case 'r': case 'R': fl.recursive = true; break;
      case 'E': fl.extended = true; break;
      case 'G': fl.extended = false; break;
      case 'P': fl.perl = true; break;
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
  if (content === '') return;
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

const GREP_SELECTED = '01;31';
const GREP_FILENAME = '35';
const GREP_NUMBER = '32';
const GREP_SEPARATOR = '36';

const grepPaint = (enabled: boolean, code: string, text: string): string =>
  (enabled ? `\u001b[${code}m\u001b[K${text}\u001b[m\u001b[K` : text);

interface GrepRun {
  readonly fl: GrepFlags;
  readonly matchers: RegExp[];
  readonly lineMatches: (line: string) => boolean;
  showFilename: boolean;
  out: string;
  printedAny: boolean;
}

function grepEmit(run: GrepRun, record: string): void {
  run.out += `${record}${run.fl.nullData ? '\0' : '\n'}`;
  run.printedAny = true;
}

function onlyMatchingHits(line: string, matchers: RegExp[]): Array<{ index: number; text: string }> {
  const hits: Array<{ index: number; text: string }> = [];
  let position = 0;
  while (position <= line.length) {
    let best: { index: number; text: string } | null = null;
    for (const re of matchers) {
      re.lastIndex = position;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null && m[0] === '') re.lastIndex = m.index + 1;
      if (m !== null && (best === null || m.index < best.index || (m.index === best.index && m[0].length > best.text.length))) {
        best = { index: m.index, text: m[0] };
      }
    }
    if (best === null) break;
    hits.push(best);
    position = best.index + best.text.length;
  }
  return hits;
}

function grepStream(run: GrepRun, content: string, name: string): number {
  const { fl } = run;
  const binary = !fl.nullData && fl.binaryFiles !== 'text' && content.includes('\0');
  if (binary && fl.binaryFiles === 'without-match') return 0;
  const lines = fl.nullData
    ? (content.endsWith('\0') ? content.slice(0, -1) : content).split('\0')
    : splitInputLines(content);
  const selected: number[] = [];
  for (let i = 0; i < lines.length && selected.length < fl.maxCount; i++) {
    if (run.lineMatches(lines[i])) selected.push(i);
  }
  const nameText = grepPaint(fl.color, GREP_FILENAME, name);
  const separator = (mark: string): string => (fl.nullSeparator ? '\0' : grepPaint(fl.color, GREP_SEPARATOR, mark));
  if (fl.countOnly) {
    run.out += `${run.showFilename ? `${nameText}${separator(':')}` : ''}${selected.length}\n`;
    return selected.length;
  }
  if (binary && selected.length > 0) {
    grepEmit(run, `grep: ${name}: binary file matches`);
    return selected.length;
  }
  const shown = new Set<number>();
  for (const index of selected) {
    for (let j = Math.max(0, index - fl.before); j <= Math.min(lines.length - 1, index + fl.after); j++) shown.add(j);
  }
  const order = [...shown].sort((a, b) => a - b);
  const selectedSet = new Set(selected);
  const offsets: number[] = [];
  if (fl.byteOffset) {
    let at = 0;
    for (const line of lines) { offsets.push(at); at += fileTextToBytes(line).length + 1; }
  }
  const width = fl.initialTab ? String(fileTextToBytes(content).length).length : 0;
  const number = (value: number): string => String(value).padStart(width);
  const head = (index: number, isSelected: boolean, offset: number): string => {
    const mark = isSelected ? ':' : '-';
    let text = '';
    if (run.showFilename) text += `${nameText}${separator(mark)}`;
    if (fl.lineNumbers) text += `${grepPaint(fl.color, GREP_NUMBER, number(index + 1))}${separator(mark)}`;
    if (fl.byteOffset) text += `${grepPaint(fl.color, GREP_NUMBER, number(offset))}${separator(mark)}`;
    return fl.initialTab && text !== '' ? `${text}\t` : text;
  };
  let previous: number | null = null;
  for (const index of order) {
    if (fl.contextGiven && fl.groupSeparator !== null && (previous === null ? run.printedAny : index !== previous + 1)) {
      grepEmit(run, grepPaint(fl.color, GREP_SEPARATOR, fl.groupSeparator));
    }
    previous = index;
    const line = lines[index];
    const isSelected = selectedSet.has(index);
    if (fl.onlyMatching) {
      if (!isSelected || fl.invert) continue;
      for (const hit of onlyMatchingHits(line, run.matchers)) {
        const offset = (offsets[index] ?? 0) + (fl.byteOffset ? fileTextToBytes(line.slice(0, hit.index)).length : 0);
        grepEmit(run, `${head(index, true, offset)}${grepPaint(fl.color, GREP_SELECTED, hit.text)}`);
      }
      continue;
    }
    const colourMatches = fl.color && (isSelected !== fl.invert);
    grepEmit(run, `${head(index, isSelected, offsets[index] ?? 0)}${colourMatches ? colorierCorrespondances(line, run.matchers) : line}`);
  }
  return selected.length;
}

function collectFiles(ctx: ShellContext, absDir: string, displayDir: string, out: string[], excludeDirs: readonly string[] = []): void {
  const entries = ctx.vfs.listDirectory(absDir);
  if (!entries) return;
  for (const e of entries) {
    if (e.name === '.' || e.name === '..') continue;
    const childAbs = absDir + '/' + e.name;
    const childDisplay = displayDir + '/' + e.name;
    if (e.inode.type === 'directory') {
      if (excludeDirs.some((glob) => globToRegExp(glob).test(e.name))) continue;
      collectFiles(ctx, childAbs, childDisplay, out, excludeDirs);
    } else if (e.inode.type === 'file') {
      out.push(childDisplay);
    }
  }
}

/** Version-sort comparator (GNU `sort -V`). Splits into runs of digits
 *  and non-digits, comparing numerically where both runs are numeric. */
export function versionCompare(a: string, b: string): number {
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

export function expandShortOptionClusters(args: readonly string[], withValue: string): string[] {
  const expanded: string[] = [];
  for (const arg of args) {
    if (!/^-[A-Za-z]{2,}/.test(arg)) {
      expanded.push(arg);
      continue;
    }
    for (let index = 1; index < arg.length; index++) {
      const letter = arg[index];
      if (withValue.includes(letter)) {
        expanded.push(`-${letter}${arg.slice(index + 1)}`);
        break;
      }
      expanded.push(`-${letter}`);
    }
  }
  return expanded;
}

export function awkOptionError(args: readonly string[]): string | null {
  const valued = new Set(['-F', '-v', '-f', '-W']);
  let programSeen = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (programSeen) return null;
    if (a === '--') return null;
    if (valued.has(a)) {
      if (i + 1 >= args.length) return `awk: option ${a} lacks argument`;
      i++;
      if (a === '-f') programSeen = true;
      continue;
    }
    if (/^-[FvfW]/.test(a)) {
      if (a.startsWith('-f')) programSeen = true;
      continue;
    }
    if (a === '--version' || a === '--help') continue;
    if (a.startsWith('-') && a.length > 1) return `awk: not an option: ${a}`;
    programSeen = true;
  }
  return null;
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
    // POSIX awk newline-terminates every print — keep the trailing \n so
    // `awk … > file` produces a properly terminated text file (wc -l).
    return result.output;
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
export function cmdSed(
  ctx: ShellContext, args: string[], stdin?: string,
): { output: string; exitCode: number; stderr?: string; interleaved?: string } {
  const io: SedFileIO = {
    readFile: (p) => ctx.vfs.readFile(ctx.vfs.normalizePath(p, ctx.cwd)),
    writeFile: (p, content) => { ctx.vfs.writeFile(ctx.vfs.normalizePath(p, ctx.cwd), content, ctx.uid, ctx.gid, 0o022); },
    appendFile: (p, content) => {
      const abs = ctx.vfs.normalizePath(p, ctx.cwd);
      ctx.vfs.writeFile(abs, (ctx.vfs.readFile(abs) ?? '') + content, ctx.uid, ctx.gid, 0o022);
    },
  };
  const r = runSed({ argv: args, stdin: stdin ?? '', io });
  if (r.error !== null) {
    if (r.exitCode === 0) return { output: `${r.error}\n`, exitCode: 0 };
    const diagnostic = `${r.error}\n`;
    return { output: '', stderr: diagnostic, interleaved: diagnostic, exitCode: r.exitCode };
  }
  if (r.stderr === '') return { output: r.output, exitCode: r.exitCode };
  return { output: r.output, stderr: r.stderr, interleaved: r.stderr + r.output, exitCode: r.exitCode };
}
