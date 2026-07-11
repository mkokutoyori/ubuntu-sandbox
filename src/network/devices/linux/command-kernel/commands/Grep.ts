import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { FileSystemError } from '@/command-kernel/errors';
import { FileSystemActor, toFileSystemActor } from '@/command-kernel/machine/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { compilePosix } from '../../regex/PosixRegex';
import { splitLines } from './textInput';

interface GrepFlags {
  caseInsensitive: boolean; countOnly: boolean; recursive: boolean; invert: boolean;
  lineNumbers: boolean; filesOnly: boolean; filesWithout: boolean; wholeWord: boolean;
  wholeLine: boolean; onlyMatching: boolean; quiet: boolean; suppressErrors: boolean;
  forceFilename: boolean | null; extended: boolean; fixed: boolean; perl: boolean;
  maxCount: number; after: number; before: number;
  includeGlobs: string[]; excludeGlobs: string[];
}

/**
 * `-P` (Perl-compatible regex): JS's native RegExp already covers the
 * common PCRE subset. `\K` ("keep": discard the match so far) is the one
 * construct it lacks — translated into an equivalent lookbehind.
 */
function compilePcre(
  pattern: string,
  opts: { ignoreCase: boolean; wholeWord: boolean; wholeLine: boolean },
): RegExp {
  let p = pattern;
  const kIndex = p.indexOf('\\K');
  if (kIndex !== -1) p = `(?<=${p.slice(0, kIndex)})${p.slice(kIndex + 2)}`;
  if (opts.wholeWord) p = `\\b(?:${p})\\b`;
  if (opts.wholeLine) p = `^(?:${p})$`;
  return new RegExp(p, opts.ignoreCase ? 'gi' : 'g');
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
  if (fl.excludeGlobs.some((g) => globToRegExp(g).test(name))) return false;
  if (fl.includeGlobs.length > 0) return fl.includeGlobs.some((g) => globToRegExp(g).test(name));
  return true;
}

function baseName(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx >= 0 ? p.slice(idx + 1) : p;
}

function applyShortFlags(flagChars: string, fl: GrepFlags): void {
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
      default: break;
    }
  }
}

/** Parse grep's argv by hand: repeated `-e`/mixed positionals defeat the declarative ArgumentParser. */
function parseArgv(argv: readonly string[]): {
  patterns: string[]; patternFiles: string[]; files: string[]; fl: GrepFlags;
} {
  const fl: GrepFlags = {
    caseInsensitive: false, countOnly: false, recursive: false, invert: false,
    lineNumbers: false, filesOnly: false, filesWithout: false, wholeWord: false,
    wholeLine: false, onlyMatching: false, quiet: false, suppressErrors: false,
    forceFilename: null, extended: false, fixed: false, perl: false,
    maxCount: Infinity, after: 0, before: 0, includeGlobs: [], excludeGlobs: [],
  };
  const patterns: string[] = [];
  const files: string[] = [];
  const patternFiles: string[] = [];
  let patternGiven = false;

  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { i++; break; }
    if (a === '-e' || a === '--regexp') { patterns.push(argv[++i] ?? ''); patternGiven = true; continue; }
    if (a.startsWith('--regexp=')) { patterns.push(a.slice(9)); patternGiven = true; continue; }
    if (a === '-f' || a === '--file') { patternFiles.push(argv[++i] ?? ''); patternGiven = true; continue; }
    if (a.startsWith('--file=')) { patternFiles.push(a.slice(7)); patternGiven = true; continue; }
    if (a === '-m' || a === '--max-count') { fl.maxCount = parseInt(argv[++i], 10) || 0; continue; }
    if (a.startsWith('--max-count=')) { fl.maxCount = parseInt(a.slice(12), 10) || 0; continue; }
    if (a === '-A' || a === '--after-context') { fl.after = parseInt(argv[++i], 10) || 0; continue; }
    if (/^-A\d+$/.test(a)) { fl.after = parseInt(a.slice(2), 10) || 0; continue; }
    if (a === '-B' || a === '--before-context') { fl.before = parseInt(argv[++i], 10) || 0; continue; }
    if (/^-B\d+$/.test(a)) { fl.before = parseInt(a.slice(2), 10) || 0; continue; }
    if (a === '-C' || a === '--context') { const n = parseInt(argv[++i], 10) || 0; fl.after = n; fl.before = n; continue; }
    if (/^-C\d+$/.test(a)) { const n = parseInt(a.slice(2), 10) || 0; fl.after = n; fl.before = n; continue; }
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
    if (a.startsWith('-') && a.length > 1 && !a.startsWith('--')) { applyShortFlags(a.slice(1), fl); continue; }
    if (a.startsWith('--')) continue;
    if (!patternGiven) { patterns.push(a); patternGiven = true; continue; }
    files.push(a);
  }
  for (; i < argv.length; i++) {
    if (!patternGiven) { patterns.push(argv[i]); patternGiven = true; continue; }
    files.push(argv[i]);
  }
  return { patterns, patternFiles, files, fl };
}

async function readPatternsFromFile(
  ctx: CommandContext, path: string, actor: FileSystemActor, patterns: string[],
): Promise<void> {
  const resolved = ctx.machine.fs.resolve(ctx.session.cwd, path);
  let content: string;
  try {
    content = await ctx.machine.fs.readFile(resolved, actor);
  } catch {
    return;
  }
  const { lines } = splitLines(content);
  for (const line of lines) patterns.push(line);
}

async function collectFilesRecursive(
  ctx: CommandContext, actor: FileSystemActor, dir: string, out: string[],
): Promise<void> {
  const entries = await ctx.machine.fs.list(dir, actor).catch(() => []);
  for (const entry of entries) {
    if (entry.type === 'directory') await collectFilesRecursive(ctx, actor, entry.path, out);
    else if (entry.type === 'file') out.push(entry.path);
  }
}

export class GrepCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'grep',
    summary: 'Recherche un motif dans des fichiers ou l\'entrée standard',
    usage: 'grep [-ivnclLxwoqsrREFP] [-m N] [-e motif]... [-f fichier] <motif> [fichier...]',
    args: [
      { name: 'pattern', type: 'string', required: false, description: 'motif recherché' },
      { name: 'files', type: 'path', required: false, variadic: true, description: 'fichiers à parcourir' },
    ],
    options: [
      { long: 'ignore-case', short: 'i', takesValue: false, description: 'insensible à la casse' },
      { long: 'invert-match', short: 'v', takesValue: false, description: 'lignes ne correspondant pas' },
      { long: 'line-number', short: 'n', takesValue: false, description: 'préfixe le numéro de ligne' },
      { long: 'count', short: 'c', takesValue: false, description: 'affiche uniquement le nombre de correspondances' },
      { long: 'extended-regexp', short: 'E', takesValue: false, description: 'expression régulière étendue' },
      { long: 'basic-regexp', short: 'G', takesValue: false, description: 'expression régulière basique (défaut)' },
      { long: 'perl-regexp', short: 'P', takesValue: false, description: 'expression régulière Perl' },
      { long: 'fixed-strings', short: 'F', takesValue: false, description: 'motif littéral' },
      { long: 'word-regexp', short: 'w', takesValue: false, description: 'mots entiers uniquement' },
      { long: 'line-regexp', short: 'x', takesValue: false, description: 'lignes entières uniquement' },
      { long: 'only-matching', short: 'o', takesValue: false, description: 'affiche seulement la partie correspondante' },
      { long: 'quiet', short: 'q', takesValue: false, description: 'aucune sortie, code retour seulement' },
      { long: 'silent', takesValue: false, description: 'alias de --quiet' },
      { long: 'no-messages', short: 's', takesValue: false, description: 'supprime les erreurs de fichier manquant' },
      { long: 'recursive', short: 'r', takesValue: false, description: 'parcourt récursivement les répertoires' },
      { long: 'files-with-matches', short: 'l', takesValue: false, description: 'liste les fichiers correspondants' },
      { long: 'files-without-match', short: 'L', takesValue: false, description: 'liste les fichiers non correspondants' },
      { long: 'with-filename', short: 'H', takesValue: false, description: 'force le préfixe de nom de fichier' },
      { long: 'no-filename', short: 'h', takesValue: false, description: 'supprime le préfixe de nom de fichier' },
      { long: 'regexp', short: 'e', takesValue: true, description: 'motif (répétable)' },
      { long: 'file', short: 'f', takesValue: true, description: 'lit les motifs depuis un fichier' },
      { long: 'max-count', short: 'm', takesValue: true, type: 'string', description: 'arrête après N correspondances' },
      { long: 'after-context', short: 'A', takesValue: true, type: 'string', description: 'N lignes de contexte après' },
      { long: 'before-context', short: 'B', takesValue: true, type: 'string', description: 'N lignes de contexte avant' },
      { long: 'context', short: 'C', takesValue: true, type: 'string', description: 'N lignes de contexte' },
      { long: 'include', takesValue: true, description: 'limite -r aux noms correspondant au motif glob' },
      { long: 'exclude', takesValue: true, description: 'exclut les noms correspondant au motif glob' },
    ],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'texte',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const { patterns, patternFiles, files, fl } = parseArgv(ctx.rawArgv);
    const actor = toFileSystemActor(ctx.session.user);

    for (const path of patternFiles) {
      await readPatternsFromFile(ctx, path, actor, patterns);
    }

    if (patterns.length === 0) {
      await ctx.io.stderr.write('Usage: grep [OPTION]... PATTERN [FILE]...\n');
      return 2;
    }

    const matchers = patterns.map((p) => (fl.perl
      ? compilePcre(p, { ignoreCase: fl.caseInsensitive, wholeWord: fl.wholeWord, wholeLine: fl.wholeLine })
      : compilePosix(p, {
          extended: fl.extended, fixed: fl.fixed, ignoreCase: fl.caseInsensitive,
          wholeWord: fl.wholeWord, wholeLine: fl.wholeLine, global: true,
        })));
    const lineMatches = (line: string): boolean => {
      const hit = matchers.some((re) => { re.lastIndex = 0; return re.test(line); });
      return hit !== fl.invert;
    };

    if (fl.recursive && files.length === 0) files.push('.');

    const results: string[] = [];
    const errors: string[] = [];
    let anyMatch = false;

    if (files.length === 0) {
      const content = await ctx.io.stdin.readAll();
      const lines = content.length === 0 ? [] : splitLines(content).lines.slice();
      const n = this.grepLines(lines, matchers, fl, false, '', lineMatches, results);
      if (n > 0) anyMatch = true;
      const exitCode = anyMatch ? 0 : 1;
      if (!fl.quiet) await ctx.io.stdout.write(results.length ? `${results.join('\n')}\n` : '');
      return exitCode;
    }

    const fileList: string[] = [];
    for (const f of files) {
      const abs = ctx.machine.fs.resolve(ctx.session.cwd, f);
      const st = await ctx.machine.fs.stat(abs, actor).catch(() => null);
      if (fl.recursive && st?.type === 'directory') await collectFilesRecursive(ctx, actor, abs, fileList);
      else fileList.push(f);
    }
    const filtered = fileList.filter((f) => includeExcludeOk(baseName(f), fl));
    const showFilename = fl.forceFilename !== null ? fl.forceFilename : (filtered.length > 1 || fl.recursive);

    for (const f of filtered) {
      const abs = ctx.machine.fs.resolve(ctx.session.cwd, f);
      let content: string;
      try {
        content = await ctx.machine.fs.readFile(abs, actor);
      } catch (err) {
        if (err instanceof FileSystemError) {
          if (!fl.suppressErrors) errors.push(`grep: ${f}: No such file or directory`);
          continue;
        }
        throw err;
      }
      const lines = content.length === 0 ? [] : splitLines(content).lines.slice();

      if (fl.quiet) {
        if (lines.some(lineMatches)) return 0;
        continue;
      }
      if (fl.filesOnly || fl.filesWithout) {
        const has = lines.some(lineMatches);
        if (has) anyMatch = true;
        if (fl.filesOnly && has) results.push(f);
        if (fl.filesWithout && !has) results.push(f);
        continue;
      }
      const n = this.grepLines(lines, matchers, fl, showFilename, f, lineMatches, results);
      if (n > 0) anyMatch = true;
    }

    if (fl.quiet) return errors.length > 0 ? 2 : 1;

    const exitCode = errors.length > 0 ? 2 : anyMatch ? 0 : 1;
    const out = [...errors, ...results];
    await ctx.io.stdout.write(out.length ? `${out.join('\n')}\n` : '');
    return exitCode;
  }

  private grepLines(
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
}
