import { simulationNowMs } from '@/network/core/SystemClock';
import type { ShellContext } from './LinuxFileCommands';
import { parseTouchDate } from './time/FileTimes';
import { formatLocalTime } from './system/SystemInfo';
import { isFindType, type FindTimeTest, type FindType, type INode } from './VirtualFileSystem';

export interface FindOutput {
  readonly text: string;
  readonly terminator: '\n' | '\0' | '';
}

export interface FindRun {
  readonly path: string;
  readonly display: string;
  readonly start: string;
  readonly inode: INode;
  readonly depth: number;
  prune: boolean;
  quit: boolean;
}

type Predicate = (run: FindRun) => boolean;

export interface FindPlan {
  readonly starts: string[];
  readonly expression: Predicate;
  readonly postOrder: boolean;
  readonly crossDevices: boolean;
  readonly maxdepth?: number;
  readonly mindepth?: number;
  readonly output: FindOutput[];
}

export type FindParse = { readonly plan: FindPlan } | { readonly error: string };

class FindSyntaxError extends Error {}

const OR = new Set(['-o', '-or']);
const AND = new Set(['-a', '-and']);
const NOT = new Set(['!', '-not']);
const OPEN = new Set(['(', '\\(']);
const CLOSE = new Set([')', '\\)']);

const IGNORED_GLOBALS = new Set([
  '-noleaf', '-follow', '-ignore_readdir_race', '-noignore_readdir_race', '-warn', '-nowarn', '-H', '-L', '-P',
]);

const UNEVALUATED_WITHOUT_ARGUMENT = new Set(['-ls']);
const UNEVALUATED_WITH_ARGUMENT = new Set(['-fstype', '-context', '-fprint', '-fprint0', '-fls']);

function parseSizeSpec(raw: string): { op: '+' | '-' | '='; value: number } | null {
  const m = /^([+-]?)(\d+)([cwbkMGT]?)$/.exec(raw);
  if (!m) return null;
  const [, prefix, numStr, unit] = m;
  const multipliers: Record<string, number> = {
    '': 512, c: 1, w: 2, b: 512, k: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4,
  };
  return { op: prefix === '+' ? '+' : prefix === '-' ? '-' : '=', value: parseInt(numStr, 10) * multipliers[unit] };
}

function numericTest(raw: string, name: string): (value: number) => boolean {
  const match = /^([+-]?)(\d+)$/.exec(raw);
  if (match === null) throw new FindSyntaxError(`find: invalid argument \`${raw}' to \`${name}'`);
  const n = Number(match[2]);
  return match[1] === '+' ? (value) => value > n : match[1] === '-' ? (value) => value < n : (value) => value === n;
}

function regexFrom(pattern: string, type: string, ignoreCase: boolean): RegExp {
  let source = pattern;
  if (type === 'emacs' || type === 'posix-basic') {
    source = '';
    for (let i = 0; i < pattern.length; i++) {
      const c = pattern[i];
      if (c === '\\' && i + 1 < pattern.length) {
        const next = pattern[++i];
        source += '(){}|'.includes(next) ? next : `\\${next}`;
      } else if ('(){}|'.includes(c)) source += `\\${c}`;
      else source += c;
    }
  }
  try {
    return new RegExp(`^(?:${source})$`, ignoreCase ? 'is' : 's');
  } catch {
    throw new FindSyntaxError(`find: Invalid regular expression \`${pattern}': syntax error`);
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

function printfText(ctx: ShellContext, format: string, run: FindRun): string {
  const inode = run.inode;
  const slash = run.display.lastIndexOf('/');
  const relative = run.display === run.start ? '' : run.display.slice(run.start.replace(/\/+$/, '').length).replace(/^\//, '');
  const epoch = (ms: number): string => `${Math.floor(ms / 1000)}.0000000000`;
  let out = '';
  for (let i = 0; i < format.length; i++) {
    const c = format[i];
    if (c === '\\' && i + 1 < format.length) {
      const e = format[++i];
      out += e === 'n' ? '\n' : e === 't' ? '\t' : e === '0' ? '\0' : e === 'r' ? '\r' : e === 'a' ? '\x07' : e === '\\' ? '\\' : `\\${e}`;
      continue;
    }
    if (c !== '%' || i + 1 >= format.length) { out += c; continue; }
    const d = format[++i];
    switch (d) {
      case '%': out += '%'; break;
      case 'p': out += run.display; break;
      case 'P': out += relative; break;
      case 'f': out += slash < 0 ? run.display : run.display.slice(slash + 1) || run.display; break;
      case 'h': out += slash < 0 ? '.' : run.display.slice(0, slash) || '/'; break;
      case 'H': out += run.start; break;
      case 'm': out += (inode.permissions & 0o7777).toString(8); break;
      case 'M': out += ctx.vfs.formatPermissions(inode); break;
      case 'u': out += ctx.userMgr.uidToName(inode.uid); break;
      case 'g': out += ctx.userMgr.gidToName(inode.gid); break;
      case 'U': out += String(inode.uid); break;
      case 'G': out += String(inode.gid); break;
      case 's': out += String(inode.size); break;
      case 'y': out += typeLetter(inode); break;
      case 'n': out += String(inode.linkCount); break;
      case 'i': out += String(inode.id); break;
      case 'd': out += String(run.depth); break;
      case 'b': out += String(Math.ceil(inode.size / 512)); break;
      case 'k': out += String(Math.ceil(inode.size / 1024)); break;
      case 'l': out += inode.type === 'symlink' ? inode.target : ''; break;
      case 'A': case 'C': case 'T': {
        const field = d === 'A' ? inode.atime : d === 'C' ? inode.ctime : inode.mtime;
        const directive = format[++i];
        if (directive === '@') out += epoch(field);
        else if (directive === undefined) out += `%${d}`;
        else out += formatLocalTime(`%${directive}`, field, ctx.zone);
        break;
      }
      default: out += `%${d}`;
    }
  }
  return out;
}

class FindParser {
  private position = 0;
  private hasAction = false;
  private postOrder = false;
  private crossDevices = true;
  private maxdepth: number | undefined;
  private mindepth: number | undefined;
  private dayStart = false;
  readonly output: FindOutput[] = [];

  constructor(private readonly ctx: ShellContext, private readonly tokens: readonly string[]) {}

  private peek(): string | undefined { return this.tokens[this.position]; }

  private argument(name: string): string {
    const value = this.tokens[this.position++];
    if (value === undefined) throw new FindSyntaxError(`find: missing argument to \`${name}'`);
    return value;
  }

  parse(startsEnd: number): FindPlan {
    this.position = startsEnd;
    let expression: Predicate = () => true;
    if (this.position < this.tokens.length) {
      expression = this.parseOr();
      if (this.position < this.tokens.length) throw new FindSyntaxError("find: invalid expression; you have too many ')'");
    }
    if (!this.hasAction) {
      const inner = expression;
      const print = this.printAction('\n');
      expression = (run) => inner(run) && print(run);
    }
    return {
      starts: [], expression, postOrder: this.postOrder, crossDevices: this.crossDevices,
      maxdepth: this.maxdepth, mindepth: this.mindepth, output: this.output,
    };
  }

  private parseOr(): Predicate {
    let left = this.parseAnd();
    while (this.peek() !== undefined && OR.has(this.peek() as string)) {
      this.position++;
      const a = left;
      const b = this.parseAnd();
      left = (run) => a(run) || b(run);
    }
    return left;
  }

  private parseAnd(): Predicate {
    let left = this.parseNot();
    for (;;) {
      const token = this.peek();
      if (token === undefined || OR.has(token) || CLOSE.has(token)) return left;
      if (AND.has(token)) this.position++;
      const a = left;
      const b = this.parseNot();
      left = (run) => a(run) && b(run);
    }
  }

  private parseNot(): Predicate {
    const token = this.peek();
    if (token !== undefined && NOT.has(token)) {
      this.position++;
      const operand = this.parseNot();
      return (run) => !operand(run);
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Predicate {
    const token = this.tokens[this.position++];
    if (token === undefined) throw new FindSyntaxError('find: expected an expression after the last predicate');
    if (OPEN.has(token)) {
      const inner = this.parseOr();
      const close = this.tokens[this.position++];
      if (close === undefined || !CLOSE.has(close)) {
        throw new FindSyntaxError("find: invalid expression; I was expecting to find a ')' somewhere but did not see one.");
      }
      return inner;
    }
    if (!token.startsWith('-')) throw new FindSyntaxError(`find: paths must precede expression: \`${token}'`);
    return this.predicate(token);
  }

  private criteria(options: Record<string, unknown>, useDisplay = true): Predicate {
    return (run) => this.ctx.vfs.matchesFindCriteria(useDisplay ? run.display : run.path, run.inode, options);
  }

  private printAction(terminator: '\n' | '\0'): Predicate {
    this.hasAction = true;
    return (run) => { this.output.push({ text: run.display, terminator }); return true; };
  }

  private dayOrigin(): number | undefined {
    if (!this.dayStart) return undefined;
    const now = this.ctx.nowMs?.() ?? simulationNowMs();
    const [h, m, s] = formatLocalTime('%H:%M:%S', now, this.ctx.zone).split(':').map(Number);
    return now - ((h * 60 + m) * 60 + s) * 1000 + 86_400_000;
  }

  private predicate(token: string): Predicate {
    const ctx = this.ctx;
    switch (token) {
      case '-name': return this.criteria({ name: this.argument(token) });
      case '-iname': return this.criteria({ iname: this.argument(token) });
      case '-path': case '-wholename': return this.criteria({ path: this.argument(token) });
      case '-ipath': case '-iwholename': return this.criteria({ ipath: this.argument(token) });
      case '-type': {
        const raw = this.argument(token);
        const types = raw.split(',');
        for (const t of types) if (!isFindType(t)) throw new FindSyntaxError(`find: Unknown argument to -type: ${t}`);
        const tests = types.map((t) => this.criteria({ type: t as FindType }));
        return (run) => tests.some((test) => test(run));
      }
      case '-empty': return this.criteria({ empty: true });
      case '-true': return () => true;
      case '-false': return () => false;
      case '-user': {
        const name = this.argument(token);
        const uid = ctx.userMgr.resolveUid(name);
        if (uid < 0) throw new FindSyntaxError(`find: '${name}' is not the name of a known user`);
        return this.criteria({ user: uid });
      }
      case '-group': {
        const name = this.argument(token);
        const gid = ctx.userMgr.resolveGid(name);
        if (gid < 0) throw new FindSyntaxError(`find: '${name}' is not the name of a known group`);
        return this.criteria({ group: gid });
      }
      case '-uid': { const test = numericTest(this.argument(token), token); return (run) => test(run.inode.uid); }
      case '-gid': { const test = numericTest(this.argument(token), token); return (run) => test(run.inode.gid); }
      case '-links': { const test = numericTest(this.argument(token), token); return (run) => test(run.inode.linkCount); }
      case '-inum': { const test = numericTest(this.argument(token), token); return (run) => test(run.inode.id); }
      case '-used': {
        const test = numericTest(this.argument(token), token);
        return (run) => test(Math.floor((run.inode.atime - run.inode.ctime) / 86_400_000));
      }
      case '-nouser': return (run) => ctx.userMgr.getUserByUid(run.inode.uid) === undefined;
      case '-nogroup': return (run) => ctx.userMgr.getGroupByGid(run.inode.gid) === undefined;
      case '-readable': return (run) => accessAllowed(ctx, run.inode, 4);
      case '-writable': return (run) => accessAllowed(ctx, run.inode, 2);
      case '-executable': return (run) => accessAllowed(ctx, run.inode, 1);
      case '-samefile': {
        const reference = ctx.vfs.resolveInode(ctx.vfs.normalizePath(this.argument(token), ctx.cwd));
        return (run) => reference !== null && reference !== undefined && run.inode.id === reference.id;
      }
      case '-lname': case '-ilname': {
        const pattern = this.argument(token);
        const fold = token === '-ilname';
        return (run) => run.inode.type === 'symlink'
          && ctx.vfs.globMatch(fold ? run.inode.target.toLowerCase() : run.inode.target, fold ? pattern.toLowerCase() : pattern);
      }
      case '-regex': case '-iregex': {
        const regex = regexFrom(this.argument(token), this.regexType, token === '-iregex');
        return (run) => regex.test(run.display);
      }
      case '-regextype': this.regexType = this.argument(token); return () => true;
      case '-size': {
        const raw = this.argument(token);
        const spec = parseSizeSpec(raw);
        if (spec === null) throw new FindSyntaxError(`find: Invalid argument \`${raw}' to -size`);
        return this.criteria({ size: spec });
      }
      case '-perm': {
        const raw = this.argument(token);
        const parsed = /^([-/]?)([0-7]{1,4})$/.exec(raw);
        if (parsed === null) throw new FindSyntaxError(`find: Invalid mode '${raw}'`);
        return this.criteria({ perm: { kind: parsed[1] === '-' ? 'all' : parsed[1] === '/' ? 'any' : 'exact', mode: parseInt(parsed[2], 8) } });
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
      case '-prune': return (run) => { run.prune = true; return true; };
      case '-quit': this.hasAction = true; return (run) => { run.quit = true; return true; };
      case '-print': return this.printAction('\n');
      case '-print0': return this.printAction('\0');
      case '-printf': {
        const format = this.argument(token);
        this.hasAction = true;
        return (run) => { this.output.push({ text: printfText(ctx, format, run), terminator: '' }); return true; };
      }
      case '-delete': {
        this.hasAction = true;
        this.postOrder = true;
        return (run) => {
          if (run.inode.type === 'directory') ctx.vfs.rmdir(run.path); else ctx.vfs.deleteFile(run.path);
          return true;
        };
      }
      case '-exec': case '-execdir': case '-ok': case '-okdir': {
        const parts: string[] = [];
        for (;;) {
          const word = this.tokens[this.position++];
          if (word === undefined) throw new FindSyntaxError(`find: missing argument to \`${token}'`);
          if (word === ';' || word === '\;' || word === '+') break;
          parts.push(word);
        }
        this.hasAction = true;
        if (token === '-ok' || token === '-okdir') return () => false;
        const command = parts.join(' ');
        return (run) => {
          const file = token === '-execdir' ? `./${run.display.split('/').pop()}` : run.display;
          this.output.push({ text: command.replace(/\{\}/g, file).replace(/^echo\s+/, '') || file, terminator: '\n' });
          return true;
        };
      }
      case '-fprintf': this.argument(token); this.argument(token); this.hasAction = true; return () => false;
      case '-maxdepth': case '-mindepth': {
        const raw = this.argument(token);
        if (!/^\d+$/.test(raw)) throw new FindSyntaxError(`find: Expected a positive decimal integer argument to ${token}, but got '${raw}'`);
        if (token === '-maxdepth') this.maxdepth = Number(raw); else this.mindepth = Number(raw);
        return () => true;
      }
      case '-depth': case '-d': this.postOrder = true; return () => true;
      case '-xdev': case '-mount': this.crossDevices = false; return () => true;
      case '-daystart': this.dayStart = true; return () => true;
      default:
        if (IGNORED_GLOBALS.has(token)) return () => true;
        if (UNEVALUATED_WITHOUT_ARGUMENT.has(token)) { this.hasAction = true; return () => false; }
        if (UNEVALUATED_WITH_ARGUMENT.has(token)) {
          this.argument(token);
          if (token !== '-fstype' && token !== '-context') this.hasAction = true;
          return () => false;
        }
        return this.newerXy(token);
    }
  }

  private regexType = 'emacs';

  private newerXy(token: string): Predicate {
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

export function parseFind(ctx: ShellContext, args: readonly string[]): FindParse {
  let end = 0;
  while (end < args.length && !args[end].startsWith('-') && !NOT.has(args[end]) && !OPEN.has(args[end]) && !CLOSE.has(args[end])) end++;
  const parser = new FindParser(ctx, args);
  try {
    const plan = parser.parse(end);
    return { plan: { ...plan, starts: end === 0 ? ['.'] : args.slice(0, end) } };
  } catch (error) {
    if (error instanceof FindSyntaxError) return { error: error.message };
    throw error;
  }
}
