import { tokenizeAwk, AwkToken, AwkSyntaxError } from './AwkLexer';
import type {
  Program, Rule, Pattern, Stmt, Expr, LValue, FunctionDef, Redirect,
} from './AwkAst';

const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '^=', '**=']);
const VALUE_STARTERS = new Set(['number', 'string', 'ere', 'name', 'funcname', 'builtin']);

export class AwkParser {
  private toks: AwkToken[];
  private i = 0;

  constructor(src: string) {
    this.toks = tokenizeAwk(src);
  }

  static parse(src: string): Program {
    return new AwkParser(src).parseProgram();
  }

  private cur(): AwkToken { return this.toks[this.i]; }
  private peek(o = 1): AwkToken { return this.toks[Math.min(this.i + o, this.toks.length - 1)]; }
  private advance(): AwkToken { return this.toks[this.i++]; }
  private isOp(v: string, o = 0): boolean { const t = this.toks[this.i + o]; return !!t && t.type === 'op' && t.value === v; }
  private atEof(): boolean { return this.cur().type === 'eof'; }

  private eat(v: string): void {
    if (!this.isOp(v)) this.err(`expected '${v}' but got '${this.cur().value || 'EOF'}'`);
    this.advance();
  }
  private err(msg: string): never { throw new AwkSyntaxError(`awk: syntax error: ${msg}`); }

  private skipNewlines(): void {
    while (this.cur().type === 'newline' || this.isOp(';')) this.advance();
  }
  private skipOptNewlines(): void {
    while (this.cur().type === 'newline') this.advance();
  }
  private terminator(): void {
    while (this.cur().type === 'newline' || this.isOp(';')) this.advance();
  }

  parseProgram(): Program {
    const rules: Rule[] = [];
    const functions = new Map<string, FunctionDef>();
    this.skipNewlines();
    while (!this.atEof()) {
      if (this.isOp('function')) {
        const fn = this.parseFunction();
        functions.set(fn.name, fn);
      } else {
        rules.push(this.parseRule());
      }
      this.skipNewlines();
    }
    return { rules, functions };
  }

  private parseFunction(): FunctionDef {
    this.eat('function');
    const nameTok = this.advance();
    const name = nameTok.value;
    this.eat('(');
    const params: string[] = [];
    while (!this.isOp(')')) {
      params.push(this.advance().value);
      if (this.isOp(',')) this.advance();
    }
    this.eat(')');
    this.skipOptNewlines();
    const body = this.parseBlock();
    return { name, params, body };
  }

  private parseRule(): Rule {
    let pattern: Pattern = { type: 'always' };
    if (this.isOp('BEGIN')) { this.advance(); pattern = { type: 'begin' }; }
    else if (this.isOp('END')) { this.advance(); pattern = { type: 'end' }; }
    else if (!this.isOp('{')) {
      const e = this.parseExpr();
      if (this.isOp(',')) {
        this.advance();
        this.skipOptNewlines();
        const e2 = this.parseExpr();
        pattern = { type: 'range', start: e, end: e2 };
      } else {
        pattern = { type: 'expr', expr: e };
      }
    }

    let action: Stmt[] | null = null;
    if (this.isOp('{')) action = this.parseBlock();
    return { pattern, action };
  }

  private parseBlock(): Stmt[] {
    this.eat('{');
    const stmts: Stmt[] = [];
    this.skipNewlines();
    while (!this.isOp('}') && !this.atEof()) {
      stmts.push(this.parseStmt());
      this.terminator();
    }
    this.eat('}');
    return stmts;
  }

  private parseStmt(): Stmt {
    const t = this.cur();
    if (this.isOp('{')) return { kind: 'block', body: this.parseBlock() };
    if (this.isOp('if')) return this.parseIf();
    if (this.isOp('while')) return this.parseWhile();
    if (this.isOp('do')) return this.parseDoWhile();
    if (this.isOp('for')) return this.parseFor();
    if (this.isOp('print')) return this.parsePrint(false);
    if (this.isOp('printf')) return this.parsePrint(true);
    if (this.isOp('next')) { this.advance(); return { kind: 'next' }; }
    if (this.isOp('nextfile')) { this.advance(); return { kind: 'nextfile' }; }
    if (this.isOp('break')) { this.advance(); return { kind: 'break' }; }
    if (this.isOp('continue')) { this.advance(); return { kind: 'continue' }; }
    if (this.isOp('exit')) {
      this.advance();
      const code = this.startsExpr() ? this.parseExpr() : null;
      return { kind: 'exit', code };
    }
    if (this.isOp('return')) {
      this.advance();
      const value = this.startsExpr() ? this.parseExpr() : null;
      return { kind: 'return', value };
    }
    if (this.isOp('delete')) return this.parseDelete();
    if (this.isOp(';')) return { kind: 'block', body: [] };
    void t;
    return { kind: 'expr', expr: this.parseExpr() };
  }

  private startsExpr(): boolean {
    const t = this.cur();
    if (t.type === 'newline' || t.type === 'eof') return false;
    if (t.type === 'op') {
      return ['(', '$', '!', '-', '+', '++', '--'].includes(t.value);
    }
    return VALUE_STARTERS.has(t.type) || t.type === 'op' && t.value === 'getline';
  }

  private parseIf(): Stmt {
    this.eat('if'); this.eat('(');
    const cond = this.parseExpr();
    this.eat(')');
    this.skipOptNewlines();
    const then = this.parseStmt();
    let elseStmt: Stmt | null = null;
    const save = this.i;
    this.skipNewlines();
    if (this.isOp('else')) {
      this.advance();
      this.skipOptNewlines();
      elseStmt = this.parseStmt();
    } else {
      this.i = save;
    }
    return { kind: 'if', cond, then, else: elseStmt };
  }

  private parseWhile(): Stmt {
    this.eat('while'); this.eat('(');
    const cond = this.parseExpr();
    this.eat(')');
    this.skipOptNewlines();
    const body = this.parseStmt();
    return { kind: 'while', cond, body };
  }

  private parseDoWhile(): Stmt {
    this.eat('do');
    this.skipOptNewlines();
    const body = this.parseStmt();
    this.skipNewlines();
    this.eat('while'); this.eat('(');
    const cond = this.parseExpr();
    this.eat(')');
    return { kind: 'doWhile', body, cond };
  }

  private parseFor(): Stmt {
    this.eat('for'); this.eat('(');
    if ((this.cur().type === 'name') && this.isOp('in', 1)) {
      const varName = this.advance().value;
      this.advance();
      const array = this.advance().value;
      this.eat(')');
      this.skipOptNewlines();
      const body = this.parseStmt();
      return { kind: 'forIn', var: varName, array, body };
    }
    if (this.isOp('(')) {
      const save = this.i;
      try {
        this.advance();
        const v = this.advance();
        if (v.type === 'name' && this.isOp(')') && this.isOp('in', 1)) {
          this.advance(); this.advance();
          const array = this.advance().value;
          this.eat(')');
          this.skipOptNewlines();
          const body = this.parseStmt();
          return { kind: 'forIn', var: v.value, array, body };
        }
      } catch { /* fallthrough */ }
      this.i = save;
    }
    const init = this.isOp(';') ? null : { kind: 'expr', expr: this.parseExpr() } as Stmt;
    this.eat(';');
    const cond = this.isOp(';') ? null : this.parseExpr();
    this.eat(';');
    const update = this.isOp(')') ? null : { kind: 'expr', expr: this.parseExpr() } as Stmt;
    this.eat(')');
    this.skipOptNewlines();
    const body = this.parseStmt();
    return { kind: 'for', init, cond, update, body };
  }

  private parseDelete(): Stmt {
    this.eat('delete');
    const name = this.advance().value;
    let subscripts: Expr[] | null = null;
    if (this.isOp('[')) {
      this.advance();
      subscripts = [this.parseExpr()];
      while (this.isOp(',')) { this.advance(); subscripts.push(this.parseExpr()); }
      this.eat(']');
    }
    return { kind: 'delete', name, subscripts };
  }

  private parsePrint(isPrintf: boolean): Stmt {
    this.advance();
    const args: Expr[] = [];
    if (this.startsPrintArg()) {
      args.push(this.parseExpr(true));
      while (this.isOp(',')) {
        this.advance();
        this.skipOptNewlines();
        args.push(this.parseExpr(true));
      }
    }
    let output: Redirect | null = null;
    if (this.isOp('>')) { this.advance(); output = { type: 'truncate', target: this.parseExpr() }; }
    else if (this.isOp('>>')) { this.advance(); output = { type: 'append', target: this.parseExpr() }; }
    else if (this.isOp('|')) { this.advance(); output = { type: 'pipe', target: this.parseExpr() }; }

    const flat = args.length === 1 && args[0].kind === 'grouping' ? this.unwrapGroupList(args[0]) : args;
    return isPrintf ? { kind: 'printf', args: flat, output } : { kind: 'print', args: flat, output };
  }

  private unwrapGroupList(g: Expr): Expr[] {
    if (g.kind === 'grouping') return [g.expr];
    return [g];
  }

  private startsPrintArg(): boolean {
    const t = this.cur();
    if (t.type === 'newline' || t.type === 'eof') return false;
    if (this.isOp(';') || this.isOp('}') || this.isOp('>') || this.isOp('>>') || this.isOp('|')) return false;
    return true;
  }

  parseExpr(inPrint = false): Expr {
    return this.parseAssignment(inPrint);
  }

  private parseAssignment(inPrint: boolean): Expr {
    const left = this.parseTernary(inPrint);
    if (this.cur().type === 'op' && ASSIGN_OPS.has(this.cur().value)) {
      const lv = this.asLValue(left);
      if (lv) {
        const op = this.advance().value;
        const value = this.parseAssignment(inPrint);
        return { kind: 'assign', op, target: lv, value };
      }
    }
    return left;
  }

  private parseTernary(inPrint: boolean): Expr {
    const cond = this.parseOr(inPrint);
    if (this.isOp('?')) {
      this.advance();
      this.skipOptNewlines();
      const then = this.parseAssignment(inPrint);
      this.eat(':');
      this.skipOptNewlines();
      const elseExpr = this.parseAssignment(inPrint);
      return { kind: 'ternary', cond, then, else: elseExpr };
    }
    return cond;
  }

  private parseOr(inPrint: boolean): Expr {
    let left = this.parseAnd(inPrint);
    while (this.isOp('||')) {
      this.advance();
      this.skipOptNewlines();
      left = { kind: 'logical', op: 'or', left, right: this.parseAnd(inPrint) };
    }
    return left;
  }

  private parseAnd(inPrint: boolean): Expr {
    let left = this.parseIn(inPrint);
    while (this.isOp('&&')) {
      this.advance();
      this.skipOptNewlines();
      left = { kind: 'logical', op: 'and', left, right: this.parseIn(inPrint) };
    }
    return left;
  }

  private parseIn(inPrint: boolean): Expr {
    let left = this.parseMatch(inPrint);
    while (this.isOp('in')) {
      this.advance();
      const array = this.advance().value;
      left = { kind: 'in', subscripts: [left], array };
    }
    return left;
  }

  private parseMatch(inPrint: boolean): Expr {
    let left = this.parseComparison(inPrint);
    while (this.isOp('~') || this.isOp('!~')) {
      const negated = this.advance().value === '!~';
      const right = this.parseComparison(inPrint);
      left = { kind: 'match', negated, left, right };
    }
    return left;
  }

  private parseComparison(inPrint: boolean): Expr {
    const left = this.parseConcat(inPrint);
    const ops = inPrint ? ['<', '<=', '==', '!=', '>='] : ['<', '<=', '==', '!=', '>=', '>'];
    if (this.cur().type === 'op' && ops.includes(this.cur().value)) {
      const op = this.advance().value;
      const right = this.parseConcat(inPrint);
      return { kind: 'binary', op, left, right };
    }
    return left;
  }

  private parseConcat(inPrint: boolean): Expr {
    const left = this.parseAdditive(inPrint);
    const parts: Expr[] = [left];
    while (this.canStartConcat()) {
      parts.push(this.parseAdditive(inPrint));
    }
    if (parts.length === 1) return left;
    return { kind: 'concat', parts };
  }

  private canStartConcat(): boolean {
    const t = this.cur();
    if (t.type === 'number' || t.type === 'string' || t.type === 'ere'
      || t.type === 'name' || t.type === 'funcname' || t.type === 'builtin') return true;
    if (t.type === 'op' && (t.value === '$' || t.value === '(' || t.value === '!'
      || t.value === '++' || t.value === '--')) return true;
    return false;
  }

  private parseAdditive(inPrint: boolean): Expr {
    let left = this.parseMultiplicative(inPrint);
    while (this.isOp('+') || this.isOp('-')) {
      const op = this.advance().value;
      left = { kind: 'binary', op, left, right: this.parseMultiplicative(inPrint) };
    }
    return left;
  }

  private parseMultiplicative(inPrint: boolean): Expr {
    let left = this.parseUnary(inPrint);
    while (this.isOp('*') || this.isOp('/') || this.isOp('%')) {
      const op = this.advance().value;
      left = { kind: 'binary', op, left, right: this.parseUnary(inPrint) };
    }
    return left;
  }

  private parseUnary(inPrint: boolean): Expr {
    if (this.isOp('!')) { this.advance(); return { kind: 'unary', op: '!', operand: this.parseUnary(inPrint) }; }
    if (this.isOp('-')) { this.advance(); return { kind: 'unary', op: '-', operand: this.parseUnary(inPrint) }; }
    if (this.isOp('+')) { this.advance(); return { kind: 'unary', op: '+', operand: this.parseUnary(inPrint) }; }
    return this.parsePower(inPrint);
  }

  private parsePower(inPrint: boolean): Expr {
    const base = this.parsePostfix(inPrint);
    if (this.isOp('^') || this.isOp('**')) {
      this.advance();
      const exp = this.parseUnary(inPrint);
      return { kind: 'binary', op: '^', left: base, right: exp };
    }
    return base;
  }

  private parsePostfix(inPrint: boolean): Expr {
    if (this.isOp('++') || this.isOp('--')) {
      const op = this.advance().value;
      const target = this.asLValue(this.parsePostfix(inPrint));
      if (!target) this.err('invalid increment target');
      return { kind: 'preIncr', op, target };
    }
    let expr = this.parsePrimary(inPrint);
    while (this.isOp('++') || this.isOp('--')) {
      const lv = this.asLValue(expr);
      if (!lv) break;
      const op = this.advance().value;
      expr = { kind: 'postIncr', op, target: lv };
    }
    return expr;
  }

  private parsePrimary(inPrint: boolean): Expr {
    const t = this.cur();

    if (this.isOp('$')) {
      this.advance();
      const index = this.parsePostfix(inPrint);
      return { kind: 'field', index };
    }
    if (this.isOp('(')) {
      this.advance();
      const first = this.parseExpr();
      if (this.isOp(',')) {
        const subs = [first];
        while (this.isOp(',')) { this.advance(); subs.push(this.parseExpr()); }
        this.eat(')');
        if (this.isOp('in')) {
          this.advance();
          const array = this.advance().value;
          return { kind: 'in', subscripts: subs, array };
        }
        return { kind: 'grouping', expr: first };
      }
      this.eat(')');
      return { kind: 'grouping', expr: first };
    }
    if (t.type === 'number') { this.advance(); return { kind: 'num', value: parseNumber(t.value) }; }
    if (t.type === 'string') { this.advance(); return { kind: 'str', value: decodeString(t.value) }; }
    if (t.type === 'ere') { this.advance(); return { kind: 'regex', value: t.value }; }
    if (this.isOp('getline')) return this.parseGetline(inPrint);

    if (t.type === 'builtin') {
      this.advance();
      const args: Expr[] = [];
      if (this.isOp('(')) {
        this.advance();
        if (!this.isOp(')')) {
          args.push(this.parseExpr());
          while (this.isOp(',')) { this.advance(); args.push(this.parseExpr()); }
        }
        this.eat(')');
      }
      return { kind: 'builtin', name: t.value, args };
    }
    if (t.type === 'funcname') {
      this.advance();
      this.eat('(');
      const args: Expr[] = [];
      if (!this.isOp(')')) {
        args.push(this.parseExpr());
        while (this.isOp(',')) { this.advance(); args.push(this.parseExpr()); }
      }
      this.eat(')');
      return { kind: 'call', name: t.value, args };
    }
    if (t.type === 'name') {
      this.advance();
      if (this.isOp('[')) {
        this.advance();
        const subscripts = [this.parseExpr()];
        while (this.isOp(',')) { this.advance(); subscripts.push(this.parseExpr()); }
        this.eat(']');
        return { kind: 'index', name: t.value, subscripts };
      }
      return { kind: 'var', name: t.value };
    }
    this.err(`unexpected token '${t.value || t.type}'`);
  }

  private parseGetline(inPrint: boolean): Expr {
    this.advance();
    let into: LValue | null = null;
    if (this.cur().type === 'name' || this.isOp('$')) {
      const lv = this.asLValue(this.parsePrimary(inPrint));
      if (lv) into = lv;
    }
    let source: { type: 'file' | 'cmd'; expr: Expr } | null = null;
    if (this.isOp('<')) {
      this.advance();
      source = { type: 'file', expr: this.parseConcat(inPrint) };
    }
    return { kind: 'getline', into, source };
  }

  private asLValue(e: Expr): LValue | null {
    if (e.kind === 'var') return { kind: 'var', name: e.name };
    if (e.kind === 'field') return { kind: 'field', index: e.index };
    if (e.kind === 'index') return { kind: 'index', name: e.name, subscripts: e.subscripts };
    if (e.kind === 'grouping') return this.asLValue(e.expr);
    return null;
  }
}

function parseNumber(s: string): number {
  if (/^0[xX]/.test(s)) return parseInt(s, 16);
  return parseFloat(s);
}

function decodeString(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') {
      const c = s[i + 1];
      i++;
      switch (c) {
        case 'n': out += '\n'; break;
        case 't': out += '\t'; break;
        case 'r': out += '\r'; break;
        case '\\': out += '\\'; break;
        case '"': out += '"'; break;
        case '/': out += '/'; break;
        case 'a': out += '\x07'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'v': out += '\v'; break;
        default:
          if (c >= '0' && c <= '7') {
            let oct = c;
            while (oct.length < 3 && s[i + 1] >= '0' && s[i + 1] <= '7') { oct += s[++i]; }
            out += String.fromCharCode(parseInt(oct, 8));
          } else {
            out += '\\' + (c ?? '');
          }
      }
    } else {
      out += s[i];
    }
  }
  return out;
}

export { AwkSyntaxError };
