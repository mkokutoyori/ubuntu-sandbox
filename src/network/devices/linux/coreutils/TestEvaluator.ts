/**
 * POSIX `test` / `[ … ]` evaluator.
 *
 * Drives a recursive-descent parser over the argv after the optional
 * trailing `]`, supports the full POSIX/GNU operator menagerie (unary
 * file tests, string predicates, integer comparisons, file-comparison
 * binaries, `( … )` grouping, `!`, `-a`, `-o`) and dispatches each
 * primary through a small filesystem-bound evaluator.
 *
 * Exit semantics follow POSIX `test(1)`:
 *   0 → expression is true
 *   1 → expression is false
 *   2 → syntax error / unknown operator / missing argument
 */

import type { VirtualFileSystem, INode, FileType } from '../VirtualFileSystem';

export interface TestFs {
  exists(path: string): boolean;
  resolveInode(path: string): INode | null;
  getType(path: string, followSymlinks?: boolean): FileType | null;
  normalizePath(path: string, cwd: string): string;
}

export interface TestEnv {
  uid: number;
  gid: number;
  euid?: number;
  egid?: number;
  cwd: string;
  isatty?: (fd: number) => boolean;
}

export type TestResultKind = 'true' | 'false' | 'error';

export interface TestEvaluation {
  readonly kind: TestResultKind;
  readonly exitCode: number;
  readonly stderr: string;
}

/** Catalogue of POSIX + Bash unary operators. */
export const UNARY_OPS = new Set<string>([
  '-a','-b','-c','-d','-e','-f','-g','-h','-k','-L','-N','-O','-G',
  '-p','-r','-s','-S','-t','-u','-w','-x',
  '-n','-z',
  '-o',
]);

/** Catalogue of binary operators (string/integer/file). */
export const BINARY_OPS = new Set<string>([
  '=','==','!=','<','>',
  '-eq','-ne','-lt','-le','-gt','-ge',
  '-nt','-ot','-ef',
]);

/**
 * Single-shot evaluator. Tests are stateless so a fresh instance is
 * cheap; the caller passes the bracketed flag so that `[ … ]` enforces
 * the trailing `]`.
 */
export class TestEvaluator {
  constructor(
    private readonly fs: TestFs,
    private readonly env: TestEnv,
  ) {}

  /** Evaluate `test arg1 arg2 …` (bracket form already stripped). */
  run(args: readonly string[], bracket = false): TestEvaluation {
    if (bracket) {
      if (args.length === 0 || args[args.length - 1] !== ']') {
        return { kind: 'error', exitCode: 2, stderr: '[: missing `]\'' };
      }
      args = args.slice(0, -1);
    }
    if (args.length === 0) return { kind: 'false', exitCode: 1, stderr: '' };
    try {
      const parser = new TestParser(args, this);
      const value = parser.parse();
      return { kind: value ? 'true' : 'false', exitCode: value ? 0 : 1, stderr: '' };
    } catch (e) {
      const msg = e instanceof TestSyntaxError ? e.message : 'syntax error';
      return { kind: 'error', exitCode: 2, stderr: `${bracket ? '[' : 'test'}: ${msg}` };
    }
  }

  /** Apply a unary operator to a single operand. */
  unary(op: string, operand: string): boolean {
    switch (op) {
      case '-n': return operand.length > 0;
      case '-z': return operand.length === 0;
      case '-t': {
        const fd = Number.parseInt(operand, 10);
        if (!Number.isFinite(fd)) return false;
        return this.env.isatty ? this.env.isatty(fd) : false;
      }
      case '-o': return false; // shell-option probe; the simulator has none enabled
    }
    const abs = this.fs.normalizePath(operand, this.env.cwd);
    const lst = this.fs.resolveInode(abs);
    switch (op) {
      case '-a':
      case '-e': return this.fs.exists(abs);
      case '-f': return this.fs.getType(abs) === 'file';
      case '-d': return this.fs.getType(abs) === 'directory';
      case '-L':
      case '-h': return this.fs.getType(abs, false) === 'symlink';
      case '-b': return false;                              // no block devs in VFS
      case '-c': return !!lst && lst.type === 'chardev';
      case '-p': return !!lst && lst.type === 'fifo';
      case '-S': return !!lst && lst.type === 'socket';
      case '-s': return !!lst && lst.size > 0;
      case '-r': return !!lst && this.permitted(lst, 'r');
      case '-w': return !!lst && this.permitted(lst, 'w');
      case '-x': return !!lst && this.permitted(lst, 'x');
      case '-u': return !!lst && (lst.permissions & 0o4000) !== 0;
      case '-g': return !!lst && (lst.permissions & 0o2000) !== 0;
      case '-k': return !!lst && (lst.permissions & 0o1000) !== 0;
      case '-O': return !!lst && lst.uid === (this.env.euid ?? this.env.uid);
      case '-G': return !!lst && lst.gid === (this.env.egid ?? this.env.gid);
      case '-N': return !!lst && lst.mtime > lst.atime;
    }
    throw new TestSyntaxError(`unary operator expected: ${op}`);
  }

  /** Apply a binary operator. */
  binary(left: string, op: string, right: string): boolean {
    switch (op) {
      case '=':
      case '==': return left === right;
      case '!=': return left !== right;
      case '<': return left < right;
      case '>': return left > right;
      case '-eq': return this.toInt(left) === this.toInt(right);
      case '-ne': return this.toInt(left) !== this.toInt(right);
      case '-lt': return this.toInt(left) <   this.toInt(right);
      case '-le': return this.toInt(left) <=  this.toInt(right);
      case '-gt': return this.toInt(left) >   this.toInt(right);
      case '-ge': return this.toInt(left) >=  this.toInt(right);
      case '-nt': return this.mtimeOf(left) >  this.mtimeOf(right);
      case '-ot': return this.mtimeOf(left) <  this.mtimeOf(right);
      case '-ef': {
        const a = this.fs.resolveInode(this.fs.normalizePath(left,  this.env.cwd));
        const b = this.fs.resolveInode(this.fs.normalizePath(right, this.env.cwd));
        return !!a && !!b && a === b;
      }
    }
    throw new TestSyntaxError(`binary operator expected: ${op}`);
  }

  private mtimeOf(path: string): number {
    const inode = this.fs.resolveInode(this.fs.normalizePath(path, this.env.cwd));
    return inode ? inode.mtime : -Infinity;
  }

  private toInt(s: string): number {
    if (!/^\s*[+-]?\d+\s*$/.test(s)) throw new TestSyntaxError(`${s}: integer expression expected`);
    return Number.parseInt(s, 10);
  }

  private permitted(inode: INode, perm: 'r' | 'w' | 'x'): boolean {
    const uid = this.env.euid ?? this.env.uid;
    const gid = this.env.egid ?? this.env.gid;
    if (uid === 0) return perm !== 'x' || (inode.permissions & 0o111) !== 0;
    const bit = perm === 'r' ? 4 : perm === 'w' ? 2 : 1;
    if (inode.uid === uid)       return ((inode.permissions >> 6) & bit) !== 0;
    if (inode.gid === gid)       return ((inode.permissions >> 3) & bit) !== 0;
    return (inode.permissions & bit) !== 0;
  }
}

class TestSyntaxError extends Error {}

class TestParser {
  private pos = 0;
  private readonly argc: number;
  constructor(private readonly argv: readonly string[], private readonly e: TestEvaluator) {
    this.argc = argv.length;
  }

  parse(): boolean {
    const value = this.posixTest();
    if (this.pos !== this.argc) throw new TestSyntaxError('too many arguments');
    return value;
  }

  private posixTest(): boolean {
    switch (this.argc - this.pos) {
      case 0: throw new TestSyntaxError('argument expected');
      case 1: return this.consumeAll(this.oneArgument(this.argv[this.pos]));
      case 2: return this.consumeAll(this.twoArguments());
      case 3: return this.threeArguments();
      case 4: return this.fourArguments();
      default: return this.expression();
    }
  }

  private consumeAll(value: boolean): boolean {
    this.pos = this.argc;
    return value;
  }

  private oneArgument(argument: string): boolean {
    return argument.length > 0;
  }

  private isUnary(argument: string): boolean {
    return argument.length === 2 && argument[0] === '-' && UNARY_OPS.has(argument);
  }

  private twoArguments(): boolean {
    const first = this.argv[this.pos];
    if (first === '!') return this.argv[this.pos + 1].length === 0;
    if (this.isUnary(first)) return this.e.unary(first, this.argv[this.pos + 1]);
    throw new TestSyntaxError(`${first}: unary operator expected`);
  }

  private threeArguments(): boolean {
    const [first, second, third] = this.argv.slice(this.pos, this.pos + 3);
    if (BINARY_OPS.has(second)) return this.consumeAll(this.e.binary(first, second, third));
    if (second === '-a') return this.consumeAll(this.oneArgument(first) && this.oneArgument(third));
    if (second === '-o') return this.consumeAll(this.oneArgument(first) || this.oneArgument(third));
    if (first === '!') {
      this.pos++;
      return this.consumeAll(!this.twoArguments());
    }
    if (first === '(' && third === ')') return this.consumeAll(this.oneArgument(second));
    throw new TestSyntaxError(`${second}: binary operator expected`);
  }

  private fourArguments(): boolean {
    const first = this.argv[this.pos];
    if (first === '!') {
      this.pos++;
      return !this.threeArguments();
    }
    if (first === '(' && this.argv[this.pos + 3] === ')') {
      this.pos++;
      return this.consumeAll(this.twoArguments());
    }
    return this.expression();
  }

  private expression(): boolean {
    if (this.pos >= this.argc) throw new TestSyntaxError('argument expected');
    return this.orExpression();
  }

  private orExpression(): boolean {
    const value = this.andExpression();
    if (this.pos < this.argc && this.argv[this.pos] === '-o') {
      this.pos++;
      return this.orExpression() || value;
    }
    return value;
  }

  private andExpression(): boolean {
    const value = this.term();
    if (this.pos < this.argc && this.argv[this.pos] === '-a') {
      this.pos++;
      return this.andExpression() && value;
    }
    return value;
  }

  private term(): boolean {
    if (this.pos >= this.argc) throw new TestSyntaxError('argument expected');
    const current = this.argv[this.pos];
    if (current === '!') {
      let negated = false;
      while (this.pos < this.argc && this.argv[this.pos] === '!') {
        this.pos++;
        negated = !negated;
      }
      const value = this.term();
      return negated ? !value : value;
    }
    if (current === '(') {
      this.pos++;
      if (this.pos >= this.argc) throw new TestSyntaxError('argument expected');
      const value = this.orExpression();
      if (this.pos >= this.argc) throw new TestSyntaxError("`)' expected");
      if (this.argv[this.pos] !== ')') throw new TestSyntaxError(`\`)' expected, found ${this.argv[this.pos]}`);
      this.pos++;
      return value;
    }
    if (this.pos + 2 < this.argc && BINARY_OPS.has(this.argv[this.pos + 1])) {
      const value = this.e.binary(current, this.argv[this.pos + 1], this.argv[this.pos + 2]);
      this.pos += 3;
      return value;
    }
    if (current.length === 2 && current[0] === '-') {
      if (!this.isUnary(current)) throw new TestSyntaxError(`${current}: unary operator expected`);
      if (this.pos + 1 >= this.argc) throw new TestSyntaxError('argument expected');
      const value = this.e.unary(current, this.argv[this.pos + 1]);
      this.pos += 2;
      return value;
    }
    this.pos++;
    return this.oneArgument(current);
  }
}

/** Convenience wrapper: returns just (exitCode, stderr) for the executor. */
export function runTest(
  fs: TestFs,
  env: TestEnv,
  args: readonly string[],
  bracket = false,
): { exitCode: number; stderr: string } {
  const r = new TestEvaluator(fs, env).run(args, bracket);
  return { exitCode: r.exitCode, stderr: r.stderr };
}

/** Type-only re-export used by the executor for VFS typing. */
export type { VirtualFileSystem };
