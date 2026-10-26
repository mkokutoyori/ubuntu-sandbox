import type { EditorFsContext } from '../EditorFsContext';
import { parseNanoNumber, type CommandLineMemory } from './NanoCommandLine';
import { fullPathOf } from './NanoOpening';
import { ELEMENT_OPTIONS, parseCombination, type ElementCombinations, type NanoElement } from './NanoPaint';
import { NANO_FLAGS, DEFAULT_TABSIZE, type NanoFlag, type NanoSettings } from './NanoSettings';
import { nanoHomeDirectory } from './NanoStateDirectory';
import { GlobAborted, globPaths, type GlobFileSystem } from '@/network/devices/linux/fs/Glob';
import { nextWord, SyntaxCatalog, type RcLocation } from './NanoSyntax';

export type RcHost = Pick<EditorFsContext, 'identity' | 'readFile' | 'kindOf' | 'exists' | 'resolvePath' | 'canonicalPath' | 'readError' | 'homeDirectory' | 'environmentVariable' | 'listDirectory'>;

export interface RcOutcome {
  readonly settings: NanoSettings;
  readonly errors: readonly string[];
  readonly startupProblem: string | null;
  readonly failure: string | null;
  readonly catalog: SyntaxCatalog | null;
}

type RcFlagTarget = NanoFlag | 'nowrap';

const RC_FLAG_OPTIONS: Readonly<Record<string, RcFlagTarget>> = {
  afterends: 'afterends', allow_insecure_backup: 'insecurebackup', atblanks: 'atblanks', autoindent: 'autoindent',
  backup: 'backup', boldtext: 'boldtext', bookstyle: 'bookstyle', breaklonglines: 'breaklonglines',
  casesensitive: 'casesensitive', constantshow: 'constantshow', cutfromcursor: 'cutfromcursor', emptyline: 'emptyline',
  historylog: 'historylog', indicator: 'indicator', jumpyscrolling: 'jumpyscrolling', linenumbers: 'linenumbers',
  locking: 'locking', minibar: 'minibar', mouse: 'mouse', multibuffer: 'multibuffer',
  noconvert: 'noconvert', nohelp: 'nohelp', nonewlines: 'nonewlines', nowrap: 'nowrap', positionlog: 'positionlog',
  preserve: 'preserve', quickblank: 'quickblank', rawsequences: 'rawsequences', rebinddelete: 'rebinddelete',
  regexp: 'regexp', saveonexit: 'saveonexit', showcursor: 'showcursor', smarthome: 'smarthome', softwrap: 'softwrap',
  stateflags: 'stateflags', tabstospaces: 'tabstospaces', trimblanks: 'trimblanks', unix: 'unix',
  wordbounds: 'wordbounds', zap: 'zap', zero: 'zero',
};

const RC_VALUED_OPTIONS: ReadonlySet<string> = new Set([
  'brackets', 'fill', 'operatingdir', 'punct', 'quotestr', 'speller', 'backupdir', 'guidestripe',
  'matchbrackets', 'tabsize', 'whitespace', 'wordchars', ...Object.keys(ELEMENT_OPTIONS),
]);

const BLANK = /[ \t\u1680\u2000-\u2006\u2008-\u200A\u205F\u3000]/;

interface RcValues {
  fill?: number | null;
  tabsize?: number | null;
  guidestripe?: number | null;
  operatingdir?: string;
  quotestr?: string;
  speller?: string;
  backupdir?: string;
  wordchars?: string;
  brackets?: string;
  punct?: string;
  matchbrackets?: string;
  whitespace?: string;
}

class RcReader {
  constructor(private readonly host: RcHost) {}

  readonly flags = new Map<RcFlagTarget, boolean>();
  readonly values: RcValues = {};
  readonly colors: { -readonly [E in NanoElement]?: ElementCombinations[E] } = {};
  readonly errors: string[] = [];
  readonly catalog = new SyntaxCatalog();
  startupProblem: string | null = null;
  file: string | null = null;
  private lineNumber = 0;

  jot(message: string, at?: RcLocation): void {
    const file = at?.file ?? this.file;
    const line = at?.line ?? this.lineNumber;
    if (this.startupProblem === null && file !== null) this.startupProblem = `Mistakes in '${file}'`;
    this.errors.push(line > 0 ? `Error in ${file} on line ${line}: ${message}` : message);
  }

  private readonly report = (message: string, at?: RcLocation): void => this.jot(message, at);

  parse(text: string, included = false): void {
    this.lineNumber = 0;
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    for (const raw of lines) {
      this.lineNumber++;
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      const trimmed = line.replace(/^[ \t]+/, '');
      if (trimmed === '' || trimmed.startsWith('#')) continue;
      this.command(trimmed, lines, included);
    }
    this.catalog.checkNonEmpty(this.report);
    this.lineNumber = 0;
  }

  private command(trimmed: string, sourceLines: readonly string[], included: boolean): void {
    let [keyword, rest] = splitWord(trimmed);
    const here: RcLocation = { file: this.file!, line: this.lineNumber };
    let closesExtension = false;
    if (keyword === 'extendsyntax' && !included) {
      const outcome = this.catalog.extend(rest, here, this.report);
      if (outcome.applyImmediately === null) return;
      [keyword, rest] = nextWord(outcome.applyImmediately);
      closesExtension = true;
    }
    if (included && ['set', 'unset', 'bind', 'unbind', 'include', 'extendsyntax'].includes(keyword)) this.jot(`Command "${keyword}" not allowed in included file`);
    else if (keyword === 'syntax') {
      this.catalog.checkNonEmpty(this.report);
      this.catalog.begin(rest, here, sourceLines, this.report);
    } else if (keyword === 'header') this.catalog.header(rest, this.report);
    else if (['color', 'icolor', 'comment', 'tabgives', 'linter', 'formatter'].includes(keyword)) this.catalog.noteBodyCommand(keyword, this.report);
    else if (keyword === 'include') this.include(rest);
    else if (keyword === 'set' || keyword === 'unset') {
      this.catalog.checkNonEmpty(this.report);
      this.option(rest, keyword === 'set');
    } else if (keyword === 'bind' || keyword === 'unbind') this.catalog.checkNonEmpty(this.report);
    else if (keyword !== 'magic') this.jot(`Command "${keyword}" not understood`);
    if (closesExtension) this.catalog.closeImmediateExtension();
  }

  private include(argument: string): void {
    this.catalog.checkNonEmpty(this.report);
    let pattern = splitWord(argument)[0];
    if (argument.startsWith('"')) {
      const last = argument.lastIndexOf('"');
      if (last <= 0) {
        this.jot(`Argument '${argument}' has an unterminated "`);
        pattern = argument.slice(1);
      } else pattern = argument.slice(1, last);
    }
    const home = nanoHomeDirectory(this.host);
    const expanded = home !== null && (pattern === '~' || pattern.startsWith('~/')) ? `${home}${pattern.slice(1)}` : pattern;
    let matches: string[];
    try {
      matches = globPaths(globFileSystem(this.host), expanded, { abortOnUnreadable: true });
    } catch (error) {
      if (!(error instanceof GlobAborted)) throw error;
      this.jot(`Error expanding ${pattern}: ${this.unreadableReason(error.directory)}`);
      return;
    }
    if (matches.length === 0) matches = [expanded.length > 1 ? expanded.replace(/\/$/, '') : expanded];
    for (const file of matches) this.includeFile(file);
  }

  private unreadableReason(directory: string): string {
    const kind = this.host.kindOf?.(this.host.resolvePath(directory)) ?? 'missing';
    if (kind === 'missing') return 'No such file or directory';
    if (kind !== 'directory') return 'Not a directory';
    return this.host.readError?.(this.host.resolvePath(directory)) ?? 'Permission denied';
  }

  private includeFile(file: string): void {
    const kind = file === '' ? 'missing' : this.host.kindOf?.(file) ?? (this.host.exists(file) ? 'file' : 'missing');
    const refusal = kind === 'missing' ? 'No such file or directory' : this.host.readError?.(file) ?? null;
    if (refusal === null && (kind === 'directory' || kind === 'device')) {
      this.jot(kind === 'directory' ? `"${file}" is a directory` : `"${file}" is a device file`);
      return;
    }
    const content = refusal === null ? this.host.readFile(file) : null;
    if (content === null) {
      this.jot(`Error reading ${file}: ${refusal ?? 'No such file or directory'}`);
      return;
    }
    const outerFile = this.file;
    const outerLine = this.lineNumber;
    this.file = file;
    this.parse(content, true);
    this.file = outerFile;
    this.lineNumber = outerLine;
  }

  private option(rest: string, enabling: boolean): void {
    if (rest === '') { this.jot('Missing option'); return; }
    const [name, afterName] = splitWord(rest);
    const flag = RC_FLAG_OPTIONS[name];
    if (flag === undefined && !RC_VALUED_OPTIONS.has(name)) { this.jot(`Unknown option: ${name}`); return; }
    if (flag !== undefined) { this.flags.set(flag, enabling); return; }
    if (!enabling) { this.jot(`Cannot unset option "${name}"`); return; }
    if (afterName === '') { this.jot(`Option "${name}" requires an argument`); return; }
    this.valued(name, this.argumentOf(afterName));
  }

  private argumentOf(rest: string): string {
    if (!rest.startsWith('"')) return splitWord(rest)[0];
    const last = rest.lastIndexOf('"');
    if (last <= 0) {
      this.jot(`Argument '${rest}' has an unterminated "`);
      return rest.slice(1);
    }
    return rest.slice(1, last);
  }

  private valued(name: string, argument: string): void {
    const element = ELEMENT_OPTIONS[name];
    if (element !== undefined) {
      const outcome = parseCombination(argument);
      if ('error' in outcome) {
        this.jot(outcome.error);
        this.colors[element] = null;
      } else this.colors[element] = outcome.combination;
      return;
    }
    switch (name) {
      case 'operatingdir': this.values.operatingdir = argument; return;
      case 'fill': {
        const parsed = parseNanoNumber(argument);
        if (parsed === null) { this.jot(`Requested fill size "${argument}" is invalid`); this.values.fill = null; } else this.values.fill = parsed;
        return;
      }
      case 'matchbrackets':
        if (BLANK.test(argument)) this.jot('Non-blank characters required');
        else if ([...argument].length % 2 !== 0) this.jot('Even number of characters required');
        else this.values.matchbrackets = argument;
        return;
      case 'whitespace':
        if ([...argument].length !== 2) this.jot('Two single-column characters required');
        else this.values.whitespace = argument;
        return;
      case 'punct':
        if (BLANK.test(argument)) this.jot('Non-blank characters required');
        else this.values.punct = argument;
        return;
      case 'brackets':
        if (BLANK.test(argument)) this.jot('Non-blank characters required');
        else this.values.brackets = argument;
        return;
      case 'quotestr': this.values.quotestr = argument; return;
      case 'speller': this.values.speller = argument; return;
      case 'backupdir': this.values.backupdir = argument; return;
      case 'wordchars': this.values.wordchars = argument; return;
      case 'guidestripe': {
        const parsed = parseNanoNumber(argument);
        if (parsed === null || parsed <= 0) { this.jot(`Guide column "${argument}" is invalid`); this.values.guidestripe = null; } else this.values.guidestripe = parsed;
        return;
      }
      case 'tabsize': {
        const parsed = parseNanoNumber(argument);
        if (parsed === null || parsed <= 0) { this.jot(`Requested tab size "${argument}" is invalid`); this.values.tabsize = null; } else this.values.tabsize = parsed;
        return;
      }
    }
  }
}

function globFileSystem(host: RcHost): GlobFileSystem {
  const kind = (path: string) => host.kindOf?.(host.resolvePath(path)) ?? (host.exists(host.resolvePath(path)) ? 'file' : 'missing');
  return {
    listNames: (directory) => host.listDirectory?.(host.resolvePath(directory)) ?? null,
    existsNoFollow: (path) => kind(path) !== 'missing',
    isDirectory: (path) => kind(path) === 'directory',
  };
}

function splitWord(text: string): [string, string] {
  const end = text.search(/[ \t]/);
  if (end < 0) return [text, ''];
  return [text.slice(0, end), text.slice(end).replace(/^[ \t]+/, '')];
}

export function mergeRcSettings(cmd: NanoSettings, memory: CommandLineMemory, rc: RcReader | null): NanoSettings {
  const merged: { -readonly [K in keyof NanoSettings]: NanoSettings[K] } = { ...cmd };
  if (rc !== null) {
    for (const flag of NANO_FLAGS) {
      const fromRc = rc.flags.get(flag);
      if (fromRc !== undefined) merged[flag] = cmd[flag] || fromRc;
    }
    const wrapsAfterRc = rc.flags.get('nowrap') === false;
    merged.breaklonglines = memory.hardwrap ?? (rc.flags.get('breaklonglines') === true || wrapsAfterRc);
    const given = memory.given;
    const values = rc.values;
    if (!given.has('tabsize')) merged.tabsize = values.tabsize ?? DEFAULT_TABSIZE;
    if (!given.has('fill') && values.fill !== undefined) merged.fill = values.fill;
    if (!given.has('guidestripe') && values.guidestripe !== undefined) merged.guidestripe = values.guidestripe;
    if (!given.has('operatingdir') && !cmd.restricted && values.operatingdir !== undefined) merged.operatingdir = values.operatingdir;
    if (!given.has('quotestr') && values.quotestr !== undefined) merged.quotestr = values.quotestr;
    if (!given.has('speller') && values.speller !== undefined) merged.speller = values.speller;
    if (!given.has('backupdir') && values.backupdir !== undefined) merged.backupdir = values.backupdir;
    if (!given.has('wordchars') && values.wordchars !== undefined) merged.wordchars = values.wordchars;
    for (const field of ['brackets', 'punct', 'matchbrackets', 'whitespace'] as const) {
      if (values[field] !== undefined) merged[field] = values[field] ?? null;
    }
    if (Object.keys(rc.colors).length > 0) merged.colors = { ...rc.colors };
    if (merged.speller !== null) merged.speller = merged.speller.replace(/^[ \t]+/, '');
  }
  if (merged.restricted) {
    merged.backup = false;
    merged.historylog = false;
    merged.positionlog = false;
  }
  if (merged.rawsequences) merged.mouse = false;
  if (merged.zero) merged.nohelp = true;
  return merged;
}

function isGood(host: RcHost, reader: RcReader, path: string): boolean {
  const kind = host.kindOf?.(path) ?? (host.exists(path) ? 'file' : 'missing');
  if (kind === 'missing' || (host.readError?.(path) ?? null) !== null) return false;
  if (kind === 'directory' || kind === 'device') {
    reader.jot(kind === 'directory' ? `"${path}" is a directory` : `"${path}" is a device file`);
    return false;
  }
  return true;
}

function parseOne(host: RcHost, reader: RcReader, path: string): void {
  reader.file = path;
  const content = host.readFile(path);
  if (content !== null) reader.parse(content);
}

export function applyRcfiles(host: RcHost, invocation: { readonly settings: NanoSettings; readonly memory: CommandLineMemory }): RcOutcome {
  const cmd = invocation.settings;
  if (cmd.ignorercfiles) return { settings: mergeRcSettings(cmd, invocation.memory, null), errors: [], startupProblem: null, failure: null, catalog: null };
  const reader = new RcReader(host);
  if (cmd.rcfile !== null) {
    const path = fullPathOf(cmd.rcfile, host);
    if (path === null || (host.kindOf?.(path) ?? (host.exists(path) ? 'file' : 'missing')) === 'missing') return { settings: cmd, errors: [], startupProblem: null, failure: 'Specified rcfile does not exist', catalog: null };
    reader.file = path;
    if (isGood(host, reader, path)) parseOne(host, reader, path);
  } else {
    reader.file = '/etc/nanorc';
    if (isGood(host, reader, '/etc/nanorc')) parseOne(host, reader, '/etc/nanorc');
    const home = nanoHomeDirectory(host);
    const config = host.environmentVariable?.('XDG_CONFIG_HOME') ?? null;
    const candidates = [
      home === null ? null : `${home}/.nanorc`,
      config === null ? null : `${config}/nano/nanorc`,
      home === null ? null : `${home}/.config/nano/nanorc`,
    ];
    const chosen = candidates.find((candidate) => {
      if (candidate === null) return false;
      reader.file = candidate;
      return isGood(host, reader, candidate);
    });
    if (chosen !== undefined) parseOne(host, reader, chosen);
    else if (home === null && config === null) reader.jot("I can't find my home directory!  Wah!");
  }
  return {
    settings: mergeRcSettings(cmd, invocation.memory, reader),
    errors: reader.errors,
    startupProblem: reader.startupProblem,
    failure: null,
    catalog: reader.catalog.isEmpty ? null : reader.catalog,
  };
}
