import { simulationNowMs } from '@/network/core/SystemClock';
import type { ShellContext } from './LinuxFileCommands';
import { lsBlocksKiB, lsSize } from './LinuxFileCommands';
import { parseTouchDate, formatLsTime } from './time/FileTimes';
import { formatLocalTime } from './system/SystemInfo';
import { isFindType, type FindTimeTest, type FindType, type INode } from './VirtualFileSystem';
import { parseChmodMode } from './ChmodMode';
import { compilePosix } from './regex/PosixRegex';
import { PosixRegexError } from './regex/PosixEre';
import { compilePrintf, renderPrintf, PrintfFormatError, type CompiledPrintf, type PrintfEnvironment } from './FindPrintf';

export interface FindOutput {
  readonly text: string;
  readonly terminator: '\n' | '\0' | '';
  readonly stream: 'stdout' | 'stderr';
}

export interface FindHostResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface FindHost {
  readonly interactive: boolean;
  run(argv: string[], cwd: string): FindHostResult;
}

export interface FindRun {
  readonly path: string;
  readonly display: string;
  readonly start: string;
  readonly inode: INode;
  readonly link: INode;
  readonly depth: number;
  prune: boolean;
  quit: boolean;
}

type Predicate = (run: FindRun) => boolean;

export type FindFollow = 'none' | 'args' | 'all';

export interface FindPlan {
  readonly starts: string[];
  readonly expression: Predicate;
  readonly postOrder: boolean;
  readonly crossDevices: boolean;
  readonly follow: FindFollow;
  readonly maxdepth?: number;
  readonly mindepth?: number;
  readonly output: FindOutput[];
  readonly files: Map<string, string>;
  readonly finish: () => void;
  readonly state: { exitCode: number };
}

export type FindParse =
  | { readonly plan: FindPlan }
  | { readonly error: string; readonly exitCode: number }
  | { readonly text: string; readonly exitCode: number };

class FindSyntaxError extends Error {}

class FindEarlyExit extends Error {
  constructor(readonly text: string) { super(text); }
}

const OR = new Set(['-o', '-or']);
const AND = new Set(['-a', '-and']);
const NOT = new Set(['!', '-not']);
const OPEN = new Set(['(', '\\(']);
const CLOSE = new Set([')', '\\)']);

const ARGUMENTLESS_GLOBALS = new Set(['-noleaf', '-ignore_readdir_race', '-noignore_readdir_race']);

const PREDICATE_WITH_ARGUMENT = new Set([
  '-name', '-iname', '-path', '-ipath', '-wholename', '-iwholename', '-type', '-xtype', '-user', '-group', '-uid', '-gid', '-links', '-inum',
  '-used', '-lname', '-ilname', '-regex', '-iregex', '-regextype', '-size', '-perm', '-mtime', '-atime', '-ctime', '-mmin', '-amin', '-cmin',
  '-newer', '-anewer', '-cnewer', '-samefile', '-files0-from', '-maxdepth', '-mindepth', '-fstype', '-context', '-printf', '-fprint', '-fprint0', '-fls',
]);

export const FIND_USAGE = `Usage: find [-H] [-L] [-P] [-Olevel] [-D debugopts] [path...] [expression]

Default path is the current directory; default expression is -print.
Expression may consist of: operators, options, tests, and actions.

Operators (decreasing precedence; -and is implicit where no others are given):
      ( EXPR )   ! EXPR   -not EXPR   EXPR1 -a EXPR2   EXPR1 -and EXPR2
      EXPR1 -o EXPR2   EXPR1 -or EXPR2   EXPR1 , EXPR2

Positional options (always true):
      -daystart -follow -nowarn -regextype -warn

Normal options (always true, specified before other expressions):
      -depth -files0-from FILE -maxdepth LEVELS -mindepth LEVELS
       -mount -noleaf -xdev -ignore_readdir_race -noignore_readdir_race

Tests (N can be +N or -N or N):
      -amin N -anewer FILE -atime N -cmin N -cnewer FILE -context CONTEXT
      -ctime N -empty -false -fstype TYPE -gid N -group NAME -ilname PATTERN
      -iname PATTERN -inum N -iwholename PATTERN -iregex PATTERN
      -links N -lname PATTERN -mmin N -mtime N -name PATTERN -newer FILE
      -nouser -nogroup -path PATTERN -perm [-/]MODE -regex PATTERN
      -readable -writable -executable
      -wholename PATTERN -size N[bcwkMG] -true -type [bcdpflsD] -uid N
      -used N -user NAME -xtype [bcdpfls]

Actions:
      -delete -print0 -printf FORMAT -fprintf FILE FORMAT -print 
      -fprint0 FILE -fprint FILE -ls -fls FILE -prune -quit
      -exec COMMAND ; -exec COMMAND {} + -ok COMMAND ;
      -execdir COMMAND ; -execdir COMMAND {} + -okdir COMMAND ;

Other common options:
      --help                   display this help and exit
      --version                output version information and exit

Valid arguments for -D:
exec, opt, rates, search, stat, time, tree, all, help
Use '-D help' for a description of the options, or see find(1)

Please see also the documentation at https://www.gnu.org/software/findutils/.
You can report (and track progress on fixing) bugs in the "find"
program via the GNU findutils bug-reporting page at
https://savannah.gnu.org/bugs/?group=findutils or, if
you have no web access, by sending email to <bug-findutils@gnu.org>.`;

export const FIND_VERSION = `find (GNU findutils) 4.8.0
Copyright (C) 2021 Free Software Foundation, Inc.
License GPLv3+: GNU GPL version 3 or later <https://gnu.org/licenses/gpl.html>.
This is free software: you are free to change and redistribute it.
There is NO WARRANTY, to the extent permitted by law.

Written by Eric B. Decker, James Youngman, and Kevin Dalley.
Features enabled: D_TYPE O_NOFOLLOW(enabled) LEAF_OPTIMISATION FTS(FTS_CWDFD) CBO(level=2) `;

export const FIND_DEBUG_HELP = `Valid arguments for -D:
exec       Show diagnostic information relating to -exec, -execdir, -ok and -okdir
opt        Show diagnostic information relating to optimisation
rates      Indicate how often each predicate succeeded
search     Navigate the directory tree verbosely
stat       Trace calls to stat(2) and lstat(2)
time       Show diagnostic information relating to time-of-day and timestamp comparisons
tree       Display the expression tree
all        Set all of the debug flags (but help)
help       Explain the various -D options`;

const DEBUG_FLAGS = new Set(['exec', 'opt', 'rates', 'search', 'stat', 'time', 'tree', 'all']);

const SIZE_UNITS: Readonly<Record<string, number>> = { b: 512, c: 1, w: 2, k: 1024, M: 1024 ** 2, G: 1024 ** 3 };

function parseSizeSpec(raw: string): { op: '+' | '-' | '='; count: number; unit: number } {
  if (raw === '') throw new FindSyntaxError('find: invalid null argument to -size');
  const match = /^([+-]?)(\d*)(.*)$/s.exec(raw) as RegExpExecArray;
  const [, signText, digits, restText] = match;
  let sign = signText;
  let rest = restText;
  if (digits === '') { rest = raw; sign = ''; }
  let unitLetter = 'b';
  if (rest !== '') {
    unitLetter = rest[0];
    const unknown = !(unitLetter in SIZE_UNITS);
    if (unknown && (digits === '' || /[A-Za-z]/.test(unitLetter))) throw new FindSyntaxError(`find: invalid -size type \`${unitLetter}'`);
    if (unknown || rest.length > 1) throw new FindSyntaxError(`find: Invalid argument \`${raw}' to -size`);
  }
  return { op: sign === '+' ? '+' : sign === '-' ? '-' : '=', count: Number(digits), unit: SIZE_UNITS[unitLetter] };
}

function compare(op: '+' | '-' | '=', value: number, count: number): boolean {
  return op === '+' ? value > count : op === '-' ? value < count : value === count;
}

function numericTest(raw: string, name: string): (value: number) => boolean {
  const match = /^([+-]?)(\d+)$/.exec(raw);
  if (match === null) throw new FindSyntaxError(`find: invalid argument \`${raw}' to \`${name}'`);
  const n = Number(match[2]);
  return match[1] === '+' ? (value) => value > n : match[1] === '-' ? (value) => value < n : (value) => value === n;
}

const BRE_TYPES = new Set(['posix-basic', 'grep', 'ed', 'sed', 'posix-minimal-basic']);
const ERE_TYPES = new Set(['posix-extended', 'egrep', 'posix-egrep', 'awk', 'posix-awk', 'gnu-awk']);
const REGEX_TYPES = ['findutils-default', 'ed', 'emacs', 'gnu-awk', 'grep', 'posix-awk', 'awk', 'posix-basic', 'posix-egrep', 'egrep', 'posix-extended', 'posix-minimal-basic', 'sed'];

function emacsToJs(pattern: string): string {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\' && i + 1 < pattern.length) {
      const next = pattern[++i];
      source += '(){}|'.includes(next) ? next : `\\${next}`;
    } else if ('(){}|'.includes(c)) source += `\\${c}`;
    else source += c;
  }
  return source;
}

function regexFrom(pattern: string, type: string, ignoreCase: boolean): RegExp {
  try {
    if (BRE_TYPES.has(type) || ERE_TYPES.has(type)) {
      const re = compilePosix(pattern, { extended: ERE_TYPES.has(type), ignoreCase, rightParenIsError: true });
      return new RegExp(`^(?:${re.source})$`, re.flags.replace('g', '') + 's');
    }
    const re = compilePosix(emacsToJs(pattern), { extended: true, ignoreCase, rightParenIsError: true });
    return new RegExp(`^(?:${re.source})$`, re.flags.replace('g', '') + 's');
  } catch (error) {
    const reason = error instanceof PosixRegexError ? error.message : 'Invalid regular expression';
    throw new FindSyntaxError(`find: failed to compile regular expression '${pattern}': ${reason}`);
  }
}

function accessAllowed(ctx: ShellContext, inode: INode, bit: number): boolean {
  if (ctx.uid === 0) return bit !== 1 || inode.type === 'directory' || (inode.permissions & 0o111) !== 0;
  const shift = inode.uid === ctx.uid ? 6 : inode.gid === ctx.gid ? 3 : 0;
  return ((inode.permissions >> shift) & bit) !== 0;
}

function typeLetter(inode: INode): string {
  switch (inode.type) {
    case 'directory': return 'd';
    case 'symlink': return 'l';
    case 'fifo': return 'p';
    case 'socket': return 's';
    case 'chardev': return 'c';
    default: return 'f';
  }
}

function typeLetters(raw: string, option: string): string[] {
  if (raw === '') throw new FindSyntaxError(`find: Arguments to ${option} should contain at least one letter`);
  const letters: string[] = [];
  const parts = raw.split(',');
  parts.forEach((part, index) => {
    if (part === '') {
      if (index === parts.length - 1) throw new FindSyntaxError(`find: Last file type in list argument to ${option} is missing, i.e., list is ending on: ','`);
      throw new FindSyntaxError(`find: Unknown argument to ${option}: ,`);
    }
    if (part.length > 1) throw new FindSyntaxError(`find: Must separate multiple arguments to ${option} using: ','`);
    if (!isFindType(part)) throw new FindSyntaxError(`find: Unknown argument to ${option}: ${part}`);
    if (letters.includes(part)) throw new FindSyntaxError(`find: Duplicate file type '${part}' in the argument list to ${option}.`);
    letters.push(part);
  });
  return letters;
}

function fsTypeOf(ctx: ShellContext, absPath: string): string {
  const table = ctx.vfs.readFile('/proc/mounts');
  if (table === null) return 'ext4';
  let best = { length: -1, type: 'ext4' };
  for (const line of table.split('\n')) {
    const [, mountPoint, type] = line.split(/\s+/);
    if (mountPoint === undefined || type === undefined) continue;
    const prefix = mountPoint === '/' ? '' : mountPoint;
    if ((absPath === mountPoint || absPath.startsWith(`${prefix}/`) || mountPoint === '/') && mountPoint.length > best.length) best = { length: mountPoint.length, type };
  }
  return best.type;
}

interface ExecSpec {
  readonly name: string;
  readonly words: string[];
  readonly batch: boolean;
  readonly prompt: boolean;
  readonly inDirectory: boolean;
}

class FindParser {
  private position = 0;
  private hasAction = false;
  private postOrder = false;
  private crossDevices = true;
  private follow: FindFollow = 'none';
  private maxdepth: number | undefined;
  private mindepth: number | undefined;
  private dayStart = false;
  private warn: boolean;
  private lastTest: string | null = null;
  private regexType = 'findutils-default';
  private answers: string[] | null = null;
  readonly output: FindOutput[] = [];
  readonly files = new Map<string, string>();
  readonly state = { exitCode: 0 };
  private readonly batches: Array<{ spec: ExecSpec; directory: string; paths: string[] }> = [];

  constructor(
    private readonly ctx: ShellContext,
    private readonly tokens: readonly string[],
    private readonly host: FindHost | undefined,
    private readonly stdin: string | undefined,
  ) {
    this.warn = host?.interactive ?? false;
  }

  private peek(): string | undefined { return this.tokens[this.position]; }

  private argument(name: string): string {
    const value = this.tokens[this.position++];
    if (value === undefined) throw new FindSyntaxError(`find: missing argument to \`${name}'`);
    return value;
  }

  setFollow(mode: FindFollow): void { this.follow = mode; }

  parse(startsEnd: number): FindPlan {
    this.position = startsEnd;
    let expression: Predicate = () => true;
    if (this.position < this.tokens.length) {
      expression = this.parseList(0);
      if (this.position < this.tokens.length) {
        const token = this.tokens[this.position];
        if (CLOSE.has(token)) throw new FindSyntaxError("find: you have too many ')'");
        throw new FindSyntaxError(this.pathsMustPrecede(token));
      }
    }
    if (!this.hasAction) {
      const inner = expression;
      const print = this.printAction('\n');
      expression = (run) => inner(run) && print(run);
    }
    return {
      starts: [], expression, postOrder: this.postOrder, crossDevices: this.crossDevices, follow: this.follow,
      maxdepth: this.maxdepth, mindepth: this.mindepth, output: this.output, files: this.files,
      finish: () => this.flushBatches(), state: this.state,
    };
  }

  private pathsMustPrecede(token: string): string {
    const abs = this.ctx.vfs.normalizePath(token, this.ctx.cwd);
    let message = `find: paths must precede expression: \`${token}'`;
    if (this.ctx.vfs.exists(abs) || this.ctx.vfs.lstat(abs) !== null) {
      const index = this.position;
      const previous = this.tokens[index - 1];
      const before = this.tokens[index - 2];
      const named = previous !== undefined && previous.startsWith('-') && !PREDICATE_WITH_ARGUMENT.has(previous) ? previous
        : before !== undefined && PREDICATE_WITH_ARGUMENT.has(before) ? before : null;
      if (named !== null) message += `\nfind: possible unquoted pattern after predicate \`${named}'?`;
    }
    return message;
  }

  private parseOr(depth: number): Predicate {
    let left = this.parseAnd(depth);
    while (this.peek() !== undefined && OR.has(this.peek() as string)) {
      const operator = this.tokens[this.position++];
      if (this.position >= this.tokens.length) throw new FindSyntaxError(`find: expected an expression after '${operator}'`);
      if (CLOSE.has(this.tokens[this.position])) throw new FindSyntaxError(`find: expected an expression between '${operator}' and ')'`);
      const a = left;
      const b = this.parseAnd(depth);
      left = (run) => a(run) || (!run.quit && b(run));
    }
    return left;
  }

  private parseList(depth: number): Predicate {
    let left = this.parseOr(depth);
    while (this.peek() === ',') {
      this.position++;
      if (this.position >= this.tokens.length || CLOSE.has(this.tokens[this.position])) {
        throw new FindSyntaxError("find: expected an expression after ','");
      }
      const a = left;
      const b = this.parseOr(depth);
      left = (run) => { a(run); return !run.quit && b(run); };
    }
    return left;
  }

  private parseAnd(depth: number): Predicate {
    let left = this.parseNot(depth);
    for (;;) {
      const token = this.peek();
      if (token === undefined || OR.has(token) || CLOSE.has(token) || token === ',') return left;
      if (AND.has(token)) {
        this.position++;
        if (this.position >= this.tokens.length) throw new FindSyntaxError(`find: expected an expression after '${token}'`);
      }
      const a = left;
      const b = this.parseNot(depth);
      left = (run) => a(run) && !run.quit && b(run);
    }
  }

  private parseNot(depth: number): Predicate {
    const token = this.peek();
    if (token !== undefined && NOT.has(token)) {
      this.position++;
      if (this.position >= this.tokens.length || CLOSE.has(this.tokens[this.position])) {
        throw new FindSyntaxError(`find: expected an expression after '${token}'`);
      }
      const operand = this.parseNot(depth);
      return (run) => !operand(run);
    }
    return this.parsePrimary(depth);
  }

  private parsePrimary(depth: number): Predicate {
    const token = this.tokens[this.position++];
    if (token === undefined) throw new FindSyntaxError('find: expected an expression after the last predicate');
    if (OR.has(token) || AND.has(token) || token === ',') {
      throw new FindSyntaxError(`find: invalid expression; you have used a binary operator '${token}' with nothing before it.`);
    }
    if (OPEN.has(token)) {
      if (this.position >= this.tokens.length) {
        throw new FindSyntaxError("find: invalid expression; expected to find a ')' but didn't see one. Perhaps you need an extra predicate after '('");
      }
      if (CLOSE.has(this.tokens[this.position])) throw new FindSyntaxError('find: invalid expression; empty parentheses are not allowed.');
      const inner = this.parseList(depth + 1);
      const close = this.tokens[this.position++];
      if (close === undefined || !CLOSE.has(close)) {
        throw new FindSyntaxError("find: invalid expression; I was expecting to find a ')' somewhere but did not see one.");
      }
      return inner;
    }
    if (CLOSE.has(token)) throw new FindSyntaxError("find: you have too many ')'");
    if (!token.startsWith('-')) {
      this.position--;
      throw new FindSyntaxError(this.pathsMustPrecede(token));
    }
    const GLOBAL = ['-maxdepth', '-mindepth', '-depth', '-d', '-xdev', '-mount', '-noleaf'];
    if (GLOBAL.includes(token)) {
      if (this.warn && this.lastTest !== null) {
        this.warning(`find: warning: you have specified the global option ${token} after the argument ${this.lastTest}, but global options are not positional, i.e., ${token} affects tests specified before it as well as those specified after it.  Please specify global options before other arguments.`);
      }
    } else if (token !== '-warn' && token !== '-nowarn') {
      this.lastTest = token;
    }
    return this.predicate(token);
  }

  private target(run: FindRun): INode {
    if (run.inode.type !== 'symlink') return run.inode;
    return this.ctx.vfs.resolveInode(run.path, true) ?? { ...run.inode, permissions: 0, uid: -1, gid: -1 };
  }

  private criteria(options: Record<string, unknown>, useDisplay = true): Predicate {
    return (run) => this.ctx.vfs.matchesFindCriteria(useDisplay ? run.display : run.path, run.inode, options);
  }

  private emit(text: string, terminator: '\n' | '\0' | '', stream: 'stdout' | 'stderr' = 'stdout'): void {
    this.output.push({ text, terminator, stream });
  }

  private warning(message: string): void {
    this.emit(message, '\n', 'stderr');
  }

  private fail(message: string): void {
    this.emit(message, '\n', 'stderr');
    this.state.exitCode = 1;
  }

  private sink(name: string): (text: string) => void {
    if (name === '/dev/stdout') return (text) => this.emit(text, '');
    if (name === '/dev/stderr') return (text) => this.emit(text, '', 'stderr');
    const abs = this.ctx.vfs.normalizePath(name, this.ctx.cwd);
    const created = this.ctx.vfs.writeFile(abs, '', this.ctx.uid, this.ctx.gid, 0o022, false, undefined, false);
    if (!created) throw new FindSyntaxError(`find: '${name}': No such file or directory`);
    this.files.set(abs, '');
    return (text) => { this.files.set(abs, (this.files.get(abs) ?? '') + text); };
  }

  private printAction(terminator: '\n' | '\0'): Predicate {
    this.hasAction = true;
    return (run) => { this.emit(run.display, terminator); return true; };
  }

  private printfEnvironment(): PrintfEnvironment {
    const ctx = this.ctx;
    return {
      ctx,
      fsType: (path) => fsTypeOf(ctx, path),
      targetType: (path) => {
        const target = ctx.vfs.resolveInode(path, true);
        if (target === null) return ctx.vfs.symlinkLoops(path) ? 'L' : 'N';
        return typeLetter(target);
      },
      reportError: (message) => this.fail(message),
    };
  }

  private compileFormat(format: string): CompiledPrintf {
    let compiled: CompiledPrintf;
    try {
      compiled = compilePrintf(format);
    } catch (error) {
      if (error instanceof PrintfFormatError) throw new FindSyntaxError(error.message);
      throw error;
    }
    for (const message of compiled.warnings) this.warning(message);
    return compiled;
  }

  private dayOrigin(): number | undefined {
    if (!this.dayStart) return undefined;
    const now = this.ctx.nowMs?.() ?? simulationNowMs();
    const [h, m, s] = formatLocalTime('%H:%M:%S', now, this.ctx.zone).split(':').map(Number);
    return now - ((h * 60 + m) * 60 + s) * 1000 + 86_400_000;
  }

  private lsLine(run: FindRun): string {
    const ctx = this.ctx;
    const inode = run.inode;
    const now = ctx.nowMs?.() ?? simulationNowMs();
    const owner = ctx.userMgr.getUserByUid(inode.uid)?.username ?? String(inode.uid);
    const group = ctx.userMgr.getGroupByGid(inode.gid)?.name ?? String(inode.gid);
    const name = inode.type === 'symlink' ? `${run.display} -> ${inode.target}` : run.display;
    return [
      String(inode.id).padStart(9), String(lsBlocksKiB(inode)).padStart(6), ctx.vfs.formatPermissions(inode),
      String(inode.linkCount).padStart(3), owner.padEnd(8), group.padEnd(8), String(lsSize(inode)).padStart(8),
      formatLsTime(null, inode.mtime, ctx.zone, now), name,
    ].join(' ');
  }

  private promptAnswer(): boolean {
    if (this.answers === null) this.answers = (this.stdin ?? '').split('\n');
    const answer = this.answers.shift();
    return answer !== undefined && /^[yY]/.test(answer);
  }

  private execPredicate(token: string): Predicate {
    const words: string[] = [];
    let batch = false;
    for (;;) {
      const word = this.tokens[this.position++];
      if (word === undefined) throw new FindSyntaxError(`find: missing argument to \`${token}'`);
      if (word === ';') break;
      if (word === '+' && words[words.length - 1]?.endsWith('{}') && (token === '-exec' || token === '-execdir')) { batch = true; break; }
      words.push(word);
    }
    if (words.length === 0) throw new FindSyntaxError(`find: invalid argument \`;' to \`${token}'`);
    if (batch) {
      const holders = words.filter((word) => word.includes('{}'));
      if (holders.length > 1) throw new FindSyntaxError('find: Only one instance of {} is supported with -exec ... +');
      const bad = holders.find((word) => word !== '{}');
      if (bad !== undefined) throw new FindSyntaxError(`find: In '-exec ... {} +' the '{}' must appear by itself, but you specified '${bad}'`);
    }
    this.hasAction = true;
    const spec: ExecSpec = { name: token, words, batch, prompt: token === '-ok' || token === '-okdir', inDirectory: token === '-execdir' || token === '-okdir' };
    const host = this.host;
    return (run) => {
      const slash = run.path.lastIndexOf('/');
      const directory = spec.inDirectory ? (slash <= 0 ? '/' : run.path.slice(0, slash)) : this.ctx.cwd;
      const shown = spec.inDirectory ? `./${run.display.split('/').pop() ?? run.display}` : run.display;
      if (spec.batch) {
        const pending = this.batches.find((entry) => entry.spec === spec && entry.directory === directory);
        if (pending) pending.paths.push(shown); else this.batches.push({ spec, directory, paths: [shown] });
        return true;
      }
      const argv = spec.words.map((word) => word.split('{}').join(shown));
      if (spec.prompt) {
        this.emit(`< ${argv[0]} ... ${shown} > ? `, '', 'stderr');
        if (!this.promptAnswer()) return false;
      }
      if (host === undefined) return false;
      const result = host.run(argv, directory);
      return this.consume(argv[0], result);
    };
  }

  private consume(command: string, result: FindHostResult): boolean {
    if (result.exitCode === 127 && /not found/.test(result.stderr + result.stdout)) {
      this.emit(`find: '${command}': No such file or directory`, '\n', 'stderr');
      return false;
    }
    if (result.stdout !== '') this.emit(result.stdout, '');
    if (result.stderr !== '') this.emit(result.stderr, '', 'stderr');
    return result.exitCode === 0;
  }

  flushBatches(): void {
    const host = this.host;
    for (const entry of this.batches) {
      if (host === undefined) continue;
      const argv = entry.spec.words.flatMap((word) => (word === '{}' ? entry.paths : [word]));
      const result = host.run(argv, entry.directory);
      if (!this.consume(argv[0], result)) this.state.exitCode = 1;
    }
    this.batches.length = 0;
  }

  private predicate(token: string): Predicate {
    const ctx = this.ctx;
    switch (token) {
      case '-name': return this.criteria({ name: this.argument(token) });
      case '-iname': return this.criteria({ iname: this.argument(token) });
      case '-path': case '-wholename': return this.criteria({ path: this.argument(token) });
      case '-ipath': case '-iwholename': return this.criteria({ ipath: this.argument(token) });
      case '-type': {
        const tests = typeLetters(this.argument(token), token).map((t) => this.criteria({ type: t as FindType }));
        return (run) => tests.some((test) => test(run));
      }
      case '-xtype': {
        const letters = typeLetters(this.argument(token), token);
        return (run) => {
          let node: INode;
          if (this.follow === 'all') node = run.link;
          else if (run.link.type === 'symlink') {
            const resolved = ctx.vfs.resolveInode(run.path, true);
            if (resolved === null && ctx.vfs.symlinkLoops(run.path)) {
              this.fail(`find: '${run.display}': Too many levels of symbolic links`);
              return false;
            }
            node = resolved ?? run.link;
          } else node = run.link;
          return letters.includes(typeLetter(node));
        };
      }
      case '-empty': return (run) => {
        if (run.inode.type === 'directory') return run.inode.children.size <= 2;
        return run.inode.type === 'file' && run.inode.size === 0;
      };
      case '-true': return () => true;
      case '-false': return () => false;
      case '-user': {
        const name = this.argument(token);
        if (name === '') throw new FindSyntaxError('find: The argument to -user should not be empty');
        const uid = ctx.userMgr.resolveUid(name);
        if (uid >= 0) return this.criteria({ user: uid });
        if (/^\d+$/.test(name)) return this.criteria({ user: Number(name) });
        throw new FindSyntaxError(`find: '${name}' is not the name of a known user`);
      }
      case '-group': {
        const name = this.argument(token);
        if (name === '') throw new FindSyntaxError('find: argument to -group is empty, but should be a group name');
        const gid = ctx.userMgr.resolveGid(name);
        if (gid >= 0) return this.criteria({ group: gid });
        if (/^\d+$/.test(name)) return this.criteria({ group: Number(name) });
        throw new FindSyntaxError(`find: '${name}' is not the name of an existing group`);
      }
      case '-uid': { const test = numericTest(this.argument(token), token); return (run) => test(run.inode.uid); }
      case '-gid': { const test = numericTest(this.argument(token), token); return (run) => test(run.inode.gid); }
      case '-links': { const test = numericTest(this.argument(token), token); return (run) => test(run.inode.linkCount); }
      case '-inum': { const test = numericTest(this.argument(token), token); return (run) => test(run.inode.id); }
      case '-used': {
        const test = numericTest(this.argument(token), token);
        return (run) => {
          const days = (run.inode.atime - run.inode.ctime) / 86_400_000;
          return test(days > 0 ? Math.ceil(days) : days < 0 ? -Math.ceil(-days) : 0);
        };
      }
      case '-nouser': return (run) => ctx.userMgr.getUserByUid(run.inode.uid) === undefined;
      case '-nogroup': return (run) => ctx.userMgr.getGroupByGid(run.inode.gid) === undefined;
      case '-readable': return (run) => accessAllowed(ctx, this.target(run), 4);
      case '-writable': return (run) => accessAllowed(ctx, this.target(run), 2);
      case '-executable': return (run) => accessAllowed(ctx, this.target(run), 1);
      case '-samefile': {
        const name = this.argument(token);
        const reference = ctx.vfs.resolveInode(ctx.vfs.normalizePath(name, ctx.cwd));
        if (!reference) throw new FindSyntaxError(`find: '${name}': No such file or directory`);
        return (run) => run.inode.id === reference.id;
      }
      case '-lname': case '-ilname': {
        const pattern = this.argument(token);
        const fold = token === '-ilname';
        return (run) => run.link.type === 'symlink'
          && ctx.vfs.globMatch(fold ? run.link.target.toLowerCase() : run.link.target, fold ? pattern.toLowerCase() : pattern);
      }
      case '-regex': case '-iregex': {
        const regex = regexFrom(this.argument(token), this.regexType, token === '-iregex');
        return (run) => regex.test(run.display);
      }
      case '-regextype': {
        const type = this.argument(token);
        if (!REGEX_TYPES.includes(type) && type !== 'emacs') {
          throw new FindSyntaxError(`find: Unknown regular expression type '${type}'; valid types are ${REGEX_TYPES.map((name) => `'${name}'`).join(', ')}.`);
        }
        this.regexType = type;
        return () => true;
      }
      case '-size': {
        const spec = parseSizeSpec(this.argument(token));
        return (run) => compare(spec.op, Math.ceil(lsSize(run.inode) / spec.unit), spec.count);
      }
      case '-perm': {
        const raw = this.argument(token);
        const prefix = raw[0] === '-' || raw[0] === '/' ? raw[0] : '';
        const body = raw.slice(prefix.length);
        let mode: number | null = null;
        if (/^[0-7]+$/.test(body)) mode = body.length <= 4 ? parseInt(body, 8) : null;
        else if (body !== '' && /^[ugoa=+\-rwxXstugo,]+$/.test(body) && !body.endsWith(',')) mode = parseChmodMode(body, 0);
        if (mode === null || prefix === '' && raw.startsWith('+')) throw new FindSyntaxError(`find: invalid mode '${raw}'`);
        if (prefix === '/' && mode === 0) {
          this.warning(`find: warning: you have specified a mode pattern ${raw} (which is equivalent to /000). The meaning of -perm /000 has now been changed to be consistent with -perm -000; that is, while it used to match no files, it now matches all files.`);
        }
        return this.criteria({ perm: { kind: prefix === '-' ? 'all' : prefix === '/' ? 'any' : 'exact', mode } });
      }
      case '-mtime': case '-atime': case '-ctime': case '-mmin': case '-amin': case '-cmin': {
        const raw = this.argument(token);
        const match = /^([+-]?)(\d+)$/.exec(raw);
        if (match === null) throw new FindSyntaxError(`find: invalid argument \`${raw}' to \`${token}'`);
        const test: FindTimeTest = {
          kind: 'age',
          field: token[1] === 'a' ? 'atime' : token[1] === 'c' ? 'ctime' : 'mtime',
          unit: token.endsWith('min') ? 'min' : 'day',
          op: match[1] === '' ? '=' : (match[1] as '+' | '-'),
          n: Number(match[2]),
          originMs: this.dayOrigin(),
        };
        return this.criteria({ timeTests: [test] });
      }
      case '-newer': case '-anewer': case '-cnewer': {
        const name = this.argument(token);
        const reference = ctx.vfs.resolveInode(ctx.vfs.normalizePath(name, ctx.cwd));
        if (!reference) throw new FindSyntaxError(`find: '${name}': No such file or directory`);
        const field = token === '-anewer' ? 'atime' : token === '-cnewer' ? 'ctime' : 'mtime';
        return this.criteria({ timeTests: [{ kind: 'newer', field, thanMs: reference.mtime }] });
      }
      case '-fstype': {
        const type = this.argument(token);
        return (run) => fsTypeOf(ctx, run.path) === type;
      }
      case '-context': {
        this.argument(token);
        throw new FindSyntaxError('find: invalid predicate -context: SELinux is not enabled.');
      }
      case '-prune': return (run) => { run.prune = true; return true; };
      case '-quit': this.hasAction = true; return (run) => { run.quit = true; return true; };
      case '-print': return this.printAction('\n');
      case '-print0': return this.printAction('\0');
      case '-printf': {
        const compiled = this.compileFormat(this.argument(token));
        this.hasAction = true;
        const environment = this.printfEnvironment();
        return (run) => { this.emit(renderPrintf(compiled, run, environment), ''); return true; };
      }
      case '-fprintf': {
        const name = this.argument(token);
        const compiled = this.compileFormat(this.argument(token));
        const write = this.sink(name);
        this.hasAction = true;
        const environment = this.printfEnvironment();
        return (run) => { write(renderPrintf(compiled, run, environment)); return true; };
      }
      case '-fprint': case '-fprint0': {
        const write = this.sink(this.argument(token));
        this.hasAction = true;
        const terminator = token === '-fprint0' ? '\0' : '\n';
        return (run) => { write(run.display + terminator); return true; };
      }
      case '-ls': this.hasAction = true; return (run) => { this.emit(this.lsLine(run), '\n'); return true; };
      case '-fls': {
        const write = this.sink(this.argument(token));
        this.hasAction = true;
        return (run) => { write(`${this.lsLine(run)}\n`); return true; };
      }
      case '-delete': {
        this.hasAction = true;
        this.postOrder = true;
        return (run) => {
          const done = run.inode.type === 'directory' ? ctx.vfs.rmdir(run.path) : ctx.vfs.deleteFile(run.path);
          if (!done) {
            this.fail(`find: cannot delete '${run.display}': ${run.inode.type === 'directory' ? 'Directory not empty' : 'No such file or directory'}`);
            return false;
          }
          return true;
        };
      }
      case '-exec': case '-execdir': case '-ok': case '-okdir': return this.execPredicate(token);
      case '-maxdepth': case '-mindepth': {
        const raw = this.argument(token);
        if (!/^\d+$/.test(raw)) throw new FindSyntaxError(`find: Expected a positive decimal integer argument to ${token}, but got '${raw}'`);
        if (token === '-maxdepth') this.maxdepth = Number(raw); else this.mindepth = Number(raw);
        return () => true;
      }
      case '-depth': case '-d': this.postOrder = true; return () => true;
      case '-xdev': case '-mount': this.crossDevices = false; return () => true;
      case '-follow': this.follow = 'all'; return () => true;
      case '-daystart': this.dayStart = true; return () => true;
      case '-warn': this.warn = true; return () => true;
      case '-nowarn': this.warn = false; return () => true;
      case '-help': case '--help': throw new FindEarlyExit(FIND_USAGE);
      case '-version': case '--version': throw new FindEarlyExit(FIND_VERSION);
      default:
        if (ARGUMENTLESS_GLOBALS.has(token)) return () => true;
        return this.newerXy(token);
    }
  }

  private newerXy(token: string): Predicate {
    const letters = /^-newer(.)(.)$/.exec(token);
    if (letters !== null) {
      if (letters[1] === 'B' || letters[2] === 'B') this.warning('find: This system does not provide a way to find the birth time of a file.');
      if (!/^[acmB]$/.test(letters[1]) || !/^[acmBt]$/.test(letters[2]) || letters[1] === 'B' || letters[2] === 'B') {
        throw new FindSyntaxError(`find: invalid predicate \`${token}'`);
      }
    }
    const match = /^-newer([acm])([acmt])$/.exec(token);
    if (match === null) throw new FindSyntaxError(`find: unknown predicate \`${token}'`);
    const ctx = this.ctx;
    const operand = this.argument(token);
    const field = (letter: string): 'atime' | 'mtime' | 'ctime' => (letter === 'a' ? 'atime' : letter === 'c' ? 'ctime' : 'mtime');
    let thanMs: number | null;
    if (match[2] === 't') {
      thanMs = parseTouchDate(operand, ctx.zone, ctx.nowMs?.() ?? simulationNowMs());
      if (thanMs === null) throw new FindSyntaxError(`find: I cannot figure out how to interpret '${operand}' as a date or time`);
    } else {
      const reference = ctx.vfs.resolveInode(ctx.vfs.normalizePath(operand, ctx.cwd));
      if (!reference) throw new FindSyntaxError(`find: '${operand}': No such file or directory`);
      thanMs = reference[field(match[2])];
    }
    return this.criteria({ timeTests: [{ kind: 'newer', field: field(match[1]), thanMs }] });
  }
}

export function parseFind(ctx: ShellContext, args: readonly string[], host?: FindHost, stdin?: string): FindParse {
  let index = 0;
  let follow: FindFollow = 'none';
  let filesFrom: string | null = null;
  const notes: string[] = [];
  while (index < args.length) {
    const word = args[index];
    if (word === '-H') { follow = 'args'; index++; continue; }
    if (word === '-L') { follow = 'all'; index++; continue; }
    if (word === '-P') { follow = 'none'; index++; continue; }
    if (word.startsWith('-O')) {
      const level = word.slice(2);
      if (level === '') return { error: 'find: The -O option must be immediately followed by a decimal integer', exitCode: 1 };
      if (!/^\d+$/.test(level)) return { error: 'find: Please specify a decimal number immediately after -O', exitCode: 1 };
      index++;
      continue;
    }
    if (word === '-D' || word.startsWith('-D') && word.length > 2) {
      const value = word === '-D' ? args[index + 1] : word.slice(2);
      if (value === undefined) return { error: "find: missing argument to `-D'", exitCode: 1 };
      if (value === 'help') return { text: FIND_DEBUG_HELP, exitCode: 0 };
      for (const flag of value.split(',')) if (!DEBUG_FLAGS.has(flag)) notes.push(`find: Ignoring unrecognised debug flag '${flag}'`);
      index += word === '-D' ? 2 : 1;
      continue;
    }
    break;
  }
  let end = index;
  const starts: string[] = [];
  while (end < args.length) {
    if (args[end] === '-files0-from') {
      filesFrom = args[end + 1] ?? null;
      if (filesFrom === null) return { error: "find: missing argument to `-files0-from'", exitCode: 1 };
      end += 2;
      break;
    }
    if (args[end].startsWith('-') || NOT.has(args[end]) || OPEN.has(args[end])) break;
    starts.push(args[end]);
    end++;
  }
  if (filesFrom !== null) {
    if (starts.length > 0) {
      return { error: `find: extra operand '${starts[0]}'\nfind: file operands cannot be combined with -files0-from`, exitCode: 1 };
    }
    const content = filesFrom === '-' ? (stdin ?? '') : ctx.vfs.readFile(ctx.vfs.normalizePath(filesFrom, ctx.cwd));
    if (content === null) return { error: `find: '${filesFrom}': No such file or directory`, exitCode: 1 };
    const listed = content.split('\0').filter((entry, position, all) => entry !== '' || position < all.length - 1);
    if (listed.some((entry) => entry === '')) return { error: 'find: invalid zero-length file name', exitCode: 1 };
    starts.push(...listed);
  }
  const parser = new FindParser(ctx, args, host, stdin);
  parser.setFollow(follow);
  try {
    const plan = parser.parse(end);
    for (const note of notes) plan.output.unshift({ text: note, terminator: '\n', stream: 'stderr' });
    return { plan: { ...plan, starts: starts.length === 0 && filesFrom === null ? ['.'] : starts } };
  } catch (error) {
    if (error instanceof FindSyntaxError) {
      const prior = parser.output.filter((record) => record.stream === 'stderr').map((record) => record.text + record.terminator).join('');
      return { error: prior + error.message, exitCode: 1 };
    }
    if (error instanceof FindEarlyExit) return { text: error.text, exitCode: 0 };
    throw error;
  }
}
