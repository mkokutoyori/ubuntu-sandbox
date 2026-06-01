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
      case '-S': return false;                              // no sockets in VFS
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
    if (!/^-?\d+$/.test(s.trim())) throw new TestSyntaxError(`integer expression expected: ${s}`);
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

/**
 * Recursive descent parser. Grammar:
 *
 *   expr   := orE
 *   orE    := andE ( '-o' andE )*
 *   andE   := notE ( '-a' notE )*
 *   notE   := '!' notE | primary
 *   primary:= '(' expr ')'
 *           | UNARY arg
 *           | arg BINARY arg
 *           | arg                       (true ⇔ non-empty)
 */
class TestParser {
  private pos = 0;
  constructor(private readonly tokens: readonly string[], private readonly e: TestEvaluator) {}

  parse(): boolean {
    const value = this.orE();
    if (this.pos !== this.tokens.length) {
      throw new TestSyntaxError(`unexpected argument: ${this.tokens[this.pos]}`);
    }
    return value;
  }

  private orE(): boolean {
    let v = this.andE();
    while (this.peek() === '-o') { this.pos++; v = this.andE() || v; }
    return v;
  }

  private andE(): boolean {
    let v = this.notE();
    while (this.peek() === '-a') { this.pos++; v = this.notE() && v; }
    return v;
  }

  private notE(): boolean {
    if (this.peek() === '!') { this.pos++; return !this.notE(); }
    return this.primary();
  }

  private primary(): boolean {
    const remaining = this.tokens.length - this.pos;
    if (remaining === 0) throw new TestSyntaxError('argument expected');

    if (this.peek() === '(' && this.findMatchingParen() >= 0) {
      this.pos++;
      const v = this.orE();
      if (this.peek() !== ')') throw new TestSyntaxError('missing `)\'');
      this.pos++;
      return v;
    }

    // Lookahead for three-token "arg BIN arg" form before single-arg fallthrough.
    if (remaining >= 3 && BINARY_OPS.has(this.tokens[this.pos + 1])) {
      const a = this.tokens[this.pos];
      const op = this.tokens[this.pos + 1];
      const b = this.tokens[this.pos + 2];
      this.pos += 3;
      return this.e.binary(a, op, b);
    }

    if (remaining >= 2 && UNARY_OPS.has(this.tokens[this.pos])) {
      const op = this.tokens[this.pos];
      const arg = this.tokens[this.pos + 1];
      this.pos += 2;
      return this.e.unary(op, arg);
    }

    const t = this.tokens[this.pos++];
    return t.length > 0;
  }

  private peek(): string | undefined { return this.tokens[this.pos]; }

  /** Scan for the matching `)` at the same nesting level. */
  private findMatchingParen(): number {
    let depth = 0;
    for (let i = this.pos; i < this.tokens.length; i++) {
      if (this.tokens[i] === '(') depth++;
      else if (this.tokens[i] === ')') { depth--; if (depth === 0) return i; }
    }
    return -1;
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
