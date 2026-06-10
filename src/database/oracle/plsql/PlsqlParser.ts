import { tokenizePlsql, PlsqlToken, PlsqlLexParseError } from './PlsqlLexer';
import type {
  Block, Stmt, Expr, Declaration, TypeRef, CallArg, ExceptionHandler,
  AssignTarget, ParamDecl, SubprogramDecl, VarDecl, CursorDecl,
} from './PlsqlAst';

const STMT_KEYWORDS = new Set([
  'IF', 'CASE', 'LOOP', 'WHILE', 'FOR', 'EXIT', 'CONTINUE', 'GOTO', 'RETURN',
  'RAISE', 'NULL', 'BEGIN', 'DECLARE', 'OPEN', 'FETCH', 'CLOSE', 'END',
  'ELSIF', 'ELSE', 'WHEN', 'THEN', 'EXCEPTION',
]);

export class PlsqlParser {
  private toks: PlsqlToken[];
  private i = 0;
  private source: string;

  constructor(source: string) {
    this.source = source;
    this.toks = tokenizePlsql(source);
  }

  static parse(source: string): Block {
    return new PlsqlParser(source).parseProgram();
  }

  /**
   * Parse a standalone PL/SQL expression (e.g. a collection subscript
   * appearing inside embedded SQL). Throws PlsqlLexParseError on garbage.
   */
  static parseExpression(source: string): Expr {
    const p = new PlsqlParser(source);
    const e = p.parseExpr();
    if (!p.atEof()) p.err(`unexpected '${p.cur().value}' after expression`);
    return e;
  }

  private peek(o = 0): PlsqlToken { return this.toks[Math.min(this.i + o, this.toks.length - 1)]; }
  private cur(): PlsqlToken { return this.toks[this.i]; }
  private atEof(): boolean { return this.cur().type === 'eof'; }
  private advance(): PlsqlToken { return this.toks[this.i++]; }

  private isKw(kw: string, o = 0): boolean {
    const t = this.peek(o);
    return t.type === 'ident' && t.upper === kw;
  }
  private isOp(op: string, o = 0): boolean {
    const t = this.peek(o);
    return t.type === 'op' && t.value === op;
  }
  private eatKw(kw: string): void {
    if (!this.isKw(kw)) this.err(`expected ${kw} but found '${this.cur().value || 'end-of-input'}'`);
    this.advance();
  }
  private eatOp(op: string): void {
    if (!this.isOp(op)) this.err(`expected '${op}' but found '${this.cur().value || 'end-of-input'}'`);
    this.advance();
  }
  private err(msg: string): never {
    throw new PlsqlLexParseError(`PLS-00103: ${msg}`, this.cur().line);
  }

  parseProgram(): Block {
    const block = this.parseBlock();
    if (this.isOp(';')) this.advance();
    if (!this.atEof()) this.err(`unexpected trailing input '${this.cur().value}'`);
    return block;
  }

  private parseBlock(): Block {
    const declarations: Declaration[] = [];
    if (this.isKw('DECLARE')) {
      this.advance();
      this.parseDeclarations(declarations);
    }
    this.eatKw('BEGIN');
    const body = this.parseStatementsUntil(['END', 'EXCEPTION']);
    const handlers: ExceptionHandler[] = [];
    if (this.isKw('EXCEPTION')) {
      this.advance();
      this.parseHandlers(handlers);
    }
    this.eatKw('END');
    if (this.cur().type === 'ident') this.advance();
    return { kind: 'block', declarations, body, handlers };
  }

  private parseDeclarations(out: Declaration[]): void {
    while (!this.isKw('BEGIN') && !this.atEof()) {
      out.push(this.parseDeclaration());
    }
  }

  private parseDeclaration(): Declaration {
    if (this.isKw('PRAGMA')) {
      this.advance();
      const pragmaName = this.advance().upper;
      if (pragmaName === 'EXCEPTION_INIT') {
        this.eatOp('(');
        const name = this.advance().upper;
        this.eatOp(',');
        let sign = 1;
        if (this.isOp('-')) { this.advance(); sign = -1; }
        const code = sign * parseInt(this.advance().value, 10);
        this.eatOp(')');
        this.eatOp(';');
        return { kind: 'pragma_exception_init', exceptionName: name, code };
      }
      // AUTONOMOUS_TRANSACTION, SERIALLY_REUSABLE, UDF, INLINE(...),
      // RESTRICT_REFERENCES(...) — compile-time directives with no runtime
      // effect here; consume any argument list through the terminator.
      while (!this.isOp(';') && !this.atEof()) this.advance();
      this.eatOp(';');
      return { kind: 'pragma', name: pragmaName };
    }

    if (this.isKw('CURSOR')) return this.parseCursorDecl();

    if (this.isKw('TYPE')) return this.parseTypeDecl();

    if (this.isKw('PROCEDURE') || this.isKw('FUNCTION')) return this.parseSubprogram();

    const name = this.advance().value;
    if (this.isKw('EXCEPTION')) {
      this.advance();
      this.eatOp(';');
      return { kind: 'exception', name: name.toUpperCase() };
    }

    let constant = false;
    if (this.isKw('CONSTANT')) { this.advance(); constant = true; }
    const type = this.parseTypeRef();
    let notNull = false;
    if (this.isKw('NOT') && this.isKw('NULL', 1)) { this.advance(); this.advance(); notNull = true; }
    let init: Expr | null = null;
    if (this.isOp(':=') || this.isKw('DEFAULT')) {
      this.advance();
      init = this.parseExpr();
    }
    this.eatOp(';');
    const decl: VarDecl = { kind: 'var', name: name.toUpperCase(), type, constant, notNull, init };
    return decl;
  }

  private parseCursorDecl(): CursorDecl {
    this.eatKw('CURSOR');
    const name = this.advance().upper;
    const params: { name: string; type: TypeRef }[] = [];
    if (this.isOp('(')) {
      this.advance();
      while (!this.isOp(')')) {
        const pn = this.advance().upper;
        if (this.isKw('IN')) this.advance();
        const pt = this.parseTypeRef();
        if (this.isOp(':=') || this.isKw('DEFAULT')) { this.advance(); this.parseExpr(); }
        params.push({ name: pn, type: pt });
        if (this.isOp(',')) this.advance();
      }
      this.eatOp(')');
    }
    if (this.isKw('RETURN')) { this.advance(); this.parseTypeRef(); }
    this.eatKw('IS');
    const query = this.captureSqlText();
    this.eatOp(';');
    return { kind: 'cursor', name, params, query };
  }

  private parseTypeDecl(): Declaration {
    this.eatKw('TYPE');
    const name = this.advance().upper;
    this.eatKw('IS');
    if (this.isKw('RECORD')) {
      this.advance();
      this.eatOp('(');
      const fields: { name: string; type: TypeRef; init: Expr | null }[] = [];
      while (!this.isOp(')')) {
        const fn = this.advance().upper;
        const ft = this.parseTypeRef();
        if (this.isKw('NOT') && this.isKw('NULL', 1)) { this.advance(); this.advance(); }
        let fi: Expr | null = null;
        if (this.isOp(':=') || this.isKw('DEFAULT')) { this.advance(); fi = this.parseExpr(); }
        fields.push({ name: fn, type: ft, init: fi });
        if (this.isOp(',')) this.advance();
      }
      this.eatOp(')');
      this.eatOp(';');
      return { kind: 'type', name, def: { form: 'record', fields } };
    }
    if (this.isKw('TABLE')) {
      this.advance();
      this.eatKw('OF');
      const element = this.parseTypeRef();
      if (this.isKw('NOT') && this.isKw('NULL', 1)) { this.advance(); this.advance(); }
      let indexed = false;
      if (this.isKw('INDEX')) {
        this.advance(); this.eatKw('BY'); this.parseTypeRef(); indexed = true;
      }
      this.eatOp(';');
      return { kind: 'type', name, def: { form: 'table', element, indexed } };
    }
    if (this.isKw('VARRAY') || this.isKw('VARYING')) {
      if (this.isKw('VARYING')) { this.advance(); this.eatKw('ARRAY'); }
      else this.advance();
      this.eatOp('(');
      const limit = parseInt(this.advance().value, 10);
      this.eatOp(')');
      this.eatKw('OF');
      const element = this.parseTypeRef();
      if (this.isKw('NOT') && this.isKw('NULL', 1)) { this.advance(); this.advance(); }
      this.eatOp(';');
      return { kind: 'type', name, def: { form: 'varray', element, limit } };
    }
    if (this.isKw('REF')) {
      this.advance(); this.eatKw('CURSOR');
      if (this.isKw('RETURN')) { this.advance(); this.parseTypeRef(); }
      this.eatOp(';');
      return { kind: 'type', name, def: { form: 'record', fields: [] } };
    }
    this.err(`unsupported TYPE definition for ${name}`);
  }

  private parseSubprogram(): SubprogramDecl {
    const isFunction = this.cur().upper === 'FUNCTION';
    this.advance();
    const name = this.advance().upper;
    const params = this.parseParamList();
    let returnType: TypeRef | null = null;
    if (isFunction) { this.eatKw('RETURN'); returnType = this.parseTypeRef(); }
    if (this.isKw('IS') || this.isKw('AS')) {
      this.advance();
      const declarations: Declaration[] = [];
      while (!this.isKw('BEGIN') && !this.atEof()) declarations.push(this.parseDeclaration());
      this.eatKw('BEGIN');
      const body = this.parseStatementsUntil(['END', 'EXCEPTION']);
      const handlers: ExceptionHandler[] = [];
      if (this.isKw('EXCEPTION')) { this.advance(); this.parseHandlers(handlers); }
      this.eatKw('END');
      if (this.cur().type === 'ident') this.advance();
      this.eatOp(';');
      return { kind: 'subprogram', isFunction, name, params, returnType, block: { kind: 'block', declarations, body, handlers } };
    }
    this.eatOp(';');
    return { kind: 'subprogram', isFunction, name, params, returnType, block: null };
  }

  private parseParamList(): ParamDecl[] {
    const params: ParamDecl[] = [];
    if (!this.isOp('(')) return params;
    this.advance();
    while (!this.isOp(')')) {
      const pn = this.advance().upper;
      let mode: 'IN' | 'OUT' | 'IN OUT' = 'IN';
      if (this.isKw('IN') && this.isKw('OUT', 1)) { this.advance(); this.advance(); mode = 'IN OUT'; }
      else if (this.isKw('IN')) { this.advance(); mode = 'IN'; }
      else if (this.isKw('OUT')) { this.advance(); mode = 'OUT'; }
      if (this.isKw('NOCOPY')) this.advance();
      const type = this.parseTypeRef();
      let init: Expr | null = null;
      if (this.isOp(':=') || this.isKw('DEFAULT')) { this.advance(); init = this.parseExpr(); }
      params.push({ name: pn, mode, type, init });
      if (this.isOp(',')) this.advance();
    }
    this.eatOp(')');
    return params;
  }

  private parseTypeRef(): TypeRef {
    let name = this.advance().value;
    while (this.isOp('.') && this.peek(1).type === 'ident' && !(this.peek(2).type === 'op' && this.peek(2).value === '%')) {
      this.advance();
      name += '.' + this.advance().value;
    }
    if (this.isOp('.')) {
      this.advance();
      name += '.' + this.advance().value;
    }
    if (this.isOp('%')) {
      this.advance();
      const kindTok = this.advance().upper;
      const kind = kindTok === 'ROWTYPE' ? 'ROWTYPE' : 'TYPE';
      return { name: kind === 'ROWTYPE' ? 'ROWTYPE' : 'TYPE', args: [], anchored: { target: name.toUpperCase(), kind } };
    }
    const args: number[] = [];
    if (this.isOp('(')) {
      this.advance();
      while (!this.isOp(')')) {
        if (this.cur().type === 'number') args.push(parseInt(this.advance().value, 10));
        else this.advance();
        if (this.isOp(',')) this.advance();
      }
      this.eatOp(')');
    }
    if (this.isKw('CHAR') || this.isKw('BYTE')) this.advance();
    if (this.isKw('WITH')) {
      while (!this.isOp(';') && !this.isOp(':=') && !this.isKw('DEFAULT') && !this.atEof()) this.advance();
    }
    return { name: name.toUpperCase(), args };
  }

  private parseHandlers(out: ExceptionHandler[]): void {
    while (this.isKw('WHEN')) {
      this.advance();
      const names: string[] = [];
      let others = false;
      if (this.isKw('OTHERS')) { this.advance(); others = true; }
      else {
        names.push(this.advance().upper);
        while (this.isKw('OR')) { this.advance(); names.push(this.advance().upper); }
      }
      this.eatKw('THEN');
      const body = this.parseStatementsUntil(['END', 'WHEN', 'EXCEPTION']);
      out.push({ names, others, body });
    }
  }

  private parseStatementsUntil(terminators: string[]): Stmt[] {
    const stmts: Stmt[] = [];
    while (!this.atEof()) {
      const t = this.cur();
      if (t.type === 'ident' && terminators.includes(t.upper)) break;
      if (t.type === 'eof') break;
      const s = this.parseStatement();
      if (s) stmts.push(s);
    }
    return stmts;
  }

  private parseStatement(): Stmt | null {
    if (this.isOp('<<')) {
      this.advance();
      const label = this.advance().upper;
      this.eatOp('>>');
      const next = this.parseLoopWithLabel(label);
      if (next) return next;
      return { kind: 'labelMark', label };
    }

    const t = this.cur();
    if (t.type === 'ident') {
      switch (t.upper) {
        case 'NULL': this.advance(); this.eatOp(';'); return { kind: 'null' };
        case 'BEGIN': case 'DECLARE': { const b = this.parseBlock(); this.eatOp(';'); return b; }
        case 'IF': return this.parseIf();
        case 'CASE': return this.parseCaseStatement();
        case 'LOOP': return this.parseLoopWithLabel(null)!;
        case 'WHILE': return this.parseWhile(null);
        case 'FOR': return this.parseFor(null);
        case 'FORALL': return this.parseForall();
        case 'EXIT': return this.parseExit();
        case 'CONTINUE': return this.parseContinue();
        case 'GOTO': { this.advance(); const l = this.advance().upper; this.eatOp(';'); return { kind: 'goto', label: l }; }
        case 'RETURN': { this.advance(); let v: Expr | null = null; if (!this.isOp(';')) v = this.parseExpr(); this.eatOp(';'); return { kind: 'return', value: v }; }
        case 'RAISE': return this.parseRaise();
        case 'OPEN': return this.parseOpen();
        case 'FETCH': return this.parseFetch();
        case 'CLOSE': { this.advance(); const c = this.parseDottedName(); this.eatOp(';'); return { kind: 'close', cursorName: c }; }
        case 'SELECT': return this.parseSelectInto();
        case 'INSERT': case 'UPDATE': case 'DELETE': case 'MERGE':
        case 'COMMIT': case 'ROLLBACK': case 'SAVEPOINT': case 'SET':
        case 'LOCK': return this.parseEmbeddedSql();
        case 'EXECUTE': return this.parseExecuteImmediate();
        case 'PIPE': { this.advance(); this.eatKw('ROW'); this.eatOp('('); const e = this.parseExpr(); this.eatOp(')'); this.eatOp(';'); return { kind: 'pipeRow', value: e }; }
      }
    }
    return this.parseAssignOrCall();
  }

  private parseLoopWithLabel(label: string | null): Stmt | null {
    if (this.isKw('LOOP')) {
      this.advance();
      const body = this.parseStatementsUntil(['END']);
      this.eatKw('END'); this.eatKw('LOOP');
      if (this.cur().type === 'ident') this.advance();
      this.eatOp(';');
      return { kind: 'loop', label, body };
    }
    if (this.isKw('WHILE')) return this.parseWhile(label);
    if (this.isKw('FOR')) return this.parseFor(label);
    return null;
  }

  private parseWhile(label: string | null): Stmt {
    this.eatKw('WHILE');
    const cond = this.parseExpr();
    this.eatKw('LOOP');
    const body = this.parseStatementsUntil(['END']);
    this.eatKw('END'); this.eatKw('LOOP');
    if (this.cur().type === 'ident') this.advance();
    this.eatOp(';');
    return { kind: 'while', label, cond, body };
  }

  private parseFor(label: string | null): Stmt {
    this.eatKw('FOR');
    const varName = this.advance().upper;
    this.eatKw('IN');

    if (this.isOp('(')) {
      this.advance();
      const query = this.captureSqlText();
      this.eatOp(')');
      this.eatKw('LOOP');
      const body = this.parseStatementsUntil(['END']);
      this.eatKw('END'); this.eatKw('LOOP');
      if (this.cur().type === 'ident') this.advance();
      this.eatOp(';');
      return { kind: 'forCursor', label, varName, cursorName: null, args: [], query, body };
    }

    let reverse = false;
    if (this.isKw('REVERSE')) { this.advance(); reverse = true; }

    const save = this.i;
    const isRange = this.tryDetectRange();
    if (isRange) {
      this.i = save;
      const low = this.parseExpr();
      this.eatOp('..');
      const high = this.parseExpr();
      this.eatKw('LOOP');
      const body = this.parseStatementsUntil(['END']);
      this.eatKw('END'); this.eatKw('LOOP');
      if (this.cur().type === 'ident') this.advance();
      this.eatOp(';');
      return { kind: 'forNum', label, varName, reverse, low, high, body };
    }

    this.i = save;
    const cursorName = this.parseDottedName();
    const args: CallArg[] = [];
    if (this.isOp('(')) {
      this.advance();
      this.parseCallArgs(args);
      this.eatOp(')');
    }
    this.eatKw('LOOP');
    const body = this.parseStatementsUntil(['END']);
    this.eatKw('END'); this.eatKw('LOOP');
    if (this.cur().type === 'ident') this.advance();
    this.eatOp(';');
    return { kind: 'forCursor', label, varName, cursorName, args, query: null, body };
  }

  /**
   * FORALL index IN low..high [SAVE EXCEPTIONS] dml_statement
   *
   * Real Oracle batches the binds into one engine round-trip; the
   * simulator has no bulk-bind engine, so FORALL desugars to a numeric
   * FOR over the single DML statement — row-level semantics, and thus
   * results, are identical.
   */
  private parseForall(): Stmt {
    this.eatKw('FORALL');
    const varName = this.advance().upper;
    this.eatKw('IN');
    const low = this.parseExpr();
    this.eatOp('..');
    const high = this.parseExpr();
    if (this.isKw('SAVE')) { this.advance(); this.eatKw('EXCEPTIONS'); }
    const dml = this.parseStatement();
    return { kind: 'forNum', label: null, varName, reverse: false, low, high, body: dml ? [dml] : [] };
  }

  private tryDetectRange(): boolean {
    let depth = 0;
    for (let k = this.i; k < this.toks.length; k++) {
      const tk = this.toks[k];
      if (tk.type === 'op' && tk.value === '(') depth++;
      else if (tk.type === 'op' && tk.value === ')') depth--;
      else if (depth === 0 && tk.type === 'op' && tk.value === '..') return true;
      else if (depth === 0 && tk.type === 'ident' && tk.upper === 'LOOP') return false;
      else if (tk.type === 'eof') return false;
    }
    return false;
  }

  private parseExit(): Stmt {
    this.eatKw('EXIT');
    let label: string | null = null;
    if (this.cur().type === 'ident' && !this.isKw('WHEN') && this.cur().upper !== 'NULL') {
      label = this.advance().upper;
    }
    let when: Expr | null = null;
    if (this.isKw('WHEN')) { this.advance(); when = this.parseExpr(); }
    this.eatOp(';');
    return { kind: 'exit', label, when };
  }

  private parseContinue(): Stmt {
    this.eatKw('CONTINUE');
    let label: string | null = null;
    if (this.cur().type === 'ident' && !this.isKw('WHEN')) label = this.advance().upper;
    let when: Expr | null = null;
    if (this.isKw('WHEN')) { this.advance(); when = this.parseExpr(); }
    this.eatOp(';');
    return { kind: 'continue', label, when };
  }

  private parseRaise(): Stmt {
    this.eatKw('RAISE');
    if (this.isOp(';')) { this.advance(); return { kind: 'raise', name: null }; }
    const name = this.parseDottedName();
    this.eatOp(';');
    return { kind: 'raise', name };
  }

  private parseIf(): Stmt {
    this.eatKw('IF');
    const branches: { cond: Expr; body: Stmt[] }[] = [];
    const cond = this.parseExpr();
    this.eatKw('THEN');
    branches.push({ cond, body: this.parseStatementsUntil(['ELSIF', 'ELSE', 'END']) });
    while (this.isKw('ELSIF')) {
      this.advance();
      const c = this.parseExpr();
      this.eatKw('THEN');
      branches.push({ cond: c, body: this.parseStatementsUntil(['ELSIF', 'ELSE', 'END']) });
    }
    let elseBody: Stmt[] | null = null;
    if (this.isKw('ELSE')) { this.advance(); elseBody = this.parseStatementsUntil(['END']); }
    this.eatKw('END'); this.eatKw('IF'); this.eatOp(';');
    return { kind: 'if', branches, elseBody };
  }

  private parseCaseStatement(): Stmt {
    this.eatKw('CASE');
    let selector: Expr | null = null;
    if (!this.isKw('WHEN')) selector = this.parseExpr();
    const whens: { match: Expr; body: Stmt[] }[] = [];
    while (this.isKw('WHEN')) {
      this.advance();
      const match = this.parseExpr();
      this.eatKw('THEN');
      whens.push({ match, body: this.parseStatementsUntil(['WHEN', 'ELSE', 'END']) });
    }
    let elseBody: Stmt[] | null = null;
    if (this.isKw('ELSE')) { this.advance(); elseBody = this.parseStatementsUntil(['END']); }
    this.eatKw('END'); this.eatKw('CASE'); this.eatOp(';');
    return { kind: 'case', selector, whens, elseBody };
  }

  private parseOpen(): Stmt {
    this.eatKw('OPEN');
    const name = this.parseDottedName();
    if (this.isKw('FOR')) {
      this.advance();
      const query = this.captureSqlText();
      this.eatOp(';');
      return { kind: 'openFor', varName: name, query };
    }
    const args: CallArg[] = [];
    if (this.isOp('(')) { this.advance(); this.parseCallArgs(args); this.eatOp(')'); }
    this.eatOp(';');
    return { kind: 'open', cursorName: name, args };
  }

  private parseFetch(): Stmt {
    this.eatKw('FETCH');
    const cursorName = this.parseDottedName();
    let bulk = false;
    let limit: Expr | null = null;
    if (this.isKw('BULK')) { this.advance(); this.eatKw('COLLECT'); bulk = true; }
    this.eatKw('INTO');
    const intoTargets: AssignTarget[] = [];
    intoTargets.push(this.parseAssignTarget());
    while (this.isOp(',')) { this.advance(); intoTargets.push(this.parseAssignTarget()); }
    if (this.isKw('LIMIT')) { this.advance(); limit = this.parseExpr(); }
    this.eatOp(';');
    return { kind: 'fetch', cursorName, intoTargets, bulk, limit };
  }

  private parseSelectInto(): Stmt {
    const start = this.cur().pos;
    const intoIdx = this.scanForInto();
    if (intoIdx < 0) {
      const sql = this.captureSqlText();
      this.eatOp(';');
      return { kind: 'sql', sql };
    }
    let bulk = false;
    let listEndIdx = intoIdx;
    if (this.toks[intoIdx - 1] && this.toks[intoIdx - 1].upper === 'COLLECT'
      && this.toks[intoIdx - 2] && this.toks[intoIdx - 2].upper === 'BULK') {
      bulk = true;
      listEndIdx = intoIdx - 2;
    }
    const beforeIntoEnd = this.toks[listEndIdx].pos;
    this.i = intoIdx + 1;
    const intoTargets: AssignTarget[] = [];
    intoTargets.push(this.parseAssignTarget());
    while (this.isOp(',')) { this.advance(); intoTargets.push(this.parseAssignTarget()); }
    if (!this.isKw('FROM')) this.err('expected FROM after INTO list');
    const fromStart = this.cur().pos;
    const sqlBefore = this.source.substring(start, beforeIntoEnd);
    this.captureSqlTailFrom();
    const end = this.cur().pos;
    this.eatOp(';');
    const sql = sqlBefore + ' ' + this.source.substring(fromStart, end);
    return { kind: 'selectInto', sql: sql.trim(), intoTargets, bulk };
  }

  private scanForInto(): number {
    let depth = 0;
    for (let k = this.i; k < this.toks.length; k++) {
      const tk = this.toks[k];
      if (tk.type === 'op' && tk.value === '(') depth++;
      else if (tk.type === 'op' && tk.value === ')') depth--;
      else if (depth === 0 && tk.type === 'ident' && tk.upper === 'INTO') return k;
      else if (depth === 0 && tk.type === 'ident' && tk.upper === 'FROM') return -1;
      else if (depth === 0 && tk.type === 'op' && tk.value === ';') return -1;
      else if (tk.type === 'eof') return -1;
    }
    return -1;
  }

  private captureSqlTailFrom(): void {
    let depth = 0;
    while (!this.atEof()) {
      if (this.isOp('(')) depth++;
      else if (this.isOp(')')) depth--;
      else if (depth === 0 && this.isOp(';')) return;
      this.advance();
    }
  }

  private parseEmbeddedSql(): Stmt {
    const sql = this.captureSqlText();
    this.eatOp(';');
    return { kind: 'sql', sql };
  }

  private captureSqlText(): string {
    const start = this.cur().pos;
    let depth = 0;
    while (!this.atEof()) {
      if (this.isOp('(')) depth++;
      else if (this.isOp(')')) { if (depth === 0) break; depth--; }
      else if (depth === 0 && this.isOp(';')) break;
      this.advance();
    }
    const end = this.cur().pos;
    return this.source.substring(start, end).trim();
  }

  private parseExecuteImmediate(): Stmt {
    this.eatKw('EXECUTE');
    this.eatKw('IMMEDIATE');
    const sqlExpr = this.parseExpr();
    const intoTargets: AssignTarget[] = [];
    let bulkInto = false;
    const using: { mode: string; expr: Expr }[] = [];

    while (this.isKw('INTO') || this.isKw('BULK') || this.isKw('USING')) {
      if (this.isKw('BULK')) { this.advance(); this.eatKw('COLLECT'); this.eatKw('INTO'); bulkInto = true; intoTargets.push(this.parseAssignTarget()); while (this.isOp(',')) { this.advance(); intoTargets.push(this.parseAssignTarget()); } }
      else if (this.isKw('INTO')) { this.advance(); intoTargets.push(this.parseAssignTarget()); while (this.isOp(',')) { this.advance(); intoTargets.push(this.parseAssignTarget()); } }
      else if (this.isKw('USING')) {
        this.advance();
        do {
          let mode = 'IN';
          if (this.isKw('IN') && this.isKw('OUT', 1)) { this.advance(); this.advance(); mode = 'IN OUT'; }
          else if (this.isKw('IN')) { this.advance(); mode = 'IN'; }
          else if (this.isKw('OUT')) { this.advance(); mode = 'OUT'; }
          using.push({ mode, expr: this.parseExpr() });
        } while (this.isOp(',') && (this.advance(), true));
      }
    }
    this.eatOp(';');
    return { kind: 'executeImmediate', sqlExpr, intoTargets, bulkInto, using };
  }

  private parseAssignOrCall(): Stmt {
    const start = this.i;
    let target: AssignTarget | null = null;
    try { target = this.parseAssignTarget(); } catch { target = null; }
    if (target && this.isOp(':=')) {
      this.advance();
      const value = this.parseExpr();
      this.eatOp(';');
      return { kind: 'assign', target, value };
    }
    this.i = start;
    const name = this.parseDottedName();
    const args: CallArg[] = [];
    let rawArgs = '';
    if (this.isOp('(')) {
      this.advance();
      const argStart = this.cur().pos;
      this.parseCallArgs(args);
      const argEnd = this.cur().pos;
      rawArgs = this.source.substring(argStart, argEnd).trim();
      this.eatOp(')');
    }
    this.eatOp(';');
    return { kind: 'call', name, args, rawArgs };
  }

  private parseAssignTarget(): AssignTarget {
    let target: AssignTarget = { kind: 'ident', name: this.advance().upper };
    for (;;) {
      if (this.isOp('.')) {
        this.advance();
        target = { kind: 'member', object: target, name: this.advance().upper };
      } else if (this.isOp('(')) {
        this.advance();
        const index = this.parseExpr();
        this.eatOp(')');
        target = { kind: 'index', base: target, index };
      } else break;
    }
    return target;
  }

  private parseDottedName(): string {
    let name = this.advance().value;
    while (this.isOp('.')) { this.advance(); name += '.' + this.advance().value; }
    return name.toUpperCase();
  }

  private parseCallArgs(out: CallArg[]): void {
    if (this.isOp(')')) return;
    for (;;) {
      let name: string | null = null;
      if (this.cur().type === 'ident' && this.peek(1).type === 'op' && this.peek(1).value === '=>') {
        name = this.advance().upper;
        this.advance();
      }
      out.push({ name, value: this.parseExpr() });
      if (this.isOp(',')) { this.advance(); continue; }
      break;
    }
  }

  parseExpr(): Expr { return this.parseOr(); }

  private parseOr(): Expr {
    let left = this.parseAnd();
    while (this.isKw('OR')) { this.advance(); left = { kind: 'binary', op: 'OR', left, right: this.parseAnd() }; }
    return left;
  }
  private parseAnd(): Expr {
    let left = this.parseNot();
    while (this.isKw('AND')) { this.advance(); left = { kind: 'binary', op: 'AND', left, right: this.parseNot() }; }
    return left;
  }
  private parseNot(): Expr {
    if (this.isKw('NOT')) { this.advance(); return { kind: 'unary', op: 'NOT', operand: this.parseNot() }; }
    return this.parseComparison();
  }
  private parseComparison(): Expr {
    let left = this.parseConcat();
    if (this.isKw('IS')) {
      this.advance();
      let negated = false;
      if (this.isKw('NOT')) { this.advance(); negated = true; }
      this.eatKw('NULL');
      return { kind: 'isnull', operand: left, negated };
    }
    let negated = false;
    if (this.isKw('NOT') && (this.isKw('BETWEEN', 1) || this.isKw('IN', 1) || this.isKw('LIKE', 1))) {
      this.advance(); negated = true;
    }
    if (this.isKw('BETWEEN')) {
      this.advance();
      const low = this.parseConcat();
      this.eatKw('AND');
      const high = this.parseConcat();
      return { kind: 'between', operand: left, low, high, negated };
    }
    if (this.isKw('IN')) {
      this.advance();
      this.eatOp('(');
      const list: Expr[] = [];
      if (!this.isOp(')')) {
        list.push(this.parseExpr());
        while (this.isOp(',')) { this.advance(); list.push(this.parseExpr()); }
      }
      this.eatOp(')');
      return { kind: 'in', operand: left, list, negated };
    }
    if (this.isKw('LIKE')) {
      this.advance();
      const pattern = this.parseConcat();
      return { kind: 'like', operand: left, pattern, negated };
    }
    for (const op of ['=', '<>', '!=', '<=', '>=', '<', '>']) {
      if (this.isOp(op)) { this.advance(); left = { kind: 'binary', op, left, right: this.parseConcat() }; return left; }
    }
    return left;
  }
  private parseConcat(): Expr {
    let left = this.parseAdd();
    while (this.isOp('||')) { this.advance(); left = { kind: 'binary', op: '||', left, right: this.parseAdd() }; }
    return left;
  }
  private parseAdd(): Expr {
    let left = this.parseMul();
    while (this.isOp('+') || this.isOp('-')) { const op = this.advance().value; left = { kind: 'binary', op, left, right: this.parseMul() }; }
    return left;
  }
  private parseMul(): Expr {
    let left = this.parseUnary();
    while (this.isOp('*') || this.isOp('/') || this.isKw('MOD')) {
      const op = this.isKw('MOD') ? 'MOD' : this.cur().value;
      this.advance();
      left = { kind: 'binary', op, left, right: this.parseUnary() };
    }
    return left;
  }
  private parseUnary(): Expr {
    if (this.isOp('-')) { this.advance(); return { kind: 'unary', op: '-', operand: this.parseUnary() }; }
    if (this.isOp('+')) { this.advance(); return this.parseUnary(); }
    return this.parsePower();
  }
  private parsePower(): Expr {
    const base = this.parsePostfix();
    if (this.isOp('**')) { this.advance(); return { kind: 'binary', op: '**', left: base, right: this.parseUnary() }; }
    return base;
  }

  private parsePostfix(): Expr {
    let e = this.parsePrimary();
    for (;;) {
      if (this.isOp('%')) {
        this.advance();
        const attr = this.advance().upper;
        const target = e.kind === 'ident' ? e.name : e.kind === 'member' ? exprToName(e) : '';
        e = { kind: 'attr', target, attribute: attr };
      } else if (this.isOp('.')) {
        this.advance();
        if (this.isOp('(')) break;
        const nm = this.advance().upper;
        if (this.isOp('(')) {
          this.advance();
          const args: CallArg[] = [];
          this.parseCallArgs(args);
          this.eatOp(')');
          const base = e.kind === 'ident' ? e.name : exprToName(e);
          e = { kind: 'call', name: base + '.' + nm, args };
        } else {
          e = { kind: 'member', object: e, name: nm };
        }
      } else if (this.isOp('(')) {
        this.advance();
        const args: CallArg[] = [];
        this.parseCallArgs(args);
        this.eatOp(')');
        if (e.kind === 'ident') e = { kind: 'call', name: e.name, args };
        else if (e.kind === 'member') e = { kind: 'call', name: exprToName(e), args };
        else if (e.kind === 'call' && args.length === 1) e = { kind: 'index', collection: e, index: args[0].value };
        else e = { kind: 'index', collection: e, index: args[0]?.value ?? { kind: 'null' } };
      } else break;
    }
    return e;
  }

  private parsePrimary(): Expr {
    const t = this.cur();
    if (t.type === 'number') { this.advance(); return { kind: 'num', value: Number(t.value) }; }
    if (t.type === 'string') { this.advance(); return { kind: 'str', value: t.value }; }
    if (this.isOp('(')) {
      this.advance();
      const e = this.parseExpr();
      this.eatOp(')');
      return e;
    }
    if (t.type === 'ident') {
      switch (t.upper) {
        case 'NULL': this.advance(); return { kind: 'null' };
        case 'TRUE': this.advance(); return { kind: 'bool', value: true };
        case 'FALSE': this.advance(); return { kind: 'bool', value: false };
        case 'CASE': return this.parseCaseExpr();
        case 'DATE': case 'TIMESTAMP': {
          // ANSI literal: DATE '2020-01-01' / TIMESTAMP '2020-01-01 12:00:00'.
          // Desugared to TO_DATE so evaluation flows through the SQL engine's
          // date machinery. A bare DATE/TIMESTAMP identifier stays an ident.
          if (this.toks[this.i + 1]?.type === 'string') {
            this.advance();
            const lit = this.advance().value;
            const fmt = lit.includes(' ') ? 'YYYY-MM-DD HH24:MI:SS' : 'YYYY-MM-DD';
            return {
              kind: 'call', name: 'TO_DATE',
              args: [
                { name: null, value: { kind: 'str', value: lit } },
                { name: null, value: { kind: 'str', value: fmt } },
              ],
            };
          }
          break;
        }
      }
      this.advance();
      return { kind: 'ident', name: t.upper };
    }
    this.err(`unexpected '${t.value || 'end-of-input'}' in expression`);
  }

  private parseCaseExpr(): Expr {
    this.eatKw('CASE');
    let selector: Expr | null = null;
    if (!this.isKw('WHEN')) selector = this.parseExpr();
    const whens: { when: Expr; then: Expr }[] = [];
    while (this.isKw('WHEN')) {
      this.advance();
      const w = this.parseExpr();
      this.eatKw('THEN');
      const th = this.parseExpr();
      whens.push({ when: w, then: th });
    }
    let elseExpr: Expr | null = null;
    if (this.isKw('ELSE')) { this.advance(); elseExpr = this.parseExpr(); }
    this.eatKw('END');
    return { kind: 'case', selector, whens, elseExpr };
  }
}

function exprToName(e: Expr): string {
  if (e.kind === 'ident') return e.name;
  if (e.kind === 'member') return exprToName(e.object) + '.' + e.name;
  return '';
}

export function parsePlsql(source: string): Block {
  return PlsqlParser.parse(source);
}

export { PlsqlLexParseError };
