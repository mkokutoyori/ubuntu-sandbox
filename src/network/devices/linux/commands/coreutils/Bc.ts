import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { BC_MATH_LIBRARY } from './BcMathLibrary';

interface Num { v: bigint; s: number }

const pow10 = (n: number): bigint => 10n ** BigInt(n);
const ZERO: Num = { v: 0n, s: 0 };
const ONE: Num = { v: 1n, s: 0 };

function rescale(n: Num, s: number): Num {
  if (s === n.s) return n;
  if (s > n.s) return { v: n.v * pow10(s - n.s), s };
  return { v: n.v / pow10(n.s - s), s };
}

function align(a: Num, b: Num): [bigint, bigint, number] {
  const s = Math.max(a.s, b.s);
  return [rescale(a, s).v, rescale(b, s).v, s];
}

function compare(a: Num, b: Num): number {
  const [x, y] = align(a, b);
  return x < y ? -1 : x > y ? 1 : 0;
}

class BcError extends Error {}
class SyntaxFailure extends Error {
  constructor(readonly line: number) { super('syntax error'); }
}
class BreakSignal extends Error {}
class ContinueSignal extends Error {}
class ReturnSignal extends Error { constructor(readonly value: Num) { super('return'); } }
class HaltSignal extends Error {}

type Tok =
  | { k: 'num'; text: string; line: number }
  | { k: 'name'; text: string; line: number }
  | { k: 'str'; text: string; line: number }
  | { k: 'op'; text: string; line: number }
  | { k: 'nl'; line: number }
  | { k: 'end'; line: number };

const OPS2 = ['==', '!=', '<=', '>=', '&&', '||', '+=', '-=', '*=', '/=', '%=', '^=', '++', '--'];

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  let line = 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\' && src[i + 1] === '\n') { i += 2; line++; continue; }
    if (c === '\n') { out.push({ k: 'nl', line }); line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      for (const ch of src.slice(i, stop)) if (ch === '\n') line++;
      i = stop;
      continue;
    }
    if (c === '"') {
      const end = src.indexOf('"', i + 1);
      const stop = end === -1 ? src.length : end;
      const text = src.slice(i + 1, stop);
      out.push({ k: 'str', text, line });
      for (const ch of text) if (ch === '\n') line++;
      i = stop + 1;
      continue;
    }
    if (/[0-9A-F.]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9A-F.]/.test(src[j])) j++;
      out.push({ k: 'num', text: src.slice(i, j), line });
      i = j;
      continue;
    }
    if (/[a-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[a-z0-9_]/.test(src[j])) j++;
      out.push({ k: 'name', text: src.slice(i, j), line });
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (OPS2.includes(two)) { out.push({ k: 'op', text: two, line }); i += 2; continue; }
    out.push({ k: 'op', text: c, line });
    i++;
  }
  out.push({ k: 'end', line });
  return out;
}

type Expr =
  | { t: 'num'; text: string }
  | { t: 'last' }
  | { t: 'var'; name: string }
  | { t: 'elem'; name: string; index: Expr }
  | { t: 'assign'; op: string; target: Expr; value: Expr }
  | { t: 'bin'; op: string; l: Expr; r: Expr }
  | { t: 'neg'; e: Expr }
  | { t: 'not'; e: Expr }
  | { t: 'step'; target: Expr; delta: 1 | -1; prefix: boolean }
  | { t: 'call'; name: string; args: Arg[] }
  | { t: 'paren'; e: Expr };

type Arg = { array: string } | { expr: Expr };

type Stmt =
  | { t: 'expr'; e: Expr }
  | { t: 'str'; text: string }
  | { t: 'print'; items: Array<{ str: string } | { expr: Expr }> }
  | { t: 'if'; cond: Expr; then: Stmt; otherwise: Stmt | null }
  | { t: 'while'; cond: Expr; body: Stmt }
  | { t: 'for'; init: Expr | null; cond: Expr | null; step: Expr | null; body: Stmt }
  | { t: 'break' } | { t: 'continue' } | { t: 'halt' } | { t: 'quit' } | { t: 'limits' }
  | { t: 'return'; e: Expr | null }
  | { t: 'block'; body: Stmt[] };

interface FunctionDef {
  readonly params: ReadonlyArray<{ name: string; array: boolean }>;
  readonly autos: ReadonlyArray<{ name: string; array: boolean }>;
  readonly body: Stmt[];
}

type Item = { stmt: Stmt; line: number } | { define: string; fn: FunctionDef; line: number } | { error: number; line: number };

class Parser {
  private p = 0;

  constructor(private readonly toks: Tok[]) {}

  private peek(): Tok { return this.toks[this.p]; }
  private next(): Tok { return this.toks[this.p++]; }
  private isOp(text: string): boolean { const t = this.peek(); return t.k === 'op' && t.text === text; }
  private isName(text: string): boolean { const t = this.peek(); return t.k === 'name' && t.text === text; }
  private eatOp(text: string): boolean { if (!this.isOp(text)) return false; this.p++; return true; }
  private fail(): never {
    const t = this.peek();
    throw new SyntaxFailure(t.k === 'nl' ? t.line + 1 : t.line);
  }
  private expectOp(text: string): void { if (!this.eatOp(text)) this.fail(); }
  private skipNewlines(): void { while (this.peek().k === 'nl') this.p++; }

  parseAll(): Item[] {
    const items: Item[] = [];
    while (this.peek().k !== 'end') {
      const t = this.peek();
      if (t.k === 'nl' || this.isOp(';')) { this.p++; continue; }
      const line = t.line;
      try {
        if (this.isName('define')) {
          this.p++;
          const nameTok = this.next();
          if (nameTok.k !== 'name') this.fail();
          items.push({ define: nameTok.text, fn: this.parseFunction(), line });
        } else {
          items.push({ stmt: this.statement(), line });
          this.terminator();
        }
      } catch (error) {
        if (!(error instanceof SyntaxFailure)) throw error;
        items.push({ error: error.line, line });
        while (this.peek().k !== 'end' && this.peek().k !== 'nl') this.p++;
      }
    }
    return items;
  }

  private terminator(): void {
    const t = this.peek();
    if (t.k === 'nl' || t.k === 'end' || this.isOp(';') || this.isOp('}')) return;
    this.fail();
  }

  private parseFunction(): FunctionDef {
    this.expectOp('(');
    const params: Array<{ name: string; array: boolean }> = [];
    if (!this.isOp(')')) {
      do {
        const t = this.next();
        if (t.k !== 'name') this.fail();
        let array = false;
        if (this.eatOp('[')) { this.expectOp(']'); array = true; }
        params.push({ name: t.text, array });
      } while (this.eatOp(','));
    }
    this.expectOp(')');
    this.skipNewlines();
    this.expectOp('{');
    this.skipNewlines();
    const autos: Array<{ name: string; array: boolean }> = [];
    while (this.isName('auto')) {
      this.p++;
      do {
        const t = this.next();
        if (t.k !== 'name') this.fail();
        let array = false;
        if (this.eatOp('[')) { this.expectOp(']'); array = true; }
        autos.push({ name: t.text, array });
      } while (this.eatOp(','));
      if (!(this.eatOp(';') || this.peek().k === 'nl')) this.fail();
      this.skipNewlines();
    }
    const body = this.statementList();
    this.expectOp('}');
    return { params, autos, body };
  }

  private statementList(): Stmt[] {
    const body: Stmt[] = [];
    for (;;) {
      this.skipNewlines();
      while (this.eatOp(';')) this.skipNewlines();
      if (this.isOp('}') || this.peek().k === 'end') return body;
      body.push(this.statement());
      this.terminator();
    }
  }

  private statement(): Stmt {
    const t = this.peek();
    if (t.k === 'str') { this.p++; return { t: 'str', text: t.text }; }
    if (t.k === 'op' && t.text === '{') {
      this.p++;
      const body = this.statementList();
      this.expectOp('}');
      return { t: 'block', body };
    }
    if (t.k === 'name') {
      switch (t.text) {
        case 'if': {
          this.p++;
          this.expectOp('(');
          const cond = this.expression();
          this.expectOp(')');
          this.skipNewlines();
          const then = this.statement();
          const save = this.p;
          this.skipNewlines();
          while (this.isOp(';')) { this.p++; this.skipNewlines(); }
          if (this.isName('else')) {
            this.p++;
            this.skipNewlines();
            return { t: 'if', cond, then, otherwise: this.statement() };
          }
          this.p = save;
          return { t: 'if', cond, then, otherwise: null };
        }
        case 'while': {
          this.p++;
          this.expectOp('(');
          const cond = this.expression();
          this.expectOp(')');
          this.skipNewlines();
          return { t: 'while', cond, body: this.statement() };
        }
        case 'for': {
          this.p++;
          this.expectOp('(');
          const init = this.isOp(';') ? null : this.expression();
          this.expectOp(';');
          const cond = this.isOp(';') ? null : this.expression();
          this.expectOp(';');
          const step = this.isOp(')') ? null : this.expression();
          this.expectOp(')');
          this.skipNewlines();
          return { t: 'for', init, cond, step, body: this.statement() };
        }
        case 'break': this.p++; return { t: 'break' };
        case 'continue': this.p++; return { t: 'continue' };
        case 'halt': this.p++; return { t: 'halt' };
        case 'quit': this.p++; return { t: 'quit' };
        case 'limits': this.p++; return { t: 'limits' };
        case 'return': {
          this.p++;
          const n = this.peek();
          if (n.k === 'nl' || n.k === 'end' || this.isOp(';') || this.isOp('}')) return { t: 'return', e: null };
          return { t: 'return', e: this.expression() };
        }
        case 'print': {
          this.p++;
          const items: Array<{ str: string } | { expr: Expr }> = [];
          do {
            const s = this.peek();
            if (s.k === 'str') { this.p++; items.push({ str: s.text }); } else items.push({ expr: this.expression() });
          } while (this.eatOp(','));
          return { t: 'print', items };
        }
        default: break;
      }
    }
    return { t: 'expr', e: this.expression() };
  }

  expression(): Expr {
    const left = this.orExpr();
    const t = this.peek();
    if (t.k === 'op' && (t.text === '=' || /^[-+*/%^]=$/.test(t.text))) {
      if (left.t !== 'var' && left.t !== 'elem') this.fail();
      this.p++;
      return { t: 'assign', op: t.text, target: left, value: this.expression() };
    }
    return left;
  }

  private orExpr(): Expr {
    let left = this.andExpr();
    while (this.eatOp('||')) left = { t: 'bin', op: '||', l: left, r: this.andExpr() };
    return left;
  }

  private andExpr(): Expr {
    let left = this.notExpr();
    while (this.eatOp('&&')) left = { t: 'bin', op: '&&', l: left, r: this.notExpr() };
    return left;
  }

  private notExpr(): Expr {
    if (this.eatOp('!')) return { t: 'not', e: this.notExpr() };
    return this.relExpr();
  }

  private relExpr(): Expr {
    let left = this.addExpr();
    for (;;) {
      const t = this.peek();
      if (t.k === 'op' && ['==', '!=', '<', '<=', '>', '>='].includes(t.text)) {
        this.p++;
        left = { t: 'bin', op: t.text, l: left, r: this.addExpr() };
      } else return left;
    }
  }

  private addExpr(): Expr {
    let left = this.mulExpr();
    for (;;) {
      if (this.isOp('+')) { this.p++; left = { t: 'bin', op: '+', l: left, r: this.mulExpr() }; continue; }
      if (this.isOp('-')) { this.p++; left = { t: 'bin', op: '-', l: left, r: this.mulExpr() }; continue; }
      return left;
    }
  }

  private mulExpr(): Expr {
    let left = this.power();
    for (;;) {
      const t = this.peek();
      if (t.k === 'op' && (t.text === '*' || t.text === '/' || t.text === '%')) {
        this.p++;
        left = { t: 'bin', op: t.text, l: left, r: this.power() };
      } else return left;
    }
  }

  private negation(): Expr {
    if (this.eatOp('-')) return { t: 'neg', e: this.negation() };
    return this.postfix();
  }

  private power(): Expr {
    const base = this.negation();
    if (this.eatOp('^')) return { t: 'bin', op: '^', l: base, r: this.power() };
    return base;
  }

  private postfix(): Expr {
    if (this.isOp('++') || this.isOp('--')) {
      const delta = (this.next() as { text: string }).text === '++' ? 1 : -1;
      const target = this.primary();
      if (target.t !== 'var' && target.t !== 'elem') this.fail();
      return { t: 'step', target, delta, prefix: true };
    }
    const e = this.primary();
    if ((e.t === 'var' || e.t === 'elem') && (this.isOp('++') || this.isOp('--'))) {
      const delta = (this.next() as { text: string }).text === '++' ? 1 : -1;
      return { t: 'step', target: e, delta, prefix: false };
    }
    return e;
  }

  private primary(): Expr {
    const t = this.next();
    if (t.k === 'num') return t.text === '.' ? { t: 'last' } : { t: 'num', text: t.text };
    if (t.k === 'op' && t.text === '(') {
      const e = this.expression();
      this.expectOp(')');
      return { t: 'paren', e };
    }
    if (t.k === 'name') {
      if (this.isOp('(')) {
        this.p++;
        const args: Arg[] = [];
        if (!this.isOp(')')) {
          do {
            const n = this.peek();
            const after = this.toks[this.p + 1];
            const closing = this.toks[this.p + 2];
            if (n.k === 'name' && after.k === 'op' && after.text === '[' && closing.k === 'op' && closing.text === ']') {
              this.p += 3;
              args.push({ array: n.text });
            } else args.push({ expr: this.expression() });
          } while (this.eatOp(','));
        }
        this.expectOp(')');
        return { t: 'call', name: t.text, args };
      }
      if (this.isOp('[')) {
        this.p++;
        const index = this.expression();
        this.expectOp(']');
        return { t: 'elem', name: t.text, index };
      }
      if (t.text === 'last') return { t: 'last' };
      return { t: 'var', name: t.text };
    }
    this.p--;
    return this.fail();
  }
}

type ArrayStore = Map<number, Num>;

function constantCost(text: string): number {
  const normal = text.replace(/^0+(?=[0-9])/, '').replace(/^0(?=\.)/, '');
  return normal === '0' || normal === '1' ? 1 : normal.length + 2;
}

interface Frame {
  pc: number;
  readonly name: string;
  readonly scalars: Map<string, Num>;
  readonly arrays: Map<string, ArrayStore>;
}

const WRAP_COLUMN = 68;

class Interp {
  scale = 0;
  ibase = 10;
  obase = 10;
  last: Num = ZERO;
  readonly out: string[] = [];
  readonly err: string[] = [];
  readonly interleaved: string[] = [];
  private column = 0;
  private readonly globals: Frame = { pc: 0, name: '(main)', scalars: new Map(), arrays: new Map() };
  private readonly functions = new Map<string, FunctionDef>();
  private frames: Frame[] = [this.globals];
  private halted = false;

  get stopped(): boolean { return this.halted; }

  private emit(text: string): void {
    this.out.push(text);
    this.interleaved.push(text);
    const at = text.lastIndexOf('\n');
    this.column = at === -1 ? this.column + text.length : text.length - at - 1;
  }

  private emitError(text: string): void {
    this.err.push(`${text}\n`);
    this.interleaved.push(`${text}\n`);
  }

  private emitDigits(text: string): void {
    for (const ch of text) {
      if (this.column === WRAP_COLUMN) this.emit('\\\n');
      this.emit(ch);
    }
  }

  run(source: string): void {
    const items = new Parser(lex(source)).parseAll();
    let failedLine = -1;
    let currentLine = -1;
    for (const item of items) {
      if (item.line !== currentLine) { currentLine = item.line; this.globals.pc = 0; }
      if (this.halted) return;
      if ('error' in item) {
        this.emitError(`(standard_in) ${item.error}: syntax error`);
        continue;
      }
      if (item.line === failedLine) continue;
      if ('define' in item) { this.functions.set(item.define, item.fn); continue; }
      try {
        this.exec(item.stmt, true);
      } catch (error) {
        if (error instanceof HaltSignal) { this.halted = true; return; }
        if (error instanceof BcError) {
          this.emitError(error.message);
          this.frames = [this.globals];
          failedLine = item.line;
          continue;
        }
        if (error instanceof BreakSignal || error instanceof ContinueSignal || error instanceof ReturnSignal) continue;
        throw error;
      }
    }
  }

  private runtime(message: string): BcError {
    return new BcError(`Runtime error (func=${this.frame().name}, adr=${this.frame().pc}): ${message}`);
  }

  private frame(): Frame { return this.frames[this.frames.length - 1]; }

  private exec(s: Stmt, top = false): void {
    switch (s.t) {
      case 'expr': {
        const value = this.eval(s.e);
        this.charge(1);
        if (s.e.t !== 'assign') {
          this.emitDigits(this.format(value));
          this.emit('\n');
          this.last = value;
        }
        return;
      }
      case 'str': this.emit(s.text); return;
      case 'print':
        for (const item of s.items) {
          if ('str' in item) this.emit(item.str.replace(/\\(.)/g, (_m, c: string) => ({ n: '\n', t: '\t', a: '\x07', b: '\b', f: '\f', r: '\r', q: '"', '\\': '\\' } as Record<string, string>)[c] ?? c));
          else this.emitDigits(this.format(this.eval(item.expr)));
        }
        return;
      case 'if':
        if (this.eval(s.cond).v !== 0n) this.exec(s.then);
        else if (s.otherwise !== null) this.exec(s.otherwise);
        return;
      case 'while':
        while (this.eval(s.cond).v !== 0n) {
          try { this.exec(s.body); } catch (e) { if (e instanceof BreakSignal) break; if (!(e instanceof ContinueSignal)) throw e; }
        }
        return;
      case 'for':
        if (s.init !== null) this.eval(s.init);
        while (s.cond === null || this.eval(s.cond).v !== 0n) {
          try { this.exec(s.body); } catch (e) { if (e instanceof BreakSignal) break; if (!(e instanceof ContinueSignal)) throw e; }
          if (s.step !== null) this.eval(s.step);
        }
        return;
      case 'break': throw new BreakSignal('break');
      case 'continue': throw new ContinueSignal('continue');
      case 'halt': case 'quit': throw new HaltSignal('halt');
      case 'limits':
        this.emit('BC_BASE_MAX     = 2147483647\nBC_DIM_MAX      = 16777215\nBC_SCALE_MAX    = 2147483647\nBC_STRING_MAX   = 2147483647\nMAX Exponent    = 9223372036854775807\nNumber of vars  = 32767\n');
        return;
      case 'return': throw new ReturnSignal(s.e === null ? ZERO : this.eval(s.e));
      case 'block':
        for (const inner of s.body) this.exec(inner, top);
        return;
    }
  }

  private lookupScalar(name: string): Num {
    if (name === 'scale') return { v: BigInt(this.scale), s: 0 };
    if (name === 'ibase') return { v: BigInt(this.ibase), s: 0 };
    if (name === 'obase') return { v: BigInt(this.obase), s: 0 };
    const frame = this.frame();
    return frame.scalars.get(name) ?? this.globals.scalars.get(name) ?? ZERO;
  }

  private storeScalar(name: string, value: Num): void {
    const whole = (): number => Number(rescale(value, 0).v);
    if (name === 'scale') { this.scale = whole(); return; }
    if (name === 'ibase') { this.ibase = whole(); return; }
    if (name === 'obase') { this.obase = whole(); return; }
    const frame = this.frame();
    if (frame.scalars.has(name)) frame.scalars.set(name, value);
    else this.globals.scalars.set(name, value);
  }

  private arrayOf(name: string, create = true): ArrayStore {
    const frame = this.frame();
    const local = frame.arrays.get(name);
    if (local !== undefined) return local;
    let store = this.globals.arrays.get(name);
    if (store === undefined && create) { store = new Map(); this.globals.arrays.set(name, store); }
    return store ?? new Map();
  }

  private indexOf(e: Expr): number {
    const n = this.eval(e);
    const i = rescale(n, 0).v;
    if (i < 0n) throw this.runtime('Array subscript out of bounds');
    return Number(i);
  }

  private read(target: Expr): Num {
    if (target.t === 'var') return this.lookupScalar(target.name);
    if (target.t === 'elem') return this.arrayOf(target.name).get(this.indexOf(target.index)) ?? ZERO;
    return ZERO;
  }

  private write(target: Expr, value: Num): void {
    if (target.t === 'var') this.storeScalar(target.name, value);
    else if (target.t === 'elem') this.arrayOf(target.name).set(this.indexOf(target.index), value);
  }

  private charge(bytes: number): void { this.frame().pc += bytes; }

  private eval(e: Expr): Num {
    switch (e.t) {
      case 'num': this.charge(constantCost(e.text)); return this.parseNumber(e.text);
      case 'last': this.charge(1); return this.last;
      case 'var': this.charge(2); return this.read(e);
      case 'elem': this.charge(2); return this.read(e);
      case 'paren': return this.eval(e.e);
      case 'neg': { const n = this.eval(e.e); this.charge(1); return { v: -n.v, s: n.s }; }
      case 'not': { const n = this.eval(e.e); this.charge(1); return n.v === 0n ? ONE : ZERO; }
      case 'assign': {
        const rhs = this.eval(e.value);
        if (e.op !== '=') this.charge(3);
        this.charge(2);
        const value = e.op === '=' ? rhs : this.binary(e.op[0], this.read(e.target), rhs);
        this.write(e.target, value);
        return value;
      }
      case 'step': {
        this.charge(4);
        const before = this.read(e.target);
        const after = this.binary('+', before, { v: BigInt(e.delta), s: 0 });
        this.write(e.target, after);
        return e.prefix ? after : before;
      }
      case 'bin': return this.evalBinary(e);
      case 'call': return this.call(e.name, e.args);
    }
  }

  private evalBinary(e: Extract<Expr, { t: 'bin' }>): Num {
    if (e.op === '&&') return this.eval(e.l).v !== 0n && this.eval(e.r).v !== 0n ? ONE : ZERO;
    if (e.op === '||') return this.eval(e.l).v !== 0n || this.eval(e.r).v !== 0n ? ONE : ZERO;
    const a = this.eval(e.l);
    const b = this.eval(e.r);
    this.charge(1);
    if (['==', '!=', '<', '<=', '>', '>='].includes(e.op)) {
      const c = compare(a, b);
      const ok = e.op === '==' ? c === 0 : e.op === '!=' ? c !== 0 : e.op === '<' ? c < 0 : e.op === '<=' ? c <= 0 : e.op === '>' ? c > 0 : c >= 0;
      return ok ? ONE : ZERO;
    }
    return this.binary(e.op, a, b);
  }

  private call(name: string, args: Arg[]): Num {
    if (name === 'sqrt' || name === 'length' || name === 'scale') {
      const first = args[0];
      if (first === undefined || !('expr' in first)) throw this.runtime('Parameter number mismatch');
      const value = this.eval(first.expr);
      this.charge(2);
      if (name === 'sqrt') return this.sqrt(value);
      if (name === 'scale') return { v: BigInt(value.s), s: 0 };
      const digits = (value.v < 0n ? -value.v : value.v).toString().length;
      return { v: BigInt(Math.max(digits, value.s)), s: 0 };
    }
    const fn = this.functions.get(name);
    const values = args.map((arg) => { if ('expr' in arg) return this.eval(arg.expr); this.charge(2); return null; });
    this.charge(2);
    if (fn === undefined) throw this.runtime(`Function ${name} not defined.`);
    this.charge(args.length === 0 ? 1 : 2);
    if (fn.params.length !== args.length) throw this.runtime('Parameter number mismatch');
    const frame: Frame = { pc: 0, name, scalars: new Map(), arrays: new Map() };
    fn.params.forEach((param, index) => {
      const arg = args[index];
      if (param.array) {
        if (!('array' in arg)) throw this.runtime('Parameter type mismatch');
        frame.arrays.set(param.name, this.arrayOf(arg.array));
      } else {
        if (!('expr' in arg)) throw this.runtime('Parameter type mismatch');
        frame.scalars.set(param.name, values[index] ?? ZERO);
      }
    });
    for (const local of fn.autos) {
      if (local.array) frame.arrays.set(local.name, new Map());
      else frame.scalars.set(local.name, ZERO);
    }
    this.frames.push(frame);
    try {
      for (const s of fn.body) this.exec(s);
      return ZERO;
    } catch (error) {
      if (error instanceof ReturnSignal) return error.value;
      throw error;
    } finally {
      this.frames.pop();
    }
  }

  private sqrt(n: Num): Num {
    if (n.v < 0n) throw this.runtime('Square root of a negative number');
    const s = Math.max(this.scale, n.s);
    const target = rescale(n, s * 2).v;
    if (target === 0n) return { v: 0n, s };
    let x = target;
    let y = (x + 1n) / 2n;
    while (y < x) { x = y; y = (x + target / x) / 2n; }
    return { v: x, s };
  }

  private parseNumber(text: string): Num {
    const dot = text.indexOf('.');
    const intPart = dot === -1 ? text : text.slice(0, dot);
    const fracPart = dot === -1 ? '' : text.slice(dot + 1);
    if (text.length === 1 && text !== '.') return { v: BigInt(parseInt(text, 16)), s: 0 };
    const base = BigInt(this.ibase);
    const digit = (ch: string): bigint => { const d = BigInt(parseInt(ch, 16)); return d >= base ? base - 1n : d; };
    let v = 0n;
    for (const ch of intPart) v = v * base + digit(ch);
    if (fracPart === '') return { v, s: 0 };
    let f = 0n;
    for (const ch of fracPart) f = f * base + digit(ch);
    const s = fracPart.length;
    const scaled = (v * base ** BigInt(s) + f) * pow10(s) / base ** BigInt(s);
    return { v: scaled, s };
  }

  private binary(op: string, a: Num, b: Num): Num {
    if (op === '+' || op === '-') {
      const [x, y, s] = align(a, b);
      return { v: op === '+' ? x + y : x - y, s };
    }
    if (op === '*') {
      const raw: Num = { v: a.v * b.v, s: a.s + b.s };
      return rescale(raw, Math.min(a.s + b.s, Math.max(this.scale, a.s, b.s)));
    }
    if (op === '/') return this.divide(a, b, this.scale);
    if (op === '%') {
      if (b.v === 0n) throw this.runtime('Modulo by zero');
      const q = this.divide(a, b, this.scale);
      const prod = this.binary('*', q, b);
      const [x, y, s] = align(a, prod);
      return { v: x - y, s };
    }
    return this.power(a, b);
  }

  private divide(a: Num, b: Num, s: number): Num {
    if (b.v === 0n) throw this.runtime('Divide by zero');
    return { v: (a.v * pow10(b.s + s)) / (b.v * pow10(a.s)), s };
  }

  private power(a: Num, b: Num): Num {
    if (b.s !== 0 && rescale(b, 0).v * pow10(b.s) !== b.v) this.emitError(`Runtime warning (func=${this.frame().name}, adr=${this.frame().pc}): non-zero scale in exponent`);
    const e = rescale(b, 0).v;
    if (e === 0n) return ONE;
    const negative = e < 0n;
    const n = negative ? -e : e;
    let acc: Num = ONE;
    let base = a;
    let k = n;
    while (k > 0n) {
      if (k % 2n === 1n) acc = { v: acc.v * base.v, s: acc.s + base.s };
      base = { v: base.v * base.v, s: base.s * 2 };
      k /= 2n;
    }
    if (negative) return this.divide(ONE, acc, this.scale);
    return rescale(acc, Math.min(a.s * Number(n), Math.max(this.scale, a.s)));
  }

  private digitText(d: number): string {
    if (this.obase <= 16) return d.toString(16).toUpperCase();
    return ` ${String(d).padStart(String(this.obase - 1).length, '0')}`;
  }

  format(n: Num): string {
    if (n.v === 0n) return '0';
    const negative = n.v < 0n;
    const abs = negative ? -n.v : n.v;
    const d = pow10(n.s);
    const intPart = abs / d;
    let frac = abs % d;
    let head = '';
    if (this.obase === 10) head = intPart === 0n ? '' : intPart.toString();
    else if (intPart !== 0n) {
      const base = BigInt(this.obase);
      const digits: number[] = [];
      let rest = intPart;
      while (rest > 0n) { digits.unshift(Number(rest % base)); rest /= base; }
      head = digits.map((x) => this.digitText(x)).join('');
    }
    let tail = '';
    if (n.s > 0) {
      if (this.obase === 10) tail = `.${frac.toString().padStart(n.s, '0')}`;
      else {
        const base = BigInt(this.obase);
        const limit = pow10(n.s);
        let weight = 1n;
        let digits = '';
        do {
          frac *= base;
          const digit = frac / d;
          frac %= d;
          digits += this.digitText(Number(digit));
          weight *= base;
        } while (weight <= limit);
        tail = `.${digits}`;
      }
    }
    return `${negative ? '-' : ''}${head === '' && tail === '' ? '0' : head}${tail}`;
  }
}

const VERSION = [
  'bc 1.07.1',
  'Copyright 1991-1994, 1997, 1998, 2000, 2004, 2006, 2008, 2012-2017 Free Software Foundation, Inc.',
].join('\n');

const USAGE = [
  'usage: bc [options] [file ...]',
  '  -h  --help         print this usage and exit',
  '  -i  --interactive  force interactive mode',
  '  -l  --mathlib      use the predefined math routines',
  '  -q  --quiet        don\'t print initial banner',
  '  -s  --standard     non-standard bc constructs are errors',
  '  -w  --warn         warn about non-standard bc constructs',
  '  -v  --version      print version information and exit',
].join('\n');

interface BcOutcome { output: string; exitCode: number; stderr?: string; interleaved?: string }

function bcRun(ctx: LinuxCommandContext, args: string[], stdin?: string): BcOutcome {
  const files: string[] = [];
  let mathlib = false;
  for (const a of args) {
    if (a === '-v' || a === '--version') return { output: VERSION, exitCode: 0 };
    if (a === '-h' || a === '--help') return { output: USAGE, exitCode: 0 };
    if (a === '-l' || a === '--mathlib') { mathlib = true; continue; }
    if (['-q', '--quiet', '-s', '--standard', '-w', '--warn', '-i', '--interactive'].includes(a)) continue;
    if (a.startsWith('-') && a !== '-') {
      const text = a.startsWith('--') ? `bc: unrecognized option '${a}'` : `bc: invalid option -- '${a[1]}'`;
      return { output: '', stderr: `${text}\n${USAGE}\n`, interleaved: `${text}\n${USAGE}\n`, exitCode: 1 };
    }
    files.push(a);
  }
  const interp = new Interp();
  if (mathlib) {
    interp.scale = 20;
    interp.run(BC_MATH_LIBRARY);
  }
  const sources: string[] = [];
  for (const f of files) {
    const content = ctx.executor.vfs.readFile(ctx.executor.vfs.normalizePath(f, ctx.executor.getCwd()));
    if (content === null) {
      const text = `File ${f} is unavailable.`;
      return { output: '', stderr: `${text}\n`, interleaved: `${text}\n`, exitCode: 1 };
    }
    sources.push(content);
  }
  if (stdin !== undefined) sources.push(stdin);
  if (sources.length === 0) return { output: VERSION, exitCode: 0 };
  for (const source of sources) {
    if (interp.stopped) break;
    interp.run(source);
  }
  return { output: interp.out.join(''), stderr: interp.err.join(''), interleaved: interp.interleaved.join(''), exitCode: 0 };
}

export const bcCommand: LinuxCommand = {
  name: 'bc',
  package: 'bc',
  needsNetworkContext: true,
  readsStdin: true,
  manSection: 1,
  usage: 'bc [-l] [-q] [file ...]',
  help: 'An arbitrary precision calculator language. Reads expressions and statements from\n'
    + 'the given files then from standard input, and prints the value of each one that is\n'
    + 'not an assignment. The language has variables, arrays, define, if, while, for,\n'
    + 'print, ibase, obase, scale and sqrt(); -l loads the math library (s, c, a, l, e, j).',
  options: [
    { flag: '-l', aliases: ['--mathlib'], dest: 'mathlib', description: 'Use the standard math library' },
    { flag: '-q', aliases: ['--quiet'], dest: 'quiet', description: 'Do not print the initial banner' },
    { flag: '-v', aliases: ['--version'], dest: 'version', description: 'Print the version and exit' },
  ],
  run(ctx: LinuxCommandContext, args: string[], stdin?: string): string {
    return bcRun(ctx, args, stdin).output;
  },
  runWithStatusSync(ctx: LinuxCommandContext, args: string[], stdin?: string) {
    return bcRun(ctx, args, stdin);
  },
};
