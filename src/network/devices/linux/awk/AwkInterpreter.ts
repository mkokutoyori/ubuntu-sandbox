import type {
  Program, Rule, Stmt, Expr, LValue, FunctionDef, Redirect,
} from './AwkAst';
import {
  Cell, StrNum, UNINIT, toNum, toStr, truthy, compareCells, applyFormat,
  makeFieldCell, isNumericCell,
} from './AwkValue';
import { compileEre } from './AwkRegex';

export interface AwkHost {
  readFile(path: string): string | null;
  writeFile(path: string, content: string, append: boolean): void;
}

export interface AwkInputRecord {
  text: string;
  filename: string;
}

class NextSignal {}
class NextFileSignal {}
class BreakSignal {}
class ContinueSignal {}
class ExitSignal { constructor(readonly code: number) {} }
class ReturnSignal { constructor(readonly value: Cell) {} }

interface Frame {
  scalars: Map<string, Cell>;
  arrays: Map<string, Map<string, Cell>>;
  locals: Set<string>;
}

const DEFAULTS: Record<string, Cell> = {
  FS: ' ', OFS: ' ', ORS: '\n', RS: '\n', SUBSEP: '\x1c',
  CONVFMT: '%.6g', OFMT: '%.6g', FILENAME: '', RSTART: 0, RLENGTH: -1,
  NR: 0, NF: 0, FNR: 0,
};

export class AwkInterpreter {
  private globals = new Map<string, Cell>();
  private arrays = new Map<string, Map<string, Cell>>();
  private frames: Frame[] = [];
  private fields: string[] = [];
  private record = '';
  private out = '';
  private fileBuffers = new Map<string, { content: string; append: boolean }>();
  private getlineCursors = new Map<string, { lines: string[]; pos: number }>();
  private records: AwkInputRecord[] = [];
  private recordIndex = 0;
  private rangeActive: boolean[] = [];
  private exitCode = 0;
  private seed = 0;

  constructor(
    private program: Program,
    private host: AwkHost | null,
    initialVars: Record<string, string>,
  ) {
    for (const [k, v] of Object.entries(DEFAULTS)) this.globals.set(k, v);
    for (const [k, v] of Object.entries(initialVars)) this.globals.set(k, new StrNum(v));
    this.rangeActive = program.rules.map(() => false);
  }

  run(records: AwkInputRecord[]): { output: string; files: Map<string, { content: string; append: boolean }>; exitCode: number } {
    this.records = records;
    try {
      this.runSpecial('begin');
      if (this.hasMainWork()) this.runMainLoop();
      this.runSpecial('end');
    } catch (e) {
      if (e instanceof ExitSignal) {
        this.exitCode = e.code;
        try { this.runEndAfterExit(); } catch (e2) { if (!(e2 instanceof ExitSignal)) throw e2; if (e2 instanceof ExitSignal) this.exitCode = e2.code; }
      } else {
        throw e;
      }
    }
    return { output: this.out, files: this.fileBuffers, exitCode: this.exitCode };
  }

  private runEndAfterExit(): void {
    for (const rule of this.program.rules) {
      if (rule.pattern.type === 'end') this.execAction(rule.action);
    }
  }

  private hasMainWork(): boolean {
    return this.program.rules.some(r => r.pattern.type !== 'begin');
  }

  private runSpecial(kind: 'begin' | 'end'): void {
    for (const rule of this.program.rules) {
      if (rule.pattern.type === kind) this.execAction(rule.action);
    }
  }

  private runMainLoop(): void {
    let lastFile = '';
    let fnr = 0;
    while (this.recordIndex < this.records.length) {
      const rec = this.records[this.recordIndex++];
      if (rec.filename !== lastFile) { fnr = 0; lastFile = rec.filename; }
      fnr++;
      this.globals.set('NR', toNum(this.globals.get('NR') ?? 0) + 1);
      this.globals.set('FNR', fnr);
      this.globals.set('FILENAME', new StrNum(rec.filename));
      this.setRecord(rec.text);
      try {
        this.runRules();
      } catch (e) {
        if (e instanceof NextSignal) continue;
        if (e instanceof NextFileSignal) { this.skipToNextFile(lastFile); continue; }
        throw e;
      }
    }
  }

  private skipToNextFile(current: string): void {
    while (this.recordIndex < this.records.length && this.records[this.recordIndex].filename === current) {
      this.recordIndex++;
    }
  }

  private runRules(): void {
    this.program.rules.forEach((rule, idx) => {
      if (rule.pattern.type === 'begin' || rule.pattern.type === 'end') return;
      if (this.patternMatches(rule, idx)) this.execAction(rule.action);
    });
  }

  private patternMatches(rule: Rule, idx: number): boolean {
    const p = rule.pattern;
    if (p.type === 'always') return true;
    if (p.type === 'expr') return truthy(this.eval(p.expr));
    if (p.type === 'range') {
      if (!this.rangeActive[idx]) {
        if (truthy(this.eval(p.start))) {
          this.rangeActive[idx] = !truthy(this.eval(p.end));
          return true;
        }
        return false;
      }
      if (truthy(this.eval(p.end))) this.rangeActive[idx] = false;
      return true;
    }
    return false;
  }

  private execAction(action: Stmt[] | null): void {
    if (action === null) { this.emit(this.getField(0)); return; }
    for (const stmt of action) this.exec(stmt);
  }

  private exec(stmt: Stmt): void {
    switch (stmt.kind) {
      case 'expr': this.eval(stmt.expr); return;
      case 'print': this.execPrint(stmt.args, stmt.output); return;
      case 'printf': this.execPrintf(stmt.args, stmt.output); return;
      case 'block': for (const s of stmt.body) this.exec(s); return;
      case 'if': if (truthy(this.eval(stmt.cond))) this.exec(stmt.then); else if (stmt.else) this.exec(stmt.else); return;
      case 'while': this.execWhile(stmt.cond, stmt.body); return;
      case 'doWhile': this.execDoWhile(stmt.body, stmt.cond); return;
      case 'for': this.execFor(stmt); return;
      case 'forIn': this.execForIn(stmt); return;
      case 'next': throw new NextSignal();
      case 'nextfile': throw new NextFileSignal();
      case 'break': throw new BreakSignal();
      case 'continue': throw new ContinueSignal();
      case 'exit': throw new ExitSignal(stmt.code ? Math.trunc(toNum(this.eval(stmt.code))) : this.exitCode);
      case 'return': throw new ReturnSignal(stmt.value ? this.eval(stmt.value) : UNINIT);
      case 'delete': this.execDelete(stmt.name, stmt.subscripts); return;
      case 'getline': this.eval(stmt.expr); return;
    }
  }

  private execWhile(cond: Expr, body: Stmt): void {
    let guard = 10_000_000;
    while (truthy(this.eval(cond))) {
      if (guard-- <= 0) break;
      try { this.exec(body); }
      catch (e) { if (e instanceof BreakSignal) break; if (e instanceof ContinueSignal) continue; throw e; }
    }
  }

  private execDoWhile(body: Stmt, cond: Expr): void {
    let guard = 10_000_000;
    do {
      if (guard-- <= 0) break;
      try { this.exec(body); }
      catch (e) { if (e instanceof BreakSignal) break; if (e instanceof ContinueSignal) continue; throw e; }
    } while (truthy(this.eval(cond)));
  }

  private execFor(stmt: Extract<Stmt, { kind: 'for' }>): void {
    if (stmt.init) this.exec(stmt.init);
    let guard = 10_000_000;
    while (stmt.cond === null || truthy(this.eval(stmt.cond))) {
      if (guard-- <= 0) break;
      try { this.exec(stmt.body); }
      catch (e) {
        if (e instanceof BreakSignal) break;
        if (e instanceof ContinueSignal) { if (stmt.update) this.exec(stmt.update); continue; }
        throw e;
      }
      if (stmt.update) this.exec(stmt.update);
    }
  }

  private execForIn(stmt: Extract<Stmt, { kind: 'forIn' }>): void {
    const arr = this.getArray(stmt.array);
    for (const key of [...arr.keys()]) {
      this.setScalar(stmt.var, new StrNum(key));
      try { this.exec(stmt.body); }
      catch (e) { if (e instanceof BreakSignal) break; if (e instanceof ContinueSignal) continue; throw e; }
    }
  }

  private execDelete(name: string, subscripts: Expr[] | null): void {
    const arr = this.getArray(name);
    if (subscripts === null) { arr.clear(); return; }
    arr.delete(this.subscriptKey(subscripts));
  }

  private execPrint(args: Expr[], output: Redirect | null): void {
    const ofs = toStr(this.globals.get('OFS') ?? ' ', this.convfmt());
    const ors = toStr(this.globals.get('ORS') ?? '\n', this.convfmt());
    const ofmt = toStr(this.globals.get('OFMT') ?? '%.6g', this.convfmt());
    let line: string;
    if (args.length === 0) line = this.getField0Str();
    else line = args.map(a => this.outputStr(this.eval(a), ofmt)).join(ofs);
    this.writeOut(line + ors, output);
  }

  private execPrintf(args: Expr[], output: Redirect | null): void {
    if (args.length === 0) return;
    const fmt = toStr(this.eval(args[0]), this.convfmt());
    const rest = args.slice(1).map(a => this.eval(a));
    this.writeOut(applyFormat(fmt, rest), output);
  }

  private outputStr(c: Cell, ofmt: string): string {
    if (typeof c === 'number' && !Number.isInteger(c)) return applyFormat(ofmt, [c]);
    return toStr(c, this.convfmt());
  }

  private writeOut(text: string, output: Redirect | null): void {
    if (!output) { this.out += text; return; }
    const target = toStr(this.eval(output.target), this.convfmt());
    if (output.type === 'pipe') { this.out += text; return; }
    const existing = this.fileBuffers.get(target);
    if (existing) existing.content += text;
    else this.fileBuffers.set(target, { content: text, append: output.type === 'append' });
  }

  private emit(c: Cell): void {
    const ors = toStr(this.globals.get('ORS') ?? '\n', this.convfmt());
    this.out += toStr(c, this.convfmt()) + ors;
  }

  eval(e: Expr): Cell {
    switch (e.kind) {
      case 'num': return e.value;
      case 'str': return e.value;
      case 'regex': return this.matchRegex(this.getField0Str(), e.value) ? 1 : 0;
      case 'var': return this.getScalar(e.name);
      case 'field': return makeFieldCell(this.getField(Math.trunc(toNum(this.eval(e.index)))));
      case 'index': return this.getArray(e.name).get(this.subscriptKey(e.subscripts)) ?? UNINIT;
      case 'grouping': return this.eval(e.expr);
      case 'assign': return this.evalAssign(e.op, e.target, e.value);
      case 'ternary': return truthy(this.eval(e.cond)) ? this.eval(e.then) : this.eval(e.else);
      case 'logical': return this.evalLogical(e.op, e.left, e.right);
      case 'binary': return this.evalBinary(e.op, e.left, e.right);
      case 'match': return this.evalMatch(e.negated, e.left, e.right);
      case 'in': return this.getArray(e.array).has(this.subscriptKey(e.subscripts)) ? 1 : 0;
      case 'concat': return e.parts.map(p => toStr(this.eval(p), this.convfmt())).join('');
      case 'unary': return this.evalUnary(e.op, e.operand);
      case 'preIncr': return this.evalIncr(e.op, e.target, true);
      case 'postIncr': return this.evalIncr(e.op, e.target, false);
      case 'builtin': return this.evalBuiltin(e.name, e.args);
      case 'call': return this.callFunction(e.name, e.args);
      case 'getline': return this.evalGetline(e);
    }
  }

  private evalLogical(op: 'and' | 'or', left: Expr, right: Expr): Cell {
    const l = truthy(this.eval(left));
    if (op === 'and') return l && truthy(this.eval(right)) ? 1 : 0;
    return l || truthy(this.eval(right)) ? 1 : 0;
  }

  private evalMatch(negated: boolean, left: Expr, right: Expr): Cell {
    const s = toStr(this.eval(left), this.convfmt());
    const re = right.kind === 'regex' ? right.value : toStr(this.eval(right), this.convfmt());
    const m = this.matchRegex(s, re);
    return (negated ? !m : m) ? 1 : 0;
  }

  private evalUnary(op: string, operand: Expr): Cell {
    if (op === '!') return truthy(this.eval(operand)) ? 0 : 1;
    if (op === '-') return -toNum(this.eval(operand));
    return +toNum(this.eval(operand));
  }

  private evalBinary(op: string, leftE: Expr, rightE: Expr): Cell {
    if (['<', '<=', '>', '>=', '==', '!='].includes(op)) {
      const c = compareCells(this.eval(leftE), this.eval(rightE), this.convfmt());
      switch (op) {
        case '<': return c < 0 ? 1 : 0;
        case '<=': return c <= 0 ? 1 : 0;
        case '>': return c > 0 ? 1 : 0;
        case '>=': return c >= 0 ? 1 : 0;
        case '==': return c === 0 ? 1 : 0;
        case '!=': return c !== 0 ? 1 : 0;
      }
    }
    const l = toNum(this.eval(leftE));
    const r = toNum(this.eval(rightE));
    switch (op) {
      case '+': return l + r;
      case '-': return l - r;
      case '*': return l * r;
      case '/': return r === 0 ? this.divZero() : l / r;
      case '%': return r === 0 ? this.divZero() : l % r;
      case '^': return Math.pow(l, r);
    }
    return 0;
  }

  private divZero(): never {
    throw new ExitSignal(2);
  }

  private evalAssign(op: string, target: LValue, valueExpr: Expr): Cell {
    let value: Cell;
    if (op === '=') {
      value = this.eval(valueExpr);
    } else {
      const cur = toNum(this.readLValue(target));
      const rhs = toNum(this.eval(valueExpr));
      switch (op) {
        case '+=': value = cur + rhs; break;
        case '-=': value = cur - rhs; break;
        case '*=': value = cur * rhs; break;
        case '/=': value = rhs === 0 ? this.divZero() : cur / rhs; break;
        case '%=': value = rhs === 0 ? this.divZero() : cur % rhs; break;
        case '^=': case '**=': value = Math.pow(cur, rhs); break;
        default: value = rhs;
      }
    }
    this.writeLValue(target, value);
    return value;
  }

  private evalIncr(op: string, target: LValue, pre: boolean): Cell {
    const cur = toNum(this.readLValue(target));
    const next = op === '++' ? cur + 1 : cur - 1;
    this.writeLValue(target, next);
    return pre ? next : cur;
  }

  private readLValue(lv: LValue): Cell {
    if (lv.kind === 'var') return this.getScalar(lv.name);
    if (lv.kind === 'field') return makeFieldCell(this.getField(Math.trunc(toNum(this.eval(lv.index)))));
    return this.getArray(lv.name).get(this.subscriptKey(lv.subscripts)) ?? UNINIT;
  }

  private writeLValue(lv: LValue, value: Cell): void {
    if (lv.kind === 'var') { this.setScalar(lv.name, value); return; }
    if (lv.kind === 'field') { this.setField(Math.trunc(toNum(this.eval(lv.index))), toStr(value, this.convfmt())); return; }
    this.getArray(lv.name).set(this.subscriptKey(lv.subscripts), value);
  }

  private subscriptKey(subs: Expr[]): string {
    const subsep = toStr(this.globals.get('SUBSEP') ?? '\x1c', this.convfmt());
    return subs.map(s => toStr(this.eval(s), this.convfmt())).join(subsep);
  }

  private convfmt(): string {
    const c = this.globals.get('CONVFMT');
    return c ? (typeof c === 'string' ? c : toStr(c, '%.6g')) : '%.6g';
  }

  private currentFrame(): Frame | null {
    return this.frames.length ? this.frames[this.frames.length - 1] : null;
  }

  private getScalar(name: string): Cell {
    const f = this.currentFrame();
    if (f && f.locals.has(name)) return f.scalars.get(name) ?? UNINIT;
    return this.globals.get(name) ?? UNINIT;
  }

  private setScalar(name: string, value: Cell): void {
    const f = this.currentFrame();
    if (f && f.locals.has(name)) { f.scalars.set(name, value); return; }
    if (name === 'NF') { this.setNF(Math.trunc(toNum(value))); return; }
    this.globals.set(name, value);
  }

  private getArray(name: string): Map<string, Cell> {
    const f = this.currentFrame();
    if (f && f.locals.has(name)) {
      let a = f.arrays.get(name);
      if (!a) { a = new Map(); f.arrays.set(name, a); }
      return a;
    }
    let arr = this.arrays.get(name);
    if (!arr) { arr = new Map(); this.arrays.set(name, arr); }
    return arr;
  }

  private setRecord(text: string): void {
    this.record = text;
    this.splitRecord();
  }

  private splitRecord(): void {
    const fs = toStr(this.globals.get('FS') ?? ' ', this.convfmt());
    this.fields = this.splitByFs(this.record, fs);
    this.globals.set('NF', this.fields.length);
  }

  private splitByFs(text: string, fs: string): string[] {
    if (text === '') return [];
    if (fs === ' ') {
      const t = text.replace(/^[ \t\n]+|[ \t\n]+$/g, '');
      return t === '' ? [] : t.split(/[ \t\n]+/);
    }
    if (fs === '') return text.split('');
    if (fs.length === 1 && fs !== '\t') {
      if ('\\^$.|?*+()[]{}'.includes(fs)) return text.split(new RegExp('\\' + fs));
      return text.split(fs);
    }
    if (fs === '\t') return text.split('\t');
    return text.split(compileEre(fs));
  }

  private getField(i: number): string {
    if (i === 0) return this.record;
    return this.fields[i - 1] ?? '';
  }

  private getField0Str(): string {
    return this.record;
  }

  private setField(i: number, value: string): void {
    if (i === 0) { this.setRecord(value); return; }
    while (this.fields.length < i) this.fields.push('');
    this.fields[i - 1] = value;
    this.globals.set('NF', this.fields.length);
    this.rebuildRecord();
  }

  private setNF(nf: number): void {
    const n = Math.max(0, nf);
    if (n < this.fields.length) this.fields.length = n;
    else while (this.fields.length < n) this.fields.push('');
    this.globals.set('NF', this.fields.length);
    this.rebuildRecord();
  }

  private rebuildRecord(): void {
    const ofs = toStr(this.globals.get('OFS') ?? ' ', this.convfmt());
    this.record = this.fields.join(ofs);
  }

  private matchRegex(s: string, ere: string): boolean {
    return compileEre(ere).test(s);
  }

  private evalGetline(e: Extract<Expr, { kind: 'getline' }>): Cell {
    if (e.source && e.source.type === 'file') {
      const path = toStr(this.eval(e.source.expr), this.convfmt());
      const cursor = this.fileCursor(path);
      if (!cursor) return -1;
      if (cursor.pos >= cursor.lines.length) return 0;
      const line = cursor.lines[cursor.pos++];
      if (e.into) this.writeLValue(e.into, makeFieldCell(line));
      else { this.setRecord(line); this.globals.set('NR', toNum(this.globals.get('NR') ?? 0) + 1); }
      return 1;
    }
    if (this.recordIndex >= this.records.length) return 0;
    const rec = this.records[this.recordIndex++];
    this.globals.set('NR', toNum(this.globals.get('NR') ?? 0) + 1);
    this.globals.set('FNR', toNum(this.globals.get('FNR') ?? 0) + 1);
    if (e.into) this.writeLValue(e.into, makeFieldCell(rec.text));
    else this.setRecord(rec.text);
    return 1;
  }

  private fileCursor(path: string): { lines: string[]; pos: number } | null {
    const cached = this.getlineCursors.get(path);
    if (cached) return cached;
    if (!this.host) return null;
    const content = this.host.readFile(path);
    if (content === null) { return null; }
    const lines = content.split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    const cursor = { lines, pos: 0 };
    this.getlineCursors.set(path, cursor);
    return cursor;
  }

  private callFunction(name: string, argExprs: Expr[]): Cell {
    const fn = this.program.functions.get(name);
    if (!fn) throw new AwkRuntimeError(`awk: calling undefined function ${name}`);
    const frame = this.bindFrame(fn, argExprs);
    this.frames.push(frame);
    try {
      for (const stmt of fn.body) this.exec(stmt);
      return UNINIT;
    } catch (e) {
      if (e instanceof ReturnSignal) return e.value;
      throw e;
    } finally {
      this.frames.pop();
    }
  }

  private bindFrame(fn: FunctionDef, argExprs: Expr[]): Frame {
    const scalars = new Map<string, Cell>();
    const arrays = new Map<string, Map<string, Cell>>();
    const locals = new Set(fn.params);
    fn.params.forEach((param, idx) => {
      const argExpr = argExprs[idx];
      if (argExpr === undefined) { scalars.set(param, UNINIT); return; }
      if (argExpr.kind === 'var' && this.isArrayName(argExpr.name)) {
        arrays.set(param, this.getArray(argExpr.name));
      } else {
        scalars.set(param, this.eval(argExpr));
      }
    });
    return { scalars, arrays, locals };
  }

  private isArrayName(name: string): boolean {
    const f = this.currentFrame();
    if (f && f.locals.has(name)) return f.arrays.has(name) || !f.scalars.has(name);
    if (this.arrays.has(name)) return true;
    return !this.globals.has(name);
  }

  private evalBuiltin(name: string, args: Expr[]): Cell {
    switch (name) {
      case 'length': return this.biLength(args);
      case 'substr': return this.biSubstr(args);
      case 'index': return this.biIndex(args);
      case 'split': return this.biSplit(args);
      case 'sub': return this.biSub(args, false);
      case 'gsub': return this.biSub(args, true);
      case 'gensub': return this.biGensub(args);
      case 'match': return this.biMatch(args);
      case 'sprintf': return this.biSprintf(args);
      case 'toupper': return toStr(this.eval(args[0]), this.convfmt()).toUpperCase();
      case 'tolower': return toStr(this.eval(args[0]), this.convfmt()).toLowerCase();
      case 'sin': return Math.sin(toNum(this.eval(args[0])));
      case 'cos': return Math.cos(toNum(this.eval(args[0])));
      case 'atan2': return Math.atan2(toNum(this.eval(args[0])), toNum(this.eval(args[1])));
      case 'exp': return Math.exp(toNum(this.eval(args[0])));
      case 'log': return Math.log(toNum(this.eval(args[0])));
      case 'sqrt': return Math.sqrt(toNum(this.eval(args[0])));
      case 'int': return Math.trunc(toNum(this.eval(args[0])));
      case 'rand': return this.rand();
      case 'srand': return this.srand(args);
      case 'system': return 0;
      case 'close': return 0;
      case 'fflush': return 0;
      default: throw new AwkRuntimeError(`awk: unknown function ${name}`);
    }
  }

  private biLength(args: Expr[]): Cell {
    if (args.length === 0) return this.record.length;
    const a = args[0];
    if (a.kind === 'var' && this.isArrayName(a.name) && this.arrays.has(a.name)) {
      return this.getArray(a.name).size;
    }
    return toStr(this.eval(a), this.convfmt()).length;
  }

  private biSubstr(args: Expr[]): Cell {
    const s = toStr(this.eval(args[0]), this.convfmt());
    let m = Math.trunc(toNum(this.eval(args[1])));
    const hasLen = args.length > 2;
    let len = hasLen ? Math.trunc(toNum(this.eval(args[2]))) : s.length - m + 1;
    if (m < 1) { if (hasLen) len += (m - 1); m = 1; }
    if (len < 0) len = 0;
    return s.substr(m - 1, len);
  }

  private biIndex(args: Expr[]): Cell {
    const s = toStr(this.eval(args[0]), this.convfmt());
    const t = toStr(this.eval(args[1]), this.convfmt());
    return s.indexOf(t) + 1;
  }

  private biSplit(args: Expr[]): Cell {
    const s = toStr(this.eval(args[0]), this.convfmt());
    const arrName = (args[1] as { name: string }).name;
    const arr = this.getArray(arrName);
    arr.clear();
    const fs = args.length > 2
      ? (args[2].kind === 'regex' ? args[2].value : toStr(this.eval(args[2]), this.convfmt()))
      : toStr(this.globals.get('FS') ?? ' ', this.convfmt());
    const parts = this.splitByFs(s, fs);
    parts.forEach((p, i) => arr.set(String(i + 1), new StrNum(p)));
    return parts.length;
  }

  private biSub(args: Expr[], global: boolean): Cell {
    const ere = args[0].kind === 'regex' ? args[0].value : toStr(this.eval(args[0]), this.convfmt());
    const repl = toStr(this.eval(args[1]), this.convfmt());
    const targetExpr = args[2];
    const targetLv = targetExpr ? this.exprAsLValue(targetExpr) : { kind: 'field', index: { kind: 'num', value: 0 } } as LValue;
    const original = targetLv ? toStr(this.readLValue(targetLv), this.convfmt()) : this.record;
    let count = 0;
    const re = compileEre(ere, global ? 'g' : '');
    const result = original.replace(re, (matched) => {
      count++;
      return this.expandReplacement(repl, matched);
    });
    if (count > 0 && targetLv) this.writeLValue(targetLv, result);
    return count;
  }

  private biGensub(args: Expr[]): Cell {
    const ere = args[0].kind === 'regex' ? args[0].value : toStr(this.eval(args[0]), this.convfmt());
    const repl = toStr(this.eval(args[1]), this.convfmt());
    const h = toStr(this.eval(args[2]), this.convfmt());
    const target = args.length > 3 ? toStr(this.eval(args[3]), this.convfmt()) : this.record;
    const globalSub = h === 'g' || h === 'G';
    const which = parseInt(h, 10) || 1;
    let n = 0;
    const re = compileEre(ere, 'g');
    return target.replace(re, (...m) => {
      n++;
      if (globalSub || n === which) return this.expandGensub(repl, m);
      return m[0];
    });
  }

  private expandReplacement(repl: string, matched: string): string {
    let out = '';
    for (let i = 0; i < repl.length; i++) {
      if (repl[i] === '\\' && repl[i + 1] === '&') { out += '&'; i++; }
      else if (repl[i] === '\\' && repl[i + 1] === '\\') { out += '\\'; i++; }
      else if (repl[i] === '&') out += matched;
      else out += repl[i];
    }
    return out;
  }

  private expandGensub(repl: string, m: unknown[]): string {
    let out = '';
    for (let i = 0; i < repl.length; i++) {
      if (repl[i] === '\\') {
        const c = repl[i + 1];
        if (c >= '0' && c <= '9') { out += String(m[parseInt(c, 10)] ?? ''); i++; continue; }
        if (c === '&') { out += '&'; i++; continue; }
        if (c === '\\') { out += '\\'; i++; continue; }
        out += '\\';
      } else if (repl[i] === '&') { out += String(m[0]); }
      else out += repl[i];
    }
    return out;
  }

  private biMatch(args: Expr[]): Cell {
    const s = toStr(this.eval(args[0]), this.convfmt());
    const ere = args[1].kind === 'regex' ? args[1].value : toStr(this.eval(args[1]), this.convfmt());
    const m = compileEre(ere).exec(s);
    if (!m) { this.globals.set('RSTART', 0); this.globals.set('RLENGTH', -1); return 0; }
    this.globals.set('RSTART', m.index + 1);
    this.globals.set('RLENGTH', m[0].length);
    return m.index + 1;
  }

  private biSprintf(args: Expr[]): Cell {
    if (args.length === 0) return '';
    const fmt = toStr(this.eval(args[0]), this.convfmt());
    return applyFormat(fmt, args.slice(1).map(a => this.eval(a)));
  }

  private exprAsLValue(e: Expr): LValue | null {
    if (e.kind === 'var') return { kind: 'var', name: e.name };
    if (e.kind === 'field') return { kind: 'field', index: e.index };
    if (e.kind === 'index') return { kind: 'index', name: e.name, subscripts: e.subscripts };
    if (e.kind === 'grouping') return this.exprAsLValue(e.expr);
    return null;
  }

  private rand(): number {
    this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff;
    return this.seed / 0x7fffffff;
  }

  private srand(args: Expr[]): Cell {
    const prev = this.seed;
    this.seed = args.length ? Math.trunc(toNum(this.eval(args[0]))) : Date.now() & 0x7fffffff;
    return prev;
  }
}

export class AwkRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AwkRuntimeError';
  }
}

void isNumericCell;
