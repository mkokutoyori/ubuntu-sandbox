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

import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';

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
function toLines(content: string): string[] {
  const lines = content.split('\n');
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

export const tacCommand = coreutil(
  'tac', 'tac [FILE]...',
  'Concatenate and print files in reverse, last line first.',
  [],
  (ctx, args, stdin) => {
    const got = inputs(ctx, args.filter(a => !a.startsWith('-') || a === '-'), stdin, 'tac');
    if (!Array.isArray(got)) return got;
    return got.map(c => toLines(c).reverse().join('\n')).join('\n');
  },
);

// ─── nl ─────────────────────────────────────────────────────────────

export const nlCommand = coreutil(
  'nl', 'nl [-b a|t] [FILE]...',
  'Number the lines of each file. By default only non-empty lines are\n'
  + 'numbered (-b t); -b a numbers every line.',
  [{ flag: '-b', description: 'Body numbering style: a (all) or t (non-empty)', takesArg: true, argName: 'STYLE' }],
  (ctx, rawArgs, stdin) => {
    const args = explodeShorts(rawArgs, 'b', 'b');
    let numberAll = false;
    const files: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-b' && args[i + 1]) { numberAll = args[i + 1] === 'a'; i++; continue; }
      if (!a.startsWith('-') || a === '-') files.push(a);
    }
    const got = inputs(ctx, files, stdin, 'nl');
    if (!Array.isArray(got)) return got;

    const out: string[] = [];
    let n = 0;
    for (const content of got) {
      for (const line of toLines(content)) {
        if (line === '' && !numberAll) { out.push(''); continue; }
        n += 1;
        out.push(`${String(n).padStart(6)}\t${line}`);
      }
    }
    return out.join('\n');
  },
);

// ─── paste ──────────────────────────────────────────────────────────

export const pasteCommand = coreutil(
  'paste', 'paste [-s] [-d LIST] [FILE]...',
  'Merge lines of files side by side. -s pastes one file per line\n'
  + 'instead of column by column; -d gives the delimiters, consumed in\n'
  + 'turn (so `paste -sd+` joins a sequence with plus signs).',
  [
    { flag: '-s', description: 'Paste one file per line' },
    { flag: '-d', description: 'Delimiter list', takesArg: true, argName: 'LIST' },
  ],
  (ctx, rawArgs, stdin) => {
    const args = explodeShorts(rawArgs, 'sd', 'd');
    let delims = '\t';
    let serial = false;
    const files: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-s') { serial = true; continue; }
      if (a === '-d' && args[i + 1] !== undefined) { delims = args[i + 1]; i++; continue; }
      if (!a.startsWith('-') || a === '-') files.push(a);
    }
    if (delims === '') delims = '\t';
    const got = inputs(ctx, files, stdin, 'paste');
    if (!Array.isArray(got)) return got;

    const sep = (i: number) => delims[i % delims.length];
    if (serial) {
      return got
        .map(c => toLines(c).reduce((acc, l, i) => (i === 0 ? l : acc + sep(i - 1) + l), ''))
        .join('\n');
    }
    const columns = got.map(toLines);
    const height = Math.max(0, ...columns.map(c => c.length));
    const rows: string[] = [];
    for (let r = 0; r < height; r++) {
      rows.push(columns
        .map(c => c[r] ?? '')
        .reduce((acc, cell, i) => (i === 0 ? cell : acc + sep(i - 1) + cell), ''));
    }
    return rows.join('\n');
  },
);

// ─── comm ───────────────────────────────────────────────────────────

export const commCommand = coreutil(
  'comm', 'comm [-123] FILE1 FILE2',
  'Compare two sorted files line by line, in three columns: lines only\n'
  + 'in FILE1, only in FILE2, and in both. -1/-2/-3 suppress the matching\n'
  + 'column, so -12 keeps only what is common and -3 only the differences.',
  [
    { flag: '-1', description: 'Suppress lines unique to FILE1' },
    { flag: '-2', description: 'Suppress lines unique to FILE2' },
    { flag: '-3', description: 'Suppress lines present in both' },
  ],
  (ctx, rawArgs, stdin) => {
    const args = rawArgs;
    const suppressed = new Set<number>();
    const files: string[] = [];
    for (const a of args) {
      if (/^-[123]+$/.test(a)) { for (const d of a.slice(1)) suppressed.add(Number(d)); continue; }
      if (!a.startsWith('-') || a === '-') files.push(a);
    }
    if (files.length !== 2) return 'comm: missing operand';
    const got = inputs(ctx, files, stdin, 'comm');
    if (!Array.isArray(got)) return got;

    const [a, b] = got.map(toLines);
    const out: string[] = [];
    const emit = (col: 1 | 2 | 3, value: string) => {
      if (suppressed.has(col)) return;
      // Chaque colonne conservée qui précède décale d'une tabulation.
      let indent = 0;
      for (let c = 1; c < col; c++) if (!suppressed.has(c)) indent++;
      out.push('\t'.repeat(indent) + value);
    };
    let i = 0, j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { emit(3, a[i]); i++; j++; }
      else if (a[i] < b[j]) { emit(1, a[i]); i++; }
      else { emit(2, b[j]); j++; }
    }
    while (i < a.length) { emit(1, a[i]); i++; }
    while (j < b.length) { emit(2, b[j]); j++; }
    return out.join('\n');
  },
);

// ─── fold ───────────────────────────────────────────────────────────

export const foldCommand = coreutil(
  'fold', 'fold [-s] [-w WIDTH] [FILE]...',
  'Wrap each input line to fit in WIDTH columns (80 by default).\n'
  + '-s breaks at the last blank before the limit instead of mid-word.',
  [
    { flag: '-w', description: 'Wrap width', takesArg: true, argName: 'WIDTH' },
    { flag: '-s', description: 'Break at spaces' },
  ],
  (ctx, rawArgs, stdin) => {
    const args = explodeShorts(rawArgs, 'sw', 'w');
    let width = 80;
    let atSpaces = false;
    const files: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-s' || a === '--spaces') { atSpaces = true; continue; }
      if (a === '-w' && args[i + 1]) { width = parseInt(args[i + 1], 10); i++; continue; }
      if (/^-\d+$/.test(a)) { width = parseInt(a.slice(1), 10); continue; }
      if (!a.startsWith('-') || a === '-') files.push(a);
    }
    if (!Number.isFinite(width) || width < 1) return 'fold: invalid number of columns';
    const got = inputs(ctx, files, stdin, 'fold');
    if (!Array.isArray(got)) return got;

    const out: string[] = [];
    for (const content of got) {
      for (const line of toLines(content)) {
        let rest = line;
        if (rest === '') { out.push(''); continue; }
        while (rest.length > width) {
          let cut = width;
          if (atSpaces) {
            const lastSpace = rest.lastIndexOf(' ', width - 1);
            if (lastSpace > 0) cut = lastSpace + 1;
          }
          out.push(rest.slice(0, cut));
          rest = rest.slice(cut);
        }
        out.push(rest);
      }
    }
    return out.join('\n');
  },
);

// ─── expand / unexpand ──────────────────────────────────────────────

function tabStop(args: string[]): number {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-t' && args[i + 1]) return parseInt(args[i + 1], 10) || 8;
  }
  return 8;
}

function fileArgs(args: string[]): string[] {
  return args.filter((a, i) => (!a.startsWith('-') || a === '-') && args[i - 1] !== '-t');
}

export const expandCommand = coreutil(
  'expand', 'expand [-t N] [FILE]...',
  'Convert tabs to spaces, with tab stops every N columns (8 by default).',
  [{ flag: '-t', description: 'Tab stop width', takesArg: true, argName: 'N' }],
  (ctx, rawArgs, stdin) => {
    const args = explodeShorts(rawArgs, 'ta', 't');
    const stop = tabStop(args);
    const got = inputs(ctx, fileArgs(args), stdin, 'expand');
    if (!Array.isArray(got)) return got;
    const expand = (line: string) => {
      let out = '';
      for (const ch of line) {
        if (ch === '\t') out += ' '.repeat(stop - (out.length % stop));
        else out += ch;
      }
      return out;
    };
    return got.map(c => toLines(c).map(expand).join('\n')).join('\n');
  },
);

export const unexpandCommand = coreutil(
  'unexpand', 'unexpand [-t N] [FILE]...',
  'Convert leading spaces back to tabs. Without -a, only the indentation\n'
  + 'of each line is converted, like the real coreutil.',
  [{ flag: '-t', description: 'Tab stop width', takesArg: true, argName: 'N' }],
  (ctx, rawArgs, stdin) => {
    const args = explodeShorts(rawArgs, 'ta', 't');
    const stop = tabStop(args);
    const got = inputs(ctx, fileArgs(args), stdin, 'unexpand');
    if (!Array.isArray(got)) return got;
    const shrink = (line: string) => {
      const lead = /^ +/.exec(line);
      if (!lead) return line;
      const n = lead[0].length;
      return '\t'.repeat(Math.floor(n / stop)) + ' '.repeat(n % stop) + line.slice(n);
    };
    return got.map(c => toLines(c).map(shrink).join('\n')).join('\n');
  },
);

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
      const body = toLines(got[f]).map((l, i) => (numbered ? `${String(i + 1).padStart(5)}\t${l}` : l));
      if (omitHeader) { out.push(...body); continue; }
      out.push('', '', `${new Date().toDateString()}  ${files[f] ?? ''}  Page 1`, '', '');
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
    const args = explodeShorts(rawArgs, 'ts', 's');
    let table = false;
    let sep: string | null = null;
    const files: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-t') { table = true; continue; }
      if (a === '-s' && args[i + 1] !== undefined) { sep = args[i + 1]; i++; continue; }
      if (!a.startsWith('-') || a === '-') files.push(a);
    }
    const got = inputs(ctx, files, stdin, 'column');
    if (!Array.isArray(got)) return got;

    const lines = got.flatMap(toLines).filter(l => l !== '');
    if (!table) return lines.join('\n');

    const splitter = sep === null
      ? /\s+/
      : new RegExp(`[${sep.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}]`);
    const rows = lines.map(l => l.split(splitter));
    const widths: number[] = [];
    for (const row of rows) {
      row.forEach((cell, i) => { widths[i] = Math.max(widths[i] ?? 0, cell.length); });
    }
    return rows
      .map(row => row
        .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] + 2)))
        .join('')
        .trimEnd())
      .join('\n');
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

function cmpRun(ctx: LinuxCommandContext, args: string[], stdin?: string): { output: string; exitCode: number } {
  const files = args.filter(a => !a.startsWith('-') || a === '-');
  if (files.length < 2) return { output: 'cmp: missing operand', exitCode: 2 };
  const got = inputs(ctx, files.slice(0, 2), stdin, 'cmp');
  if (!Array.isArray(got)) return { output: got, exitCode: 2 };

  const [a, b] = got;
  if (a === b) return { output: '', exitCode: 0 };
  const min = Math.min(a.length, b.length);
  for (let i = 0; i < min; i++) {
    if (a[i] !== b[i]) {
      const line = a.slice(0, i).split('\n').length;
      // `char`, pas `byte` : c'est le mot que GNU cmp imprime.
      return { output: `${files[0]} ${files[1]} differ: char ${i + 1}, line ${line}`, exitCode: 1 };
    }
  }
  return { output: `cmp: EOF on ${a.length < b.length ? files[0] : files[1]}`, exitCode: 1 };
}

// ─── split ──────────────────────────────────────────────────────────

/** Les suffixes de `split` : aa, ab, … puis ba, bb, … */
function suffixes(count: number): string[] {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(alphabet[Math.floor(i / 26) % 26] + alphabet[i % 26]);
  }
  return out;
}

export const splitCommand = coreutil(
  'split', 'split [-l N | -b N | -n N] [FILE [PREFIX]]',
  'Split a file into pieces, written to PREFIXaa, PREFIXab, ... -l splits\n'
  + 'every N lines, -b every N bytes, -n into N chunks of equal size.',
  [
    { flag: '-l', description: 'Lines per piece', takesArg: true, argName: 'N' },
    { flag: '-b', description: 'Bytes per piece', takesArg: true, argName: 'N' },
    { flag: '-n', description: 'Number of chunks', takesArg: true, argName: 'N' },
  ],
  (ctx, rawArgs, stdin) => {
    const args = explodeShorts(rawArgs, 'lbn', 'lbn');
    let mode: 'lines' | 'bytes' | 'chunks' = 'lines';
    let size = 1000;
    const positional: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-l' && args[i + 1]) { mode = 'lines'; size = parseInt(args[i + 1], 10); i++; continue; }
      if (a === '-b' && args[i + 1]) { mode = 'bytes'; size = parseInt(args[i + 1], 10); i++; continue; }
      if (a === '-n' && args[i + 1]) { mode = 'chunks'; size = parseInt(args[i + 1], 10); i++; continue; }
      if (!a.startsWith('-') || a === '-') positional.push(a);
    }
    const source = positional[0];
    const prefix = positional[1] ?? 'x';
    const content = source && source !== '-' ? readFile(ctx, source) : (stdin ?? '');
    if (content === null) return missing('split', source);
    if (!Number.isFinite(size) || size < 1) return 'split: invalid number of lines';

    const pieces: string[] = [];
    if (mode === 'bytes') {
      for (let i = 0; i < content.length; i += size) pieces.push(content.slice(i, i + size));
    } else if (mode === 'chunks') {
      const per = Math.ceil(content.length / size);
      for (let i = 0; i < content.length; i += per) pieces.push(content.slice(i, i + per));
    } else {
      const lines = toLines(content);
      for (let i = 0; i < lines.length; i += size) {
        pieces.push(lines.slice(i, i + size).join('\n') + '\n');
      }
    }

    // Les morceaux sont réellement écrits : `ls` les voit ensuite.
    const names = suffixes(pieces.length);
    const vfs = ctx.executor.vfs;
    pieces.forEach((piece, i) => {
      vfs.writeFile(
        vfs.normalizePath(`${prefix}${names[i]}`, ctx.executor.getCwd()),
        piece, ctx.executor.getCurrentUid(), 0, 0o022,
      );
    });
    return '';
  },
);

// ─── base64 ─────────────────────────────────────────────────────────

export const base64Command = coreutil(
  'base64', 'base64 [-d] [FILE]',
  'Encode or decode base64. -d decodes.',
  [{ flag: '-d', description: 'Decode instead of encoding' }],
  (ctx, args, stdin) => {
    const decode = args.some(a => a === '-d' || a === '--decode');
    const got = inputs(ctx, args.filter(a => !a.startsWith('-') || a === '-'), stdin, 'base64');
    if (!Array.isArray(got)) return got;
    const input = got.join('');

    try {
      if (decode) {
        const binary = atob(input.replace(/\s+/g, ''));
        const bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0));
        return new TextDecoder().decode(bytes).replace(/\n$/, '');
      }
      const bytes = new TextEncoder().encode(input.endsWith('\n') ? input : input + '\n');
      let binary = '';
      for (const b of bytes) binary += String.fromCharCode(b);
      return btoa(binary);
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
      const bytes = new TextEncoder().encode(content);
      return `${posixCksum(bytes)} ${bytes.length}${files[i] ? ` ${files[i]}` : ''}`;
    }).join('\n');
  },
);

export const TEXT_STREAM_COMMANDS: LinuxCommand[] = [
  tacCommand, nlCommand, pasteCommand, commCommand, foldCommand,
  expandCommand, unexpandCommand, fmtCommand, prCommand, columnCommand,
  cmpCommand, splitCommand, base64Command, cksumCommand,
];
