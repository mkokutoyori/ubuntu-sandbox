import type { EditorFsContext } from '../EditorFsContext';
import { parseNanoNumber, type CommandLineMemory } from './NanoCommandLine';
import { fullPathOf } from './NanoOpening';
import { ELEMENT_OPTIONS, parseCombination, type ElementCombinations, type NanoElement } from './NanoPaint';
import { NANO_FLAGS, DEFAULT_TABSIZE, type NanoFlag, type NanoSettings } from './NanoSettings';
import { nanoHomeDirectory } from './NanoStateDirectory';

export type RcHost = Pick<EditorFsContext, 'identity' | 'readFile' | 'kindOf' | 'exists' | 'resolvePath' | 'canonicalPath' | 'readError' | 'homeDirectory' | 'environmentVariable'>;

export interface RcOutcome {
  readonly settings: NanoSettings;
  readonly errors: readonly string[];
  readonly startupProblem: string | null;
  readonly failure: string | null;
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

const SYNTAX_AND_BINDING_KEYWORDS: ReadonlySet<string> = new Set([
  'syntax', 'header', 'magic', 'color', 'icolor', 'comment', 'tabgives', 'linter', 'formatter',
  'extendsyntax', 'include', 'bind', 'unbind',
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
  readonly flags = new Map<RcFlagTarget, boolean>();
  readonly values: RcValues = {};
  readonly colors: { -readonly [E in NanoElement]?: ElementCombinations[E] } = {};
  readonly errors: string[] = [];
  startupProblem: string | null = null;
  file: string | null = null;
  private lineNumber = 0;

  jot(message: string): void {
    if (this.startupProblem === null && this.file !== null) this.startupProblem = `Mistakes in '${this.file}'`;
    this.errors.push(this.lineNumber > 0 ? `Error in ${this.file} on line ${this.lineNumber}: ${message}` : message);
  }

  parse(text: string): void {
    this.lineNumber = 0;
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    for (const raw of lines) {
      this.lineNumber++;
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      const trimmed = line.replace(/^[ \t]+/, '');
      if (trimmed === '' || trimmed.startsWith('#')) continue;
      const [keyword, rest] = splitWord(trimmed);
      if (keyword === 'set') this.option(rest, true);
      else if (keyword === 'unset') this.option(rest, false);
      else if (!SYNTAX_AND_BINDING_KEYWORDS.has(keyword)) this.jot(`Command "${keyword}" not understood`);
    }
    this.lineNumber = 0;
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
  if (cmd.ignorercfiles) return { settings: mergeRcSettings(cmd, invocation.memory, null), errors: [], startupProblem: null, failure: null };
  const reader = new RcReader();
  if (cmd.rcfile !== null) {
    const path = fullPathOf(cmd.rcfile, host);
    if (path === null || (host.kindOf?.(path) ?? (host.exists(path) ? 'file' : 'missing')) === 'missing') return { settings: cmd, errors: [], startupProblem: null, failure: 'Specified rcfile does not exist' };
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
  };
}
