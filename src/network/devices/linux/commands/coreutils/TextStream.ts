/**
 * Utilitaires de flux de texte : tac, nl, paste, comm, fold, expand,
 * unexpand, fmt, pr, column, cmp, split, base64, cksum.
 *
 * Tous absents jusqu'ici, et tous réclamés par les transcripts de debug
 * (`debug-output/linux/*text-pipes*`, une trentaine de refus par
 * fichier). Ce sont des fonctions pures sur un flux ou un fichier : il
 * n'y a rien à simuler, seulement à calculer.
 *
 * Ils sont déclarés en `LinuxCommand` plutôt qu'ajoutés au `switch` de
 * `LinuxCommandExecutor`, et suivent en cela `Xxd.ts` : le registre
 * porte l'usage, l'aide, les options et la complétion en un seul
 * endroit. Comme lui, `needsNetworkContext: true` ne parle pas de
 * réseau — c'est la convention de ce dépôt pour « dispatcher par le
 * registre ».
 *
 * L'entrée canalisée, elle, arrive sur son propre canal : ces commandes
 * déclarent `readsStdin` et la reçoivent en paramètre. Sans ce canal,
 * `printf abc | tac` et `tac fichier` sont un seul et même argument de
 * queue, et rien ne permet de les distinguer.
 */

import { simulationDate } from '@/network/core/SystemClock';

import { base64ToBytes, bytesToBase64, bytesToFileText, fileTextToBytes } from '@/crypto/encoding';
import type { LinuxCommand } from '../LinuxCommand';
import { asDispatch, type CoreutilsIO, type CoreutilsRun } from '../../coreutils/CoreutilsKit';
import { coreutilsIO } from '../../coreutils/CoreutilsFiles';
import { runTac } from '../../coreutils/TacCommand';
import { runSplit } from '../../coreutils/SplitCommand';
import { runNl } from '../../coreutils/NlCommand';
import { runPaste } from '../../coreutils/PasteCommand';
import { runComm } from '../../coreutils/CommCommand';
import { runFold } from '../../coreutils/FoldCommand';
import { runExpand, runUnexpand } from '../../coreutils/TabCommands';
import { numberLines, parseNumbering } from './NumberLines';
import { parseLessLaunch } from '../../editors/lessLaunch';
import { shortOptions } from '../Getopt';
import { GNU_OPTION_SETS } from '../../GnuOptionGuard';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { padToWidth, renderTableText, type TableColumn } from '@/network/devices/shells/cli/TextTable';

/**
 * Défait les options courtes agglutinées, comme le fait `getopt` : `-sw 9`
 * devient `-s -w 9`, `-w9` devient `-w 9`, `-tn` devient `-t -n`.
 *
 * `flags` liste les lettres reconnues, `valued` celles qui consomment une
 * valeur — le reste de l'agglutinat le cas échéant, sinon le mot suivant.
 * Un caractère inconnu fait renoncer : le mot est rendu tel quel, et
 * `fmt -10` garde sa forme de largeur plutôt que d'être lu comme un
 * drapeau `-1`.
 */
function explodeShorts(args: string[], flags: string, valued: string): string[] {
  const out: string[] = [];
  for (const a of args) {
    if (!a.startsWith('-') || a === '-' || a.startsWith('--') || a.length <= 2) { out.push(a); continue; }
    const body = a.slice(1);
    const parts: string[] = [];
    let ok = true;
    for (let i = 0; i < body.length; i++) {
      const c = body[i];
      if (!flags.includes(c)) { ok = false; break; }
      parts.push('-' + c);
      if (valued.includes(c)) {
        if (i + 1 < body.length) parts.push(body.slice(i + 1));
        break;
      }
    }
    if (ok) out.push(...parts);
    else out.push(a);
  }
  return out;
}

function readFile(ctx: LinuxCommandContext, name: string): string | null {
  return ctx.executor.vfs.readFile(ctx.executor.vfs.normalizePath(name, ctx.executor.getCwd()));
}

function missing(cmd: string, name: string): string {
  return `${cmd}: ${name}: No such file or directory`;
}

/** Les lignes d'un contenu, sans la ligne vide finale d'un fichier terminé par \n. */
function toLines(content: string, terminator = '\n'): string[] {
  const lines = content.split(terminator);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Le contenu de chaque entrée, ou le message d'erreur du coreutil. Un
 * tableau signale la réussite ; `Array.isArray` suffit à distinguer.
 */
function inputs(ctx: LinuxCommandContext, files: string[], stdin: string | undefined, cmd: string): string[] | string {
  if (files.length === 0) return [stdin ?? ''];
  const contents: string[] = [];
  for (const f of files) {
    if (f === '-') { contents.push(stdin ?? ''); continue; }
    const c = readFile(ctx, f);
    if (c === null) return missing(cmd, f);
    contents.push(c);
  }
  return contents;
}

function viaCoreutils(base: LinuxCommand, run: (args: string[], io: CoreutilsIO, ctx: LinuxCommandContext) => CoreutilsRun): LinuxCommand {
  const execute = (ctx: LinuxCommandContext, args: string[], stdin?: string) => asDispatch(run(args, coreutilsIO(ctx.executor.ctx(), stdin), ctx));
  return {
    ...base,
    run: (ctx, args, stdin) => execute(ctx, args, stdin).output,
    runWithStatusSync: execute,
    runWithStatus: (ctx, args, stdin) => Promise.resolve(execute(ctx, args, stdin)),
  };
}

/** Le squelette commun : un nom, une aide, et une fonction de calcul. */
function coreutil(
  name: string,
  usage: string,
  help: string,
  options: Array<{ flag: string; description: string; takesArg?: boolean; argName?: string }>,
  compute: (ctx: LinuxCommandContext, args: string[], stdin?: string) => string,
): LinuxCommand {
  return {
    name,
    // Voir l'en-tête : c'est la convention de dispatch, pas du réseau.
    needsNetworkContext: true,
    readsStdin: true,
    manSection: 1,
    usage,
    help,
    options,
    complete: (_ctx, args) => {
      const partial = args[args.length - 1] ?? '';
      return partial.startsWith('-') ? options.map(o => o.flag).filter(f => f.startsWith(partial)) : [];
    },
    run(ctx: LinuxCommandContext, args: string[], stdin?: string): string {
      return compute(ctx, args, stdin);
    },
  };
}

// ─── tac ────────────────────────────────────────────────────────────

export const tacCommand = viaCoreutils(coreutil(
  'tac', 'tac [FILE]...',
  'Concatenate and print files in reverse, last line first.',
  [
    { flag: '-b', description: 'attach the separator before instead of after' },
    { flag: '-r', description: 'interpret the separator as a regular expression' },
    { flag: '-s', description: 'use STRING as the separator instead of newline', takesArg: true, argName: 'STRING' },
  ],
  () => '',
), runTac);

// ─── nl ─────────────────────────────────────────────────────────────

export const nlCommand = viaCoreutils(coreutil(
  'nl', 'nl [OPTION]... [FILE]...',
  'Number the lines of each file. By default only non-empty lines are\n'
  + 'numbered (-b t); -b a numbers every line.',
  [
    { flag: '-b', description: 'Body numbering style: a, t, n or pBRE', takesArg: true, argName: 'STYLE' },
    { flag: '-h', description: 'Header numbering style', takesArg: true, argName: 'STYLE' },
    { flag: '-f', description: 'Footer numbering style', takesArg: true, argName: 'STYLE' },
    { flag: '-n', description: 'Number format: ln, rn or rz', takesArg: true, argName: 'FORMAT' },
    { flag: '-w', description: 'Number field width', takesArg: true, argName: 'NUMBER' },
    { flag: '-s', description: 'Separator after the number', takesArg: true, argName: 'STRING' },
    { flag: '-v', description: 'First line number', takesArg: true, argName: 'NUMBER' },
    { flag: '-i', description: 'Line number increment', takesArg: true, argName: 'NUMBER' },
    { flag: '-l', description: 'Count of blank lines numbered as one', takesArg: true, argName: 'NUMBER' },
    { flag: '-d', description: 'Section delimiter characters', takesArg: true, argName: 'CC' },
    { flag: '-p', description: 'Do not restart numbering at each logical page' },
  ],
  () => '',
), runNl);

// ─── paste ──────────────────────────────────────────────────────────

export const pasteCommand = viaCoreutils(coreutil(
  'paste', 'paste [-s] [-d LIST] [FILE]...',
  'Merge lines of files side by side. -s pastes one file per line\n'
  + 'instead of column by column; -d gives the delimiters, consumed in\n'
  + 'turn (so `paste -sd+` joins a sequence with plus signs).',
  [
    { flag: '-s', description: 'Paste one file per line' },
    { flag: '-d', description: 'Delimiter list', takesArg: true, argName: 'LIST' },
  ],
  () => '',
), runPaste);

// ─── comm ───────────────────────────────────────────────────────────

export const commCommand = viaCoreutils(coreutil(
  'comm', 'comm [OPTION]... FILE1 FILE2',
  'Compare two sorted files line by line, in three columns: lines only\n'
  + 'in FILE1, only in FILE2, and in both. -1/-2/-3 suppress the matching\n'
  + 'column, so -12 keeps only what is common and -3 only the differences.',
  [
    { flag: '-1', description: 'Suppress lines unique to FILE1' },
    { flag: '-2', description: 'Suppress lines unique to FILE2' },
    { flag: '-3', description: 'Suppress lines present in both' },
    { flag: '--output-delimiter', description: 'Separate columns with STR', takesArg: true, argName: 'STR' },
    { flag: '--check-order', description: 'Refuse input that is not sorted' },
    { flag: '--total', description: 'Print a summary line' },
    { flag: '-z', description: 'Lines end with NUL, not newline' },
  ],
  () => '',
), runComm);

// ─── fold ───────────────────────────────────────────────────────────

export const foldCommand = viaCoreutils(coreutil(
  'fold', 'fold [-s] [-w WIDTH] [FILE]...',
  'Wrap each input line to fit in WIDTH columns (80 by default).\n'
  + '-s breaks at the last blank before the limit instead of mid-word.',
  [
    { flag: '-w', description: 'Wrap width', takesArg: true, argName: 'WIDTH' },
    { flag: '-s', description: 'Break at spaces' },
  ],
  () => '',
), runFold);

// ─── expand / unexpand ──────────────────────────────────────────────

export const expandCommand = viaCoreutils(coreutil(
  'expand', 'expand [-t N] [FILE]...',
  'Convert tabs to spaces, with tab stops every N columns (8 by default).',
  [{ flag: '-t', description: 'Tab stop width', takesArg: true, argName: 'N' }],
  () => '',
), runExpand);

export const unexpandCommand = viaCoreutils(coreutil(
  'unexpand', 'unexpand [-t N] [FILE]...',
  'Convert leading spaces back to tabs. Without -a, only the indentation\n'
  + 'of each line is converted, like the real coreutil.',
  [{ flag: '-t', description: 'Tab stop width', takesArg: true, argName: 'N' }],
  () => '',
), runUnexpand);

// ─── fmt ────────────────────────────────────────────────────────────

function wrapWords(line: string, width: number): string[] {
  const words = line.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];
  const rows: string[] = [];
  let cur = '';
  for (const w of words) {
    if (cur === '') cur = w;
    else if (cur.length + 1 + w.length <= width) cur += ' ' + w;
    else { rows.push(cur); cur = w; }
  }
  if (cur !== '') rows.push(cur);
  return rows;
}

export const fmtCommand = coreutil(
  'fmt', 'fmt [-s] [-w WIDTH] [FILE]...',
  'Reflow paragraphs to WIDTH columns (75 by default). -s only splits\n'
  + 'long lines and never joins two short ones.',
  [
    { flag: '-w', description: 'Target width', takesArg: true, argName: 'WIDTH' },
    { flag: '-s', description: 'Split long lines only' },
  ],
  (ctx, rawArgs, stdin) => {
    const args = explodeShorts(rawArgs, 'sw', 'w');
    let width = 75;
    let splitOnly = false;
    const files: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-s') { splitOnly = true; continue; }
      if (a === '-w' && args[i + 1]) { width = parseInt(args[i + 1], 10); i++; continue; }
      if (/^-\d+$/.test(a)) { width = parseInt(a.slice(1), 10); continue; }
      if (!a.startsWith('-') || a === '-') files.push(a);
    }
    const got = inputs(ctx, files, stdin, 'fmt');
    if (!Array.isArray(got)) return got;

    const out: string[] = [];
    for (const content of got) {
      if (splitOnly) {
        for (const line of toLines(content)) out.push(...wrapWords(line, width));
        continue;
      }
      for (const para of content.split(/\n\s*\n/)) {
        const words = para.split(/\s+/).filter(Boolean);
        if (words.length === 0) continue;
        if (out.length > 0) out.push('');
        out.push(...wrapWords(words.join(' '), width));
      }
    }
    return out.join('\n');
  },
);

// ─── pr ─────────────────────────────────────────────────────────────

export const prCommand = coreutil(
  'pr', 'pr [-t] [-n] [FILE]...',
  'Paginate files for printing. -t omits the page headers and footers,\n'
  + '-n numbers the lines. Only these two forms are available: full\n'
  + 'pagination would need a page geometry this host does not model.',
  [
    { flag: '-t', description: 'Omit headers and footers' },
    { flag: '-n', description: 'Number the lines' },
  ],
  (ctx, rawArgs, stdin) => {
    const args = explodeShorts(rawArgs, 'tn', '');
    let omitHeader = false;
    let numbered = false;
    const files: string[] = [];
    for (const a of args) {
      if (a === '-t') { omitHeader = true; continue; }
      if (a === '-n') { numbered = true; continue; }
      if (!a.startsWith('-') || a === '-') files.push(a);
    }
    const got = inputs(ctx, files, stdin, 'pr');
    if (!Array.isArray(got)) return got;

    const out: string[] = [];
    for (let f = 0; f < got.length; f++) {
      const body = toLines(got[f]).map((l, i) => (numbered ? `${padToWidth(String(i + 1), 5, 'right')}\t${l}` : l));
      if (omitHeader) { out.push(...body); continue; }
      out.push('', '', `${simulationDate().toDateString()}  ${files[f] ?? ''}  Page 1`, '', '');
      out.push(...body);
      out.push('', '', '', '', '');
    }
    return out.join('\n');
  },
);

// ─── column ─────────────────────────────────────────────────────────

export const columnCommand = coreutil(
  'column', 'column [-t] [-s SEP] [FILE]...',
  'Columnate the input. -t builds an aligned table; -s gives the input\n'
  + 'delimiters instead of whitespace.',
  [
    { flag: '-t', description: 'Build an aligned table' },
    { flag: '-s', description: 'Input delimiters', takesArg: true, argName: 'SEP' },
  ],
  (ctx, rawArgs, stdin) => {
    const set = GNU_OPTION_SETS.column;
    let table = false;
    let sep: string | null = null;
    const files: string[] = [];
    for (const item of shortOptions(rawArgs, set.optstring, set.long)) {
      if (item.kind === 'operand') files.push(item.value);
      else if (item.kind === 'option' && item.letter === 't') table = true;
      else if (item.kind === 'option' && item.letter === 's') sep = item.argument ?? null;
    }
    const got = inputs(ctx, files, stdin, 'column');
    if (!Array.isArray(got)) return got;

    const lines = got.flatMap(content => toLines(content)).filter(l => l !== '');
    if (!table) return lines.join('\n');

    const splitter = sep === null
      ? /\s+/
      : new RegExp(`[${sep.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}]`);
    const rows = lines.map(l => l.split(splitter));
    const columns: TableColumn<string[]>[] = Array.from(
      { length: Math.max(0, ...rows.map(row => row.length)) },
      (_, i) => ({ header: '', value: (row: string[]) => row[i] ?? '' }),
    );
    return renderTableText(rows, columns, { gap: 2, rule: false, header: false });
  },
);

// ─── cmp ────────────────────────────────────────────────────────────

export const cmpCommand: LinuxCommand = {
  name: 'cmp',
  needsNetworkContext: true,
  readsStdin: true,
  manSection: 1,
  usage: 'cmp FILE1 FILE2',
  help: 'Compare two files byte by byte. Prints nothing and exits 0 when they\n'
    + 'are identical; otherwise names the first differing byte and line.',
  options: [],
  run(ctx: LinuxCommandContext, args: string[], stdin?: string): string {
    return cmpRun(ctx, args, stdin).output;
  },
  runWithStatusSync(ctx: LinuxCommandContext, args: string[], stdin?: string) {
    return cmpRun(ctx, args, stdin);
  },
};

function cmpRun(ctx: LinuxCommandContext, args: string[], stdin?: string): { output: string; exitCode: number; stderr?: string } {
  const files = args.filter(a => !a.startsWith('-') || a === '-');
  if (files.length < 2) return { output: '', stderr: 'cmp: missing operand', exitCode: 2 };
  const got = inputs(ctx, files.slice(0, 2), stdin, 'cmp');
  if (!Array.isArray(got)) return { output: '', stderr: got, exitCode: 2 };

  const [a, b] = got;
  const silent = args.some((argument) => argument === '-s' || argument === '--silent' || argument === '--quiet');
  if (a === b) return { output: '', exitCode: 0 };
  const min = Math.min(a.length, b.length);
  for (let i = 0; i < min; i++) {
    if (a[i] !== b[i]) {
      const line = a.slice(0, i).split('\n').length;
      return { output: silent ? '' : `${files[0]} ${files[1]} differ: byte ${i + 1}, line ${line}`, stderr: '', exitCode: 1 };
    }
  }
  const shorter = a.length < b.length ? a : b;
  const name = a.length < b.length ? files[0] : files[1];
  const where = shorter === '' ? 'which is empty' : `after byte ${shorter.length}, line ${shorter.split('\n').length - 1}`;
  return { output: '', stderr: silent ? '' : `cmp: EOF on ${name} ${where}`, exitCode: 1 };
}

// ─── split ──────────────────────────────────────────────────────────

/** Les suffixes de `split` : aa, ab, … puis ba, bb, … */
function suffixes(count: number, length: number, kind: 'alpha' | 'numeric' | 'hex', from: number): string[] | null {
  const radix = kind === 'alpha' ? 26 : kind === 'hex' ? 16 : 10;
  if (from + count > radix ** length) return null;
  const out: string[] = [];
  for (let i = from; i < from + count; i++) {
    let rest = i;
    let text = '';
    for (let place = 0; place < length; place++) {
      const digit = rest % radix;
      text = (kind === 'alpha' ? String.fromCharCode(97 + digit) : digit.toString(radix)) + text;
      rest = Math.floor(rest / radix);
    }
    out.push(text);
  }
  return out;
}

function splitSize(raw: string, what: string): number | string {
  const match = /^(\d+)([KMGkmg]?)$/.exec(raw);
  if (match === null || Number(match[1]) < 1) return `split: invalid number of ${what}: '${raw}'`;
  const units: Record<string, number> = { '': 1, k: 1024, K: 1024, m: 1048576, M: 1048576, g: 1073741824, G: 1073741824 };
  return Number(match[1]) * units[match[2]];
}

export const splitCommand = viaCoreutils(coreutil(
  'split', 'split [OPTION]... [FILE [PREFIX]]',
  'Split a file into pieces, written to PREFIXaa, PREFIXab, ... -l splits\n'
  + 'every N lines, -b every N bytes, -C at most N bytes of whole lines, -n into\n'
  + 'N chunks of equal size. -a sets the suffix length, -d numeric and -x\n'
  + 'hexadecimal suffixes, -e drops empty pieces.',
  [
    { flag: '-l', description: 'Lines per piece', takesArg: true, argName: 'N' },
    { flag: '-b', description: 'Bytes per piece', takesArg: true, argName: 'N' },
    { flag: '-C', description: 'At most N bytes of whole lines per piece', takesArg: true, argName: 'N' },
    { flag: '-n', description: 'Number of chunks', takesArg: true, argName: 'N' },
    { flag: '-a', description: 'Suffix length (2 by default)', takesArg: true, argName: 'N' },
    { flag: '-d', description: 'Numeric suffixes' },
    { flag: '-x', description: 'Hexadecimal suffixes' },
    { flag: '-e', description: 'Do not generate empty output files' },
    { flag: '-t', description: 'Record separator', takesArg: true, argName: 'SEP' },
    { flag: '-u', description: 'Unbuffered output' },
    { flag: '--additional-suffix', description: 'Append SUFFIX to the file names', takesArg: true, argName: 'SUFFIX' },
    { flag: '--verbose', description: 'Print a diagnostic before each file' },
  ],
  () => '',
), (args, io, ctx) => runSplit(ctx.executor.ctx(), args, io, ctx.executor.splitHost()));

// ─── base64 ─────────────────────────────────────────────────────────

export const base64Command = coreutil(
  'base64', 'base64 [OPTION]... [FILE]',
  'Encode or decode base64. -d decodes; -w wraps encoded lines after COLS\n'
  + 'characters (76 by default, 0 never wraps); -i ignores non-alphabet\n'
  + 'characters when decoding.',
  [
    { flag: '-d', description: 'Decode instead of encoding' },
    { flag: '-i', description: 'When decoding, ignore non-alphabet characters' },
    { flag: '-w', description: 'Wrap encoded lines after COLS characters', takesArg: true, argName: 'COLS' },
  ],
  (ctx, args, stdin) => {
    const set = GNU_OPTION_SETS.base64;
    let decode = false;
    let ignoreGarbage = false;
    let wrap = 76;
    const files: string[] = [];
    for (const item of shortOptions(args, set.optstring, set.long)) {
      if (item.kind === 'operand') files.push(item.value);
      else if (item.kind === 'option' && item.letter === 'd') decode = true;
      else if (item.kind === 'option' && item.letter === 'i') ignoreGarbage = true;
      else if (item.kind === 'option' && item.letter === 'w') {
        if (!/^\d+$/.test(item.argument ?? '')) return `base64: invalid wrap size: '${item.argument}'`;
        wrap = Number(item.argument);
      }
    }
    const got = inputs(ctx, files, stdin, 'base64');
    if (!Array.isArray(got)) return got;
    const input = got.join('');
    if (input === '') return '';

    try {
      if (decode) {
        const text = ignoreGarbage ? input.replace(/[^A-Za-z0-9+/=]/g, '') : input.replace(/\s+/g, '');
        const bytes = base64ToBytes(text);
        const decoded = bytesToFileText(bytes);
        return /[\udc80-\udcff]/.test(decoded) ? decoded : decoded.replace(/\n$/, '');
      }
      const encoded = bytesToBase64(fileTextToBytes(input));
      if (wrap === 0) return encoded;
      const lines: string[] = [];
      for (let at = 0; at < encoded.length; at += wrap) lines.push(encoded.slice(at, at + wrap));
      return `${lines.join('\n')}\n`;
    } catch {
      return 'base64: invalid input';
    }
  },
);

// ─── cksum ──────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 24;
    for (let k = 0; k < 8; k++) c = (c & 0x80000000) ? ((c << 1) ^ 0x04c11db7) >>> 0 : (c << 1) >>> 0;
    table[i] = c >>> 0;
  }
  return table;
})();

/** Le CRC-32 de POSIX, celui que `cksum` imprime — pas celui de zlib. */
function posixCksum(bytes: Uint8Array): number {
  let crc = 0;
  for (const b of bytes) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ b) & 0xff]) >>> 0;
  let len = bytes.length;
  while (len > 0) {
    crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ (len & 0xff)) & 0xff]) >>> 0;
    len >>>= 8;
  }
  return (~crc) >>> 0;
}

export const cksumCommand = coreutil(
  'cksum', 'cksum [FILE]...',
  'Print the POSIX CRC checksum and byte count of each file.',
  [],
  (ctx, args, stdin) => {
    const files = args.filter(a => !a.startsWith('-') || a === '-');
    const got = inputs(ctx, files, stdin, 'cksum');
    if (!Array.isArray(got)) return got;
    return got.map((content, i) => {
      const bytes = fileTextToBytes(content);
      return `${posixCksum(bytes)} ${bytes.length}${files[i] ? ` ${files[i]}` : ''}`;
    }).join('\n');
  },
);

export const lessCommand: LinuxCommand = { package: 'less', ...coreutil(
  'less', 'less [OPTIONS] [FILE]...',
  'View a file one screen at a time. Without a terminal on its output,\n'
  + 'less prints the files as cat does.',
  [
    { flag: '-N', description: 'Display line numbers' },
    { flag: '-S', description: 'Chop long lines' },
    { flag: '-i', description: 'Ignore case in searches that do not contain uppercase' },
    { flag: '-I', description: 'Ignore case in searches and in patterns' },
    { flag: '-F', description: 'Quit if the entire file fits on the first screen' },
    { flag: '-X', description: 'Do not use the alternate screen' },
    { flag: '-R', description: 'Output raw control characters' },
  ],
  (ctx, args, stdin) => {
    const parsed = parseLessLaunch(['less', ...args].join(' '));
    if (parsed.kind === 'error') return parsed.message;
    if (parsed.kind === 'print') return parsed.lines.join('\n');
    const files = parsed.kind === 'open' ? parsed.launch.files : [];
    if (files.length === 0 && stdin === undefined) return 'Missing filename ("less --help" for help)';
    const got = inputs(ctx, [...files], stdin, 'less');
    if (!Array.isArray(got)) return got.replace(/^less: /, '');
    return got.join('');
  },
) };

export const TEXT_STREAM_COMMANDS: LinuxCommand[] = [
  lessCommand,
  tacCommand, nlCommand, pasteCommand, commCommand, foldCommand,
  expandCommand, unexpandCommand, fmtCommand, prCommand, columnCommand,
  cmpCommand, splitCommand, base64Command, cksumCommand,
];
