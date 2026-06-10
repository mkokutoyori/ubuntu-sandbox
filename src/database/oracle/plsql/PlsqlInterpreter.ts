import type {
  Block, Stmt, Expr, Declaration, TypeRef, CallArg, AssignTarget, SubprogramDecl,
} from './PlsqlAst';
import {
  Scope, Slot, PlsqlValue, PlsqlRecord, PlsqlCollection, Scalar, cloneValue,
  CursorRuntime, ExitSignal, ContinueSignal, ReturnSignal, GotoSignal, PlsqlHost,
} from './PlsqlValue';
import { PlsqlException, findPredefinedException, matchPredefinedException } from './PlsqlException';
import { parsePlsql, PlsqlParser } from './PlsqlParser';

const MAX_LOOP = 1_000_000;

const SQL_KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE',
  'AND', 'OR', 'NOT', 'NULL', 'IS', 'IN', 'LIKE', 'BETWEEN', 'ORDER', 'BY', 'GROUP',
  'HAVING', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL', 'ON', 'AS', 'DISTINCT',
  'UNION', 'ALL', 'MERGE', 'USING', 'WHEN', 'THEN', 'ELSE', 'CASE', 'END', 'EXISTS',
  'ASC', 'DESC', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'DUAL', 'COMMIT', 'ROLLBACK',
  'TRUE', 'FALSE', 'SYSDATE', 'CURRENT_TIMESTAMP', 'SYSTIMESTAMP', 'ROWNUM',
]);

export class PlsqlInterpreter {
  private host: PlsqlHost;
  private sqlcode = 0;
  private sqlerrm = 'ORA-0000: normal, successful completion';
  private sqlRowCount = 0;
  private sqlFound: boolean | null = null;

  constructor(host: PlsqlHost) {
    this.host = host;
  }

  run(block: Block): void {
    const root = new Scope(null);
    this.execBlock(block, root);
  }

  private execBlock(block: Block, parent: Scope): void {
    const scope = parent.child();
    for (const d of block.declarations) this.declare(d, scope);
    try {
      this.execStmts(block.body, scope);
    } catch (e) {
      if (e instanceof ExitSignal || e instanceof ContinueSignal || e instanceof ReturnSignal || e instanceof GotoSignal) throw e;
      const ex = this.toPlsqlException(e);
      const handler = this.matchHandler(block, ex, scope);
      if (!handler) throw ex;
      const prevCode = this.sqlcode;
      const prevErr = this.sqlerrm;
      this.sqlcode = this.computeSqlcode(ex);
      this.sqlerrm = ex.message;
      try {
        this.execStmts(handler.body, scope);
      } finally {
        this.sqlcode = prevCode;
        this.sqlerrm = prevErr;
      }
    }
  }

  private matchHandler(block: Block, ex: PlsqlException, scope: Scope) {
    for (const h of block.handlers) {
      if (h.others) return h;
      for (const nm of h.names) {
        if (nm === ex.exceptionName) return h;
        const userEx = scope.findException(nm);
        if (userEx && userEx.code === ex.errorCode) return h;
        const pre = findPredefinedException(nm);
        if (pre && (pre.errorCode === ex.errorCode || pre.name === ex.exceptionName)) return h;
      }
    }
    return null;
  }

  private computeSqlcode(ex: PlsqlException): number {
    if (ex.exceptionName === 'NO_DATA_FOUND') return 100;
    if (ex.errorCode < 0) return ex.errorCode;
    return -ex.errorCode;
  }

  private toPlsqlException(e: unknown): PlsqlException {
    if (e instanceof PlsqlException) return e;
    const msg = e instanceof Error ? e.message : String(e);
    const pre = matchPredefinedException(msg);
    if (pre) return new PlsqlException(pre.name, pre.errorCode, msg.includes('ORA-') ? msg : pre.defaultMessage);
    const m = msg.match(/ORA-?(\d{1,5})/);
    const code = m ? parseInt(m[1], 10) : 6510;
    return new PlsqlException('USER_DEFINED', code, msg, false);
  }

  private declare(d: Declaration, scope: Scope): void {
    switch (d.kind) {
      case 'var': {
        const value = d.init ? this.coerceToType(this.evalExpr(d.init, scope), d.type, scope) : this.defaultForType(d.type, scope);
        scope.declareVar(d.name, { type: d.type, value, constant: d.constant });
        break;
      }
      case 'exception':
        scope.exceptions.set(d.name, { code: -(20000 + scope.exceptions.size + 1) });
        break;
      case 'pragma_exception_init': {
        const ex = scope.exceptions.get(d.exceptionName) ?? { code: d.code };
        ex.code = d.code;
        scope.exceptions.set(d.exceptionName, ex);
        break;
      }
      case 'cursor':
        scope.cursorDecls.set(d.name, d);
        break;
      case 'type':
        if (d.def.form === 'record') {
          scope.recordTypes.set(d.name, { fields: d.def.fields });
        } else if (d.def.form === 'table') {
          scope.collectionTypes.set(d.name, { form: 'table', element: d.def.element, indexed: d.def.indexed, limit: null });
        } else {
          scope.collectionTypes.set(d.name, { form: 'varray', element: d.def.element, indexed: false, limit: d.def.limit });
        }
        break;
      case 'subprogram':
        scope.subprograms.set(d.name, d);
        break;
      case 'pragma':
        // Compile-time directive (AUTONOMOUS_TRANSACTION, …): the simulator
        // runs every statement in the session's single transaction context,
        // so these have no runtime effect.
        break;
    }
  }

  private defaultForType(type: TypeRef, scope: Scope): PlsqlValue {
    const rt = scope.findRecordType(type.name);
    if (rt) {
      const rec = new PlsqlRecord(type.name);
      for (const f of rt.fields) {
        rec.fields.set(f.name, { type: f.type, value: f.init ? this.evalExpr(f.init, scope) : this.defaultForType(f.type, scope), constant: false });
      }
      return rec;
    }
    const ct = scope.findCollectionType(type.name);
    if (ct) return new PlsqlCollection(type.name, ct.form === 'varray' ? 'varray' : (ct.indexed ? 'assoc' : 'table'), ct.limit);
    if (type.anchored?.kind === 'ROWTYPE') return new PlsqlRecord(type.name);
    return null;
  }

  private coerceToType(value: PlsqlValue, type: TypeRef, scope: Scope): PlsqlValue {
    if (value === null) return null;
    if (value instanceof PlsqlRecord || value instanceof PlsqlCollection) return value;
    const base = type.name.toUpperCase();
    if (base.startsWith('NUMBER') || base === 'INTEGER' || base === 'INT' || base === 'PLS_INTEGER'
      || base === 'BINARY_INTEGER' || base === 'SIMPLE_INTEGER' || base === 'BINARY_FLOAT'
      || base === 'BINARY_DOUBLE' || base === 'FLOAT' || base === 'DEC' || base === 'DECIMAL' || base === 'NUMERIC' || base === 'SMALLINT') {
      const n = typeof value === 'number' ? value : Number(value);
      if (typeof value === 'string' && isNaN(n)) throw new PlsqlException('INVALID_NUMBER', 1722, 'ORA-01722: invalid number');
      return isNaN(n) ? null : n;
    }
    if (base === 'BOOLEAN') return typeof value === 'boolean' ? value : null;
    if (base.startsWith('VARCHAR') || base.startsWith('CHAR') || base.startsWith('NVARCHAR')
      || base.startsWith('NCHAR') || base === 'STRING' || base === 'CLOB' || base === 'LONG') {
      return value instanceof Date ? value.toISOString() : String(value);
    }
    if (base === 'DATE' || base.startsWith('TIMESTAMP')) {
      if (value instanceof Date) return value;
      return value;
    }
    return value;
  }

  private execStmts(stmts: Stmt[], scope: Scope): void {
    let i = 0;
    while (i < stmts.length) {
      try {
        this.execStmt(stmts[i], scope);
      } catch (sig) {
        if (sig instanceof GotoSignal) {
          const idx = stmts.findIndex(s => s.kind === 'labelMark' && s.label === sig.label);
          if (idx >= 0) { i = idx + 1; continue; }
        }
        throw sig;
      }
      i++;
    }
  }

  private execStmt(s: Stmt, scope: Scope): void {
    switch (s.kind) {
      case 'null': case 'labelMark': return;
      case 'block': this.execBlock(s, scope); return;
      case 'assign': this.execAssign(s.target, this.evalExpr(s.value, scope), scope); return;
      case 'if': {
        for (const b of s.branches) {
          if (this.truth(this.evalExpr(b.cond, scope))) { this.execStmts(b.body, scope); return; }
        }
        if (s.elseBody) this.execStmts(s.elseBody, scope);
        return;
      }
      case 'case': {
        if (s.selector) {
          const sel = this.evalExpr(s.selector, scope);
          for (const w of s.whens) {
            if (this.eq(sel, this.evalExpr(w.match, scope))) { this.execStmts(w.body, scope); return; }
          }
        } else {
          for (const w of s.whens) {
            if (this.truth(this.evalExpr(w.match, scope))) { this.execStmts(w.body, scope); return; }
          }
        }
        if (s.elseBody) { this.execStmts(s.elseBody, scope); return; }
        throw new PlsqlException('CASE_NOT_FOUND', 6592, 'ORA-06592: CASE not found while executing CASE statement');
      }
      case 'loop': this.runLoop(s.label, () => true, s.body, scope, null); return;
      case 'while': this.runLoop(s.label, () => this.truth(this.evalExpr(s.cond, scope)), s.body, scope, null); return;
      case 'forNum': this.runForNum(s, scope); return;
      case 'forCursor': this.runForCursor(s, scope); return;
      case 'exit': {
        if (s.when && !this.truth(this.evalExpr(s.when, scope))) return;
        throw new ExitSignal(s.label);
      }
      case 'continue': {
        if (s.when && !this.truth(this.evalExpr(s.when, scope))) return;
        throw new ContinueSignal(s.label);
      }
      case 'goto': throw new GotoSignal(s.label);
      case 'return': throw new ReturnSignal(s.value ? this.evalExpr(s.value, scope) : null);
      case 'raise': this.execRaise(s.name, scope); return;
      case 'open': this.execOpen(s.cursorName, s.args, scope); return;
      case 'openFor': this.execOpenFor(s.varName, s.query, scope); return;
      case 'fetch': this.execFetch(s, scope); return;
      case 'close': this.execClose(s.cursorName, scope); return;
      case 'selectInto': this.execSelectInto(s, scope); return;
      case 'sql': this.execSql(this.interpolateBinds(s.sql, scope)); return;
      case 'executeImmediate': this.execExecuteImmediate(s, scope); return;
      case 'call': this.execCall(s.name, s.args, s.rawArgs, scope); return;
      case 'pipeRow': return;
    }
  }

  private runLoop(label: string | null, cond: () => boolean, body: Stmt[], scope: Scope, beforeIter: (() => void) | null): void {
    let guard = MAX_LOOP;
    while (cond()) {
      if (guard-- <= 0) throw new PlsqlException('STORAGE_ERROR', 6500, 'ORA-06500: PL/SQL: storage error (loop limit exceeded)');
      const iterScope = scope.child();
      if (beforeIter) beforeIter();
      try {
        this.execStmts(body, iterScope);
      } catch (sig) {
        if (sig instanceof ExitSignal) {
          if (sig.label === null || sig.label === label) return;
          throw sig;
        }
        if (sig instanceof ContinueSignal) {
          if (sig.label === null || sig.label === label) continue;
          throw sig;
        }
        throw sig;
      }
    }
  }

  private runForNum(s: Extract<Stmt, { kind: 'forNum' }>, scope: Scope): void {
    const lo = Number(this.evalExpr(s.low, scope));
    const hi = Number(this.evalExpr(s.high, scope));
    const values: number[] = [];
    if (s.reverse) { for (let v = hi; v >= lo; v--) values.push(v); }
    else { for (let v = lo; v <= hi; v++) values.push(v); }
    let idx = 0;
    this.runLoopIndexed(s.label, () => idx < values.length, s.body, scope, () => {
      const sc = scope.child();
      sc.declareVar(s.varName, { type: { name: 'PLS_INTEGER', args: [] }, value: values[idx], constant: true });
      idx++;
      return sc;
    });
  }

  private runLoopIndexed(label: string | null, cond: () => boolean, body: Stmt[], parent: Scope, makeScope: () => Scope): void {
    let guard = MAX_LOOP;
    while (cond()) {
      if (guard-- <= 0) throw new PlsqlException('STORAGE_ERROR', 6500, 'ORA-06500: PL/SQL: storage error');
      const iterScope = makeScope();
      try {
        this.execStmts(body, iterScope);
      } catch (sig) {
        if (sig instanceof ExitSignal) { if (sig.label === null || sig.label === label) return; throw sig; }
        if (sig instanceof ContinueSignal) { if (sig.label === null || sig.label === label) continue; throw sig; }
        throw sig;
      }
    }
  }

  private runForCursor(s: Extract<Stmt, { kind: 'forCursor' }>, scope: Scope): void {
    let sql: string;
    if (s.query) {
      sql = this.interpolateBinds(s.query, scope);
    } else {
      const decl = scope.findCursorDecl(s.cursorName!);
      if (!decl) throw new PlsqlException('USER_DEFINED', 6550, `ORA-06550: cursor ${s.cursorName} not declared`);
      const childScope = scope.child();
      this.bindCursorParams(decl, s.args, childScope, scope);
      sql = this.interpolateBinds(decl.query, childScope);
    }
    const rs = this.runQuery(sql);
    let idx = 0;
    this.runLoopIndexed(s.label, () => idx < rs.rows.length, s.body, scope, () => {
      const sc = scope.child();
      const rec = new PlsqlRecord(s.varName);
      rs.columns.forEach((c, ci) => {
        rec.fields.set(c.toUpperCase(), { type: { name: 'ANY', args: [] }, value: rs.rows[idx][ci] ?? null, constant: false });
      });
      sc.declareVar(s.varName, { type: { name: 'ROWTYPE', args: [] }, value: rec, constant: false });
      idx++;
      return sc;
    });
  }

  private bindCursorParams(decl: import('./PlsqlAst').CursorDecl, args: CallArg[], target: Scope, evalScope: Scope): void {
    decl.params.forEach((p, i) => {
      const arg = args.find(a => a.name === p.name) ?? (args[i] && !args[i].name ? args[i] : undefined);
      const v = arg ? this.evalExpr(arg.value, evalScope) : null;
      target.declareVar(p.name, { type: p.type, value: v, constant: false });
    });
  }

  private execRaise(name: string | null, scope: Scope): void {
    if (name === null) {
      throw new PlsqlException('USER_DEFINED', this.sqlcode || 6510, this.sqlerrm);
    }
    const up = name.toUpperCase();
    const userEx = scope.findException(up);
    if (userEx) {
      throw new PlsqlException(up, userEx.code, `ORA-${String(Math.abs(userEx.code)).padStart(5, '0')}: exception ${up}`, userEx.code <= -20000);
    }
    const pre = findPredefinedException(up);
    if (pre) throw new PlsqlException(pre.name, pre.errorCode, pre.defaultMessage);
    throw new PlsqlException(up, 6510, `ORA-06510: PL/SQL: unhandled user-defined exception (${up})`, true);
  }

  private execAssign(target: AssignTarget, value: PlsqlValue, scope: Scope): void {
    if (target.kind === 'ident') {
      const slot = scope.findSlot(target.name);
      if (!slot) throw new PlsqlException('USER_DEFINED', 6550, `PLS-00201: identifier '${target.name}' must be declared`);
      if (slot.constant) throw new PlsqlException('USER_DEFINED', 6550, `PLS-00363: expression '${target.name}' cannot be used as an assignment target`);
      slot.value = this.coerceToType(value, slot.type, scope);
      return;
    }
    if (target.kind === 'member') {
      const obj = this.resolveTarget(target.object, scope);
      if (obj instanceof PlsqlRecord) {
        const f = obj.fields.get(target.name) ?? { type: { name: 'ANY', args: [] }, value: null, constant: false };
        f.value = value;
        obj.fields.set(target.name, f);
        return;
      }
      throw new PlsqlException('USER_DEFINED', 6550, `PLS-00302: component '${target.name}' must be declared`);
    }
    const base = this.resolveTarget(target.base, scope);
    if (base instanceof PlsqlCollection) {
      const key = Number(this.evalExpr(target.index, scope));
      base.entries.set(key, value as PlsqlValue);
      return;
    }
    throw new PlsqlException('USER_DEFINED', 6550, 'PLS-00382: expression is of wrong type');
  }

  private resolveTarget(target: AssignTarget, scope: Scope): PlsqlValue {
    if (target.kind === 'ident') {
      const slot = scope.findSlot(target.name);
      if (!slot) throw new PlsqlException('USER_DEFINED', 6550, `PLS-00201: identifier '${target.name}' must be declared`);
      return slot.value;
    }
    if (target.kind === 'member') {
      const obj = this.resolveTarget(target.object, scope);
      if (obj instanceof PlsqlRecord) return obj.fields.get(target.name)?.value ?? null;
      return null;
    }
    const base = this.resolveTarget(target.base, scope);
    if (base instanceof PlsqlCollection) return base.entries.get(Number(this.evalExpr(target.index, scope))) ?? null;
    return null;
  }

  private execOpen(name: string, args: CallArg[], scope: Scope): void {
    const decl = scope.findCursorDecl(name);
    if (!decl) throw new PlsqlException('INVALID_CURSOR', 1001, 'ORA-01001: invalid cursor');
    const existing = scope.findCursor(name);
    if (existing && existing.isOpen) throw new PlsqlException('CURSOR_ALREADY_OPEN', 6511, 'ORA-06511: PL/SQL: cursor already open');
    const childScope = scope.child();
    this.bindCursorParams(decl, args, childScope, scope);
    const sql = this.interpolateBinds(decl.query, childScope);
    const rs = this.runQuery(sql);
    this.setCursor(name, scope, { decl, query: sql, rows: rs.rows, columns: rs.columns, position: -1, isOpen: true, rowCount: 0 });
  }

  private execOpenFor(varName: string, query: string, scope: Scope): void {
    const sql = this.interpolateBinds(query, scope);
    const rs = this.runQuery(sql);
    this.setCursor(varName, scope, { decl: null, query: sql, rows: rs.rows, columns: rs.columns, position: -1, isOpen: true, rowCount: 0 });
  }

  private setCursor(name: string, scope: Scope, rt: CursorRuntime): void {
    const up = name.toUpperCase();
    let s: Scope | null = scope;
    while (s) {
      if (s.cursors.has(up) || s.cursorDecls.has(up)) { s.cursors.set(up, rt); return; }
      s = s.parent;
    }
    scope.cursors.set(up, rt);
  }

  private execFetch(s: Extract<Stmt, { kind: 'fetch' }>, scope: Scope): void {
    const cur = scope.findCursor(s.cursorName);
    if (!cur || !cur.isOpen) throw new PlsqlException('INVALID_CURSOR', 1001, 'ORA-01001: invalid cursor');
    const rows = cur.rows ?? [];
    if (s.bulk) {
      const limit = s.limit ? Number(this.evalExpr(s.limit, scope)) : Infinity;
      const collected: Scalar[][] = [];
      while (cur.position + 1 < rows.length && collected.length < limit) {
        cur.position++;
        collected.push(rows[cur.position]);
        cur.rowCount++;
      }
      const target = s.intoTargets[0];
      const coll = this.resolveTarget(target, scope);
      if (coll instanceof PlsqlCollection) {
        coll.entries.clear();
        collected.forEach((r, idx) => coll.entries.set(idx + 1, r[0] ?? null));
      }
      return;
    }
    if (cur.position + 1 >= rows.length) {
      cur.position = rows.length;
      return;
    }
    cur.position++;
    cur.rowCount++;
    const row = rows[cur.position];
    if (s.intoTargets.length === 1) {
      const t = s.intoTargets[0];
      const cur2 = this.resolveTarget(t, scope);
      if (cur2 instanceof PlsqlRecord || (cur2 === null && this.targetIsRecord(t, scope))) {
        const rec = new PlsqlRecord('ROW');
        cur.columns.forEach((c, ci) => rec.fields.set(c.toUpperCase(), { type: { name: 'ANY', args: [] }, value: row[ci] ?? null, constant: false }));
        this.execAssign(t, rec, scope);
        return;
      }
    }
    s.intoTargets.forEach((t, i) => this.execAssign(t, row[i] ?? null, scope));
  }

  private targetIsRecord(t: AssignTarget, scope: Scope): boolean {
    if (t.kind !== 'ident') return false;
    const slot = scope.findSlot(t.name);
    if (!slot) return false;
    return slot.type.anchored?.kind === 'ROWTYPE' || !!scope.findRecordType(slot.type.name);
  }

  private execClose(name: string, scope: Scope): void {
    const cur = scope.findCursor(name);
    if (!cur || !cur.isOpen) throw new PlsqlException('INVALID_CURSOR', 1001, 'ORA-01001: invalid cursor');
    cur.isOpen = false;
    cur.rows = null;
    cur.position = -1;
  }

  private execSelectInto(s: Extract<Stmt, { kind: 'selectInto' }>, scope: Scope): void {
    const sql = this.interpolateBinds(s.sql, scope);
    const rs = this.runQuery(sql);
    if (s.bulk) {
      const target = s.intoTargets[0];
      const coll = this.resolveTarget(target, scope);
      if (coll instanceof PlsqlCollection) {
        coll.entries.clear();
        rs.rows.forEach((r, idx) => coll.entries.set(idx + 1, r[0] ?? null));
      }
      return;
    }
    if (rs.rows.length === 0) throw new PlsqlException('NO_DATA_FOUND', 1403, 'ORA-01403: no data found');
    if (rs.rows.length > 1) throw new PlsqlException('TOO_MANY_ROWS', 1422, 'ORA-01422: exact fetch returns more than requested number of rows');
    const row = rs.rows[0];
    if (s.intoTargets.length === 1 && this.targetIsRecord(s.intoTargets[0], scope)) {
      const rec = new PlsqlRecord('ROW');
      rs.columns.forEach((c, ci) => rec.fields.set(c.toUpperCase(), { type: { name: 'ANY', args: [] }, value: row[ci] ?? null, constant: false }));
      this.execAssign(s.intoTargets[0], rec, scope);
      return;
    }
    s.intoTargets.forEach((t, i) => this.execAssign(t, row[i] ?? null, scope));
  }

  private execExecuteImmediate(s: Extract<Stmt, { kind: 'executeImmediate' }>, scope: Scope): void {
    let sql = String(this.evalExpr(s.sqlExpr, scope) ?? '');
    if (s.using.length > 0) {
      let bi = 0;
      sql = sql.replace(/:\w+|\?/g, () => {
        const u = s.using[bi++];
        return u ? this.toSqlLiteral(this.evalExpr(u.expr, scope)) : 'NULL';
      });
    }
    if (s.intoTargets.length > 0) {
      const rs = this.runQuery(sql);
      if (s.bulkInto) {
        const coll = this.resolveTarget(s.intoTargets[0], scope);
        if (coll instanceof PlsqlCollection) {
          coll.entries.clear();
          rs.rows.forEach((r, idx) => coll.entries.set(idx + 1, r[0] ?? null));
        }
        return;
      }
      if (rs.rows.length === 0) throw new PlsqlException('NO_DATA_FOUND', 1403, 'ORA-01403: no data found');
      if (rs.rows.length > 1) throw new PlsqlException('TOO_MANY_ROWS', 1422, 'ORA-01422: exact fetch returns more than requested number of rows');
      s.intoTargets.forEach((t, i) => this.execAssign(t, rs.rows[0][i] ?? null, scope));
      return;
    }
    this.execSql(sql);
  }

  private execSql(sql: string): void {
    const r = this.host.runSql(sql);
    this.sqlRowCount = r.affectedRows ?? (r.isQuery ? r.rows.length : 0);
    this.sqlFound = this.sqlRowCount > 0;
  }

  private runQuery(sql: string) {
    const r = this.host.runSql(sql);
    this.sqlRowCount = r.isQuery ? r.rows.length : (r.affectedRows ?? 0);
    this.sqlFound = this.sqlRowCount > 0;
    return r;
  }

  private execCall(name: string, args: CallArg[], rawArgs: string, scope: Scope): void {
    const up = name.toUpperCase();

    if (up === 'NULL') return;

    if (up === 'RAISE_APPLICATION_ERROR') {
      const code = Number(this.evalExpr(args[0].value, scope));
      const message = String(this.evalExpr(args[1].value, scope) ?? '');
      const codeStr = code < 0 ? `ORA-${String(Math.abs(code)).padStart(5, '0')}` : `ORA-${String(code).padStart(5, '0')}`;
      throw new PlsqlException('USER_DEFINED', code, `${codeStr}: ${message}`, true);
    }

    if (up === 'DBMS_OUTPUT.PUT_LINE') {
      this.host.putLine(this.toText(args.length ? this.evalExpr(args[0].value, scope) : ''));
      return;
    }
    if (up === 'DBMS_OUTPUT.PUT') {
      this.host.put(this.toText(args.length ? this.evalExpr(args[0].value, scope) : ''));
      return;
    }
    if (up === 'DBMS_OUTPUT.NEW_LINE') { this.host.putLine(''); return; }
    if (up === 'DBMS_OUTPUT.ENABLE' || up === 'DBMS_OUTPUT.DISABLE') return;

    if (this.tryCollectionMethodStmt(name, args, scope)) return;

    const local = scope.findSubprogram(up);
    if (local && !local.decl.isFunction) {
      this.callLocalSubprogram(local.decl, local.scope, args, scope);
      return;
    }

    const unit = this.host.lookupUnit(up);
    if (unit && (unit.type === 'PROCEDURE' || unit.type === 'FUNCTION')) {
      this.callStoredUnit(unit, args, scope);
      return;
    }

    const evaluated = args.map(a => this.safeEval(a.value, scope));
    if (this.host.callBuiltin(up, rawArgs, evaluated)) return;

    throw new PlsqlException('USER_DEFINED', 6550, `PLS-00201: identifier '${up}' must be declared`);
  }

  private safeEval(e: Expr, scope: Scope): PlsqlValue {
    try { return this.evalExpr(e, scope); } catch { return null; }
  }

  private callLocalSubprogram(decl: SubprogramDecl, defScope: Scope, args: CallArg[], callerScope: Scope): PlsqlValue {
    const callScope = defScope.child();
    const outBindings: { param: import('./PlsqlAst').ParamDecl; target: AssignTarget }[] = [];
    decl.params.forEach((p, i) => {
      const arg = args.find(a => a.name === p.name) ?? (args[i] && !args[i].name ? args[i] : undefined);
      let v: PlsqlValue;
      if (arg) v = this.evalExpr(arg.value, callerScope);
      else if (p.init) v = this.evalExpr(p.init, callScope);
      else v = null;
      callScope.declareVar(p.name, { type: p.type, value: this.coerceToType(v, p.type, callScope), constant: false });
      if ((p.mode === 'OUT' || p.mode === 'IN OUT') && arg && arg.value.kind === 'ident') {
        outBindings.push({ param: p, target: { kind: 'ident', name: arg.value.name } });
      } else if ((p.mode === 'OUT' || p.mode === 'IN OUT') && arg) {
        const t = this.exprToTarget(arg.value);
        if (t) outBindings.push({ param: p, target: t });
      }
    });
    let returnVal: PlsqlValue = null;
    if (decl.block) {
      try {
        this.execBlock(decl.block, callScope);
      } catch (sig) {
        if (sig instanceof ReturnSignal) returnVal = sig.value;
        else throw sig;
      }
    }
    for (const ob of outBindings) {
      const slot = callScope.findSlot(ob.param.name);
      if (slot) this.execAssign(ob.target, slot.value, callerScope);
    }
    return returnVal;
  }

  private exprToTarget(e: Expr): AssignTarget | null {
    if (e.kind === 'ident') return { kind: 'ident', name: e.name };
    if (e.kind === 'member') { const o = this.exprToTarget(e.object); return o ? { kind: 'member', object: o, name: e.name } : null; }
    if (e.kind === 'index') { const b = this.exprToTarget(e.collection); return b ? { kind: 'index', base: b, index: e.index } : null; }
    return null;
  }

  private callStoredUnit(unit: import('./PlsqlValue').StoredUnitLike, args: CallArg[], scope: Scope): PlsqlValue {
    const sub = this.parseUnit(unit);
    if (!sub) return null;
    const callerScope = scope;
    const callScope = new Scope(null);
    callScope.subprograms.set(unit.name.toUpperCase().split('.').pop()!, sub);
    return this.callLocalSubprogram(sub, callScope, args, callerScope);
  }

  private unitCache = new WeakMap<object, SubprogramDecl | null>();

  private parseUnit(unit: import('./PlsqlValue').StoredUnitLike): SubprogramDecl | null {
    const cached = this.unitCache.get(unit);
    if (cached !== undefined) return cached;
    const params = unit.parameters.map(p => `${p.name} ${p.mode} ${p.dataType}${p.defaultValue ? ' DEFAULT ' + p.defaultValue : ''}`).join(', ');
    const header = unit.type === 'FUNCTION'
      ? `FUNCTION ${unit.name}${params ? '(' + params + ')' : ''} RETURN ${unit.returnType} IS `
      : `PROCEDURE ${unit.name}${params ? '(' + params + ')' : ''} IS `;
    const body = unit.body.trim();
    const bodyUpper = body.toUpperCase();
    let src: string;
    if (bodyUpper.startsWith('DECLARE')) {
      src = header.replace(/ IS $/, ' IS ') + body.replace(/^DECLARE/i, '') + ';';
    } else if (bodyUpper.startsWith('BEGIN')) {
      src = header + body + ';';
    } else {
      src = header + 'BEGIN ' + body + ' END;';
    }
    try {
      const block = parsePlsql(`DECLARE ${src} BEGIN NULL; END;`);
      const found = block.declarations.find(d => d.kind === 'subprogram') as SubprogramDecl | undefined;
      const decl = found ?? null;
      this.unitCache.set(unit, decl);
      return decl;
    } catch {
      this.unitCache.set(unit, null);
      return null;
    }
  }

  private tryCollectionMethodStmt(name: string, args: CallArg[], scope: Scope): boolean {
    const dot = name.lastIndexOf('.');
    if (dot < 0) return false;
    const baseName = name.substring(0, dot);
    const method = name.substring(dot + 1).toUpperCase();
    const slot = scope.findSlot(baseName);
    if (!slot || !(slot.value instanceof PlsqlCollection)) return false;
    const coll = slot.value;
    switch (method) {
      case 'DELETE': {
        if (args.length === 0) coll.entries.clear();
        else if (args.length === 1) coll.entries.delete(Number(this.evalExpr(args[0].value, scope)));
        else {
          const a = Number(this.evalExpr(args[0].value, scope));
          const b = Number(this.evalExpr(args[1].value, scope));
          for (let k = a; k <= b; k++) coll.entries.delete(k);
        }
        return true;
      }
      case 'EXTEND': {
        const n = args.length ? Number(this.evalExpr(args[0].value, scope)) : 1;
        const start = (coll.last() ?? 0) + 1;
        for (let k = 0; k < n; k++) coll.entries.set(start + k, null);
        return true;
      }
      case 'TRIM': {
        const n = args.length ? Number(this.evalExpr(args[0].value, scope)) : 1;
        for (let k = 0; k < n; k++) { const last = coll.last(); if (last !== null) coll.entries.delete(last); }
        return true;
      }
    }
    return false;
  }

  evalExpr(e: Expr, scope: Scope): PlsqlValue {
    switch (e.kind) {
      case 'num': return e.value;
      case 'str': return e.value;
      case 'bool': return e.value;
      case 'null': return null;
      case 'ident': return this.evalIdent(e.name, scope);
      case 'attr': return this.evalAttr(e.target, e.attribute, scope);
      case 'member': return this.evalMember(e.object, e.name, scope);
      case 'index': {
        const c = this.evalExpr(e.collection, scope);
        if (c instanceof PlsqlCollection) {
          const k = Number(this.evalExpr(e.index, scope));
          if (!c.entries.has(k)) throw new PlsqlException('SUBSCRIPT_BEYOND_COUNT', 6533, 'ORA-06533: Subscript beyond count');
          return c.entries.get(k) ?? null;
        }
        return null;
      }
      case 'unary': {
        if (e.op === 'NOT') { const v = this.evalExpr(e.operand, scope); return v === null ? null : !this.truth(v); }
        const n = Number(this.evalExpr(e.operand, scope));
        return -n;
      }
      case 'binary': return this.evalBinary(e.op, e.left, e.right, scope);
      case 'isnull': { const v = this.evalExpr(e.operand, scope); const isn = v === null; return e.negated ? !isn : isn; }
      case 'between': {
        const v = this.evalExpr(e.operand, scope);
        const lo = this.evalExpr(e.low, scope);
        const hi = this.evalExpr(e.high, scope);
        if (v === null || lo === null || hi === null) return null;
        const r = this.cmp(v, lo) >= 0 && this.cmp(v, hi) <= 0;
        return e.negated ? !r : r;
      }
      case 'in': {
        const v = this.evalExpr(e.operand, scope);
        if (v === null) return null;
        let found = false;
        for (const item of e.list) { if (this.eq(v, this.evalExpr(item, scope))) { found = true; break; } }
        return e.negated ? !found : found;
      }
      case 'like': {
        const v = this.evalExpr(e.operand, scope);
        const p = this.evalExpr(e.pattern, scope);
        if (v === null || p === null) return null;
        const r = this.likeMatch(String(v), String(p));
        return e.negated ? !r : r;
      }
      case 'case': {
        if (e.selector) {
          const sel = this.evalExpr(e.selector, scope);
          for (const w of e.whens) if (this.eq(sel, this.evalExpr(w.when, scope))) return this.evalExpr(w.then, scope);
        } else {
          for (const w of e.whens) if (this.truth(this.evalExpr(w.when, scope))) return this.evalExpr(w.then, scope);
        }
        return e.elseExpr ? this.evalExpr(e.elseExpr, scope) : null;
      }
      case 'call': return this.evalCall(e.name, e.args, scope);
    }
  }

  private evalIdent(name: string, scope: Scope): PlsqlValue {
    const up = name.toUpperCase();
    const slot = scope.findSlot(up);
    if (slot) return slot.value;
    if (up === 'SQLCODE') return this.sqlcode;
    if (up === 'SQLERRM') return this.sqlerrm;
    if (up === 'SYSDATE' || up === 'SYSTIMESTAMP' || up === 'CURRENT_DATE' || up === 'CURRENT_TIMESTAMP') return new Date();
    if (up === 'USER') return this.host.currentSchema();
    if (up === 'TRUE') return true;
    if (up === 'FALSE') return false;
    if (up === 'NULL') return null;
    const cur = scope.findCursor(up);
    if (cur) return null;
    const r = this.host.runSql(`SELECT ${up} FROM DUAL`);
    if (r.isQuery && r.rows.length) return r.rows[0][0];
    throw new PlsqlException('USER_DEFINED', 6550, `PLS-00201: identifier '${up}' must be declared`);
  }

  private evalAttr(target: string, attribute: string, scope: Scope): PlsqlValue {
    const up = target.toUpperCase();
    const attr = attribute.toUpperCase();
    if (up === 'SQL') {
      switch (attr) {
        case 'ROWCOUNT': return this.sqlRowCount;
        case 'FOUND': return this.sqlFound;
        case 'NOTFOUND': return this.sqlFound === null ? null : !this.sqlFound;
        case 'ISOPEN': return false;
      }
    }
    const cur = scope.findCursor(up);
    if (cur) {
      switch (attr) {
        case 'ISOPEN': return cur.isOpen;
        case 'FOUND': return cur.position < 0 ? null : (cur.rows ? cur.position < cur.rows.length : false);
        case 'NOTFOUND': return cur.position < 0 ? null : (cur.rows ? cur.position >= cur.rows.length : true);
        case 'ROWCOUNT': return cur.rowCount;
      }
    }
    const slot = scope.findSlot(up);
    if (slot && slot.value instanceof PlsqlCollection) {
      const coll = slot.value;
      switch (attr) {
        case 'COUNT': return coll.count();
        case 'FIRST': return coll.first();
        case 'LAST': return coll.last();
        case 'LIMIT': return coll.limit;
      }
    }
    return null;
  }

  private evalMember(objExpr: Expr, name: string, scope: Scope): PlsqlValue {
    const obj = this.evalExpr(objExpr, scope);
    if (obj instanceof PlsqlRecord) return obj.fields.get(name.toUpperCase())?.value ?? null;
    if (obj instanceof PlsqlCollection) {
      const m = name.toUpperCase();
      if (m === 'COUNT') return obj.count();
      if (m === 'FIRST') return obj.first();
      if (m === 'LAST') return obj.last();
      if (m === 'LIMIT') return obj.limit;
    }
    return null;
  }

  private evalCall(name: string, args: CallArg[], scope: Scope): PlsqlValue {
    const up = name.toUpperCase();

    const directSlot = scope.findSlot(up);
    if (directSlot && directSlot.value instanceof PlsqlCollection && args.length === 1) {
      const coll = directSlot.value;
      const k = Number(this.evalExpr(args[0].value, scope));
      if (!coll.entries.has(k)) throw new PlsqlException('SUBSCRIPT_BEYOND_COUNT', 6533, 'ORA-06533: Subscript beyond count');
      return coll.entries.get(k) ?? null;
    }

    const colMethod = this.tryCollectionMethodExpr(name, args, scope);
    if (colMethod.handled) return colMethod.value;

    const ct = scope.findCollectionType(up);
    if (ct) {
      const coll = new PlsqlCollection(up, ct.form === 'varray' ? 'varray' : 'table', ct.limit);
      args.forEach((a, idx) => coll.entries.set(idx + 1, this.evalExpr(a.value, scope) as PlsqlValue));
      return coll;
    }

    const local = scope.findSubprogram(up);
    if (local && local.decl.isFunction) {
      return this.callLocalSubprogram(local.decl, local.scope, args, scope);
    }

    const evaluated = () => args.map(a => this.evalExpr(a.value, scope));
    const builtin = this.callBuiltinFunction(up, args, scope);
    if (builtin.handled) return builtin.value;

    const unit = this.host.lookupUnit(up);
    if (unit && unit.type === 'FUNCTION') {
      return this.callStoredUnit(unit, args, scope);
    }

    const argLits = evaluated().map(v => this.toSqlLiteral(v)).join(', ');
    const r = this.host.runSql(`SELECT ${up}(${argLits}) FROM DUAL`);
    if (r.isQuery && r.rows.length) return r.rows[0][0];
    throw new PlsqlException('USER_DEFINED', 6550, `PLS-00201: identifier '${up}' must be declared`);
  }

  private tryCollectionMethodExpr(name: string, args: CallArg[], scope: Scope): { handled: boolean; value: PlsqlValue } {
    const dot = name.lastIndexOf('.');
    if (dot < 0) return { handled: false, value: null };
    const baseName = name.substring(0, dot);
    const method = name.substring(dot + 1).toUpperCase();
    const slot = scope.findSlot(baseName);
    if (!slot || !(slot.value instanceof PlsqlCollection)) return { handled: false, value: null };
    const coll = slot.value;
    switch (method) {
      case 'COUNT': return { handled: true, value: coll.count() };
      case 'FIRST': return { handled: true, value: coll.first() };
      case 'LAST': return { handled: true, value: coll.last() };
      case 'LIMIT': return { handled: true, value: coll.limit };
      case 'EXISTS': return { handled: true, value: coll.exists(Number(this.evalExpr(args[0].value, scope))) };
      case 'NEXT': return { handled: true, value: coll.next(Number(this.evalExpr(args[0].value, scope))) };
      case 'PRIOR': return { handled: true, value: coll.prior(Number(this.evalExpr(args[0].value, scope))) };
    }
    return { handled: false, value: null };
  }

  private callBuiltinFunction(up: string, args: CallArg[], scope: Scope): { handled: boolean; value: PlsqlValue } {
    const ev = (i: number) => this.evalExpr(args[i].value, scope);
    const num = (i: number) => Number(ev(i));
    const str = (i: number) => { const v = ev(i); return v === null ? null : this.toText(v); };
    const h = (value: PlsqlValue) => ({ handled: true, value });
    switch (up) {
      case 'NVL': { const a = ev(0); return h(a === null ? ev(1) : a); }
      case 'NVL2': return h(ev(0) !== null ? ev(1) : ev(2));
      case 'COALESCE': { for (let i = 0; i < args.length; i++) { const v = ev(i); if (v !== null) return h(v); } return h(null); }
      case 'NULLIF': { const a = ev(0); const b = ev(1); return h(this.eq(a, b) ? null : a); }
      case 'DECODE': {
        const sel = ev(0);
        let i = 1;
        for (; i + 1 < args.length; i += 2) { if (this.eq(sel, ev(i))) return h(ev(i + 1)); }
        return h(i < args.length ? ev(i) : null);
      }
      case 'GREATEST': { let best = ev(0); for (let i = 1; i < args.length; i++) { const v = ev(i); if (best === null || v === null) { best = null; } else if (this.cmp(v, best) > 0) best = v; } return h(best); }
      case 'LEAST': { let best = ev(0); for (let i = 1; i < args.length; i++) { const v = ev(i); if (best === null || v === null) { best = null; } else if (this.cmp(v, best) < 0) best = v; } return h(best); }
      case 'ABS': return h(this.nz(args, scope, 0, v => Math.abs(v)));
      case 'SIGN': return h(this.nz(args, scope, 0, v => Math.sign(v)));
      case 'SQRT': return h(this.nz(args, scope, 0, v => Math.sqrt(v)));
      case 'FLOOR': return h(this.nz(args, scope, 0, v => Math.floor(v)));
      case 'CEIL': return h(this.nz(args, scope, 0, v => Math.ceil(v)));
      case 'POWER': return h(Math.pow(num(0), num(1)));
      case 'MOD': { const b = num(1); return h(b === 0 ? num(0) : num(0) % b); }
      case 'REMAINDER': { const b = num(1); return h(b === 0 ? null : num(0) - Math.round(num(0) / b) * b); }
      case 'ROUND': {
        if (ev(0) instanceof Date) return { handled: false, value: null };
        const d = args.length > 1 ? num(1) : 0; const f = Math.pow(10, d); return h(Math.round(num(0) * f) / f);
      }
      case 'TRUNC': {
        if (ev(0) instanceof Date) return { handled: false, value: null };
        const d = args.length > 1 ? num(1) : 0; const f = Math.pow(10, d); return h(Math.trunc(num(0) * f) / f);
      }
      case 'LENGTH': { const s = str(0); return h(s === null ? null : s.length); }
      case 'UPPER': { const s = str(0); return h(s === null ? null : s.toUpperCase()); }
      case 'LOWER': { const s = str(0); return h(s === null ? null : s.toLowerCase()); }
      case 'INITCAP': { const s = str(0); return h(s === null ? null : s.replace(/\w\S*/g, t => t.charAt(0).toUpperCase() + t.substr(1).toLowerCase())); }
      case 'LTRIM': { const s = str(0); if (s === null) return h(null); const set = args.length > 1 ? str(1)! : ' '; return h(this.trimSet(s, set, true, false)); }
      case 'RTRIM': { const s = str(0); if (s === null) return h(null); const set = args.length > 1 ? str(1)! : ' '; return h(this.trimSet(s, set, false, true)); }
      case 'TRIM': { const s = str(0); return h(s === null ? null : s.trim()); }
      case 'LPAD': { const s = str(0) ?? ''; const len = num(1); const pad = args.length > 2 ? (str(2) ?? ' ') : ' '; return h(this.pad(s, len, pad, true)); }
      case 'RPAD': { const s = str(0) ?? ''; const len = num(1); const pad = args.length > 2 ? (str(2) ?? ' ') : ' '; return h(this.pad(s, len, pad, false)); }
      case 'REPLACE': { const s = str(0); if (s === null) return h(null); const from = str(1) ?? ''; const to = args.length > 2 ? (str(2) ?? '') : ''; return h(from === '' ? s : s.split(from).join(to)); }
      case 'SUBSTR': {
        const s = str(0); if (s === null) return h(null);
        let start = num(1); const hasLen = args.length > 2;
        const len = hasLen ? num(2) : undefined;
        if (start === 0) start = 1;
        let idx = start > 0 ? start - 1 : s.length + start;
        if (idx < 0) idx = 0;
        return h(hasLen ? s.substr(idx, len) : s.substring(idx));
      }
      case 'INSTR': {
        const s = str(0); const sub = str(1);
        if (s === null || sub === null) return h(null);
        const start = args.length > 2 ? num(2) : 1;
        return h(s.indexOf(sub, start - 1) + 1);
      }
      case 'CONCAT': { const a = str(0) ?? ''; const b = str(1) ?? ''; return h(a + b); }
      case 'CHR': return h(String.fromCharCode(num(0)));
      case 'ASCII': { const s = str(0); return h(s && s.length ? s.charCodeAt(0) : null); }
      case 'TO_CHAR': {
        const v = ev(0);
        if (v === null) return h(null);
        if (v instanceof Date) return { handled: false, value: null };
        if (args.length > 1) return { handled: false, value: null };
        return h(typeof v === 'number' ? String(v) : this.toText(v));
      }
      case 'TO_NUMBER': { const v = ev(0); if (v === null) return h(null); const n = Number(v); if (isNaN(n)) throw new PlsqlException('INVALID_NUMBER', 1722, 'ORA-01722: invalid number'); return h(n); }
      case 'SQLCODE': return h(this.sqlcode);
      case 'SQLERRM': { if (args.length) { const c = num(0); const pre = matchPredefinedException(`ORA-${String(Math.abs(c)).padStart(5, '0')}`); return h(pre ? pre.defaultMessage : `ORA-${String(Math.abs(c)).padStart(5, '0')}: Message ${Math.abs(c)} not found`); } return h(this.sqlerrm); }
      case 'SYSDATE': case 'CURRENT_DATE': return h(new Date());
      case 'USER': return h(this.host.currentSchema());
      case 'MOD2': return { handled: false, value: null };
    }
    return { handled: false, value: null };
  }

  private nz(args: CallArg[], scope: Scope, i: number, fn: (v: number) => number): PlsqlValue {
    const v = this.evalExpr(args[i].value, scope);
    if (v === null) return null;
    return fn(Number(v));
  }

  private trimSet(s: string, set: string, left: boolean, right: boolean): string {
    const chars = new Set(set.split(''));
    let a = 0; let b = s.length;
    if (left) while (a < b && chars.has(s[a])) a++;
    if (right) while (b > a && chars.has(s[b - 1])) b--;
    return s.substring(a, b);
  }

  private pad(s: string, len: number, pad: string, left: boolean): string {
    if (s.length >= len) return s.substring(0, len);
    if (!pad) return s;
    let fill = '';
    while (fill.length < len - s.length) fill += pad;
    fill = fill.substring(0, len - s.length);
    return left ? fill + s : s + fill;
  }

  private evalBinary(op: string, leftE: Expr, rightE: Expr, scope: Scope): PlsqlValue {
    if (op === 'AND') {
      const l = this.evalExpr(leftE, scope);
      if (l === false) return false;
      const r = this.evalExpr(rightE, scope);
      if (l === null || r === null) return r === false || l === false ? false : null;
      return this.truth(l) && this.truth(r);
    }
    if (op === 'OR') {
      const l = this.evalExpr(leftE, scope);
      if (l === true) return true;
      const r = this.evalExpr(rightE, scope);
      if (l === null || r === null) return r === true || l === true ? true : null;
      return this.truth(l) || this.truth(r);
    }
    const l = this.evalExpr(leftE, scope);
    const r = this.evalExpr(rightE, scope);
    if (op === '||') {
      const ls = l === null ? '' : this.toText(l);
      const rs = r === null ? '' : this.toText(r);
      return ls + rs;
    }
    if (['=', '<>', '!=', '<', '>', '<=', '>='].includes(op)) {
      if (l === null || r === null) return null;
      const c = this.cmp(l, r);
      switch (op) {
        case '=': return c === 0;
        case '<>': case '!=': return c !== 0;
        case '<': return c < 0;
        case '>': return c > 0;
        case '<=': return c <= 0;
        case '>=': return c >= 0;
      }
    }
    if (l === null || r === null) return null;
    const ln = Number(l); const rn = Number(r);
    switch (op) {
      case '+': return ln + rn;
      case '-': return ln - rn;
      case '*': return ln * rn;
      case '/': if (rn === 0) throw new PlsqlException('ZERO_DIVIDE', 1476, 'ORA-01476: divisor is equal to zero'); return ln / rn;
      case 'MOD': return rn === 0 ? ln : ln % rn;
      case '**': return Math.pow(ln, rn);
    }
    return null;
  }

  private cmp(a: PlsqlValue, b: PlsqlValue): number {
    if (a instanceof Date || b instanceof Date) {
      const ta = a instanceof Date ? a.getTime() : new Date(String(a)).getTime();
      const tb = b instanceof Date ? b.getTime() : new Date(String(b)).getTime();
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    }
    if (typeof a === 'number' || typeof b === 'number') {
      const na = Number(a); const nb = Number(b);
      if (!isNaN(na) && !isNaN(nb)) return na < nb ? -1 : na > nb ? 1 : 0;
    }
    const sa = this.toText(a); const sb = this.toText(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  }

  private eq(a: PlsqlValue, b: PlsqlValue): boolean {
    if (a === null || b === null) return false;
    return this.cmp(a, b) === 0;
  }

  private truth(v: PlsqlValue): boolean {
    return v === true;
  }

  private likeMatch(s: string, pattern: string): boolean {
    let re = '';
    for (const ch of pattern) {
      if (ch === '%') re += '[\\s\\S]*';
      else if (ch === '_') re += '[\\s\\S]';
      else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(`^${re}$`).test(s);
  }

  private toText(v: PlsqlValue): string {
    if (v === null) return '';
    if (v === true) return 'TRUE';
    if (v === false) return 'FALSE';
    if (v instanceof Date) return v.toISOString();
    if (typeof v === 'number') return this.numberToText(v);
    return String(v);
  }

  private numberToText(n: number): string {
    if (Number.isInteger(n)) return String(n);
    return String(n);
  }

  private toSqlLiteral(v: PlsqlValue): string {
    if (v === null) return 'NULL';
    if (typeof v === 'number') return String(v);
    if (typeof v === 'boolean') return v ? '1' : '0';
    if (v instanceof Date) return `TO_DATE('${v.toISOString().slice(0, 19).replace('T', ' ')}','YYYY-MM-DD HH24:MI:SS')`;
    if (v instanceof PlsqlRecord || v instanceof PlsqlCollection) return 'NULL';
    return `'${String(v).replace(/'/g, "''")}'`;
  }

  private interpolateBinds(sql: string, scope: Scope): string {
    let out = '';
    let i = 0;
    const n = sql.length;
    while (i < n) {
      const c = sql[i];
      if (c === "'") {
        out += c; i++;
        while (i < n) {
          out += sql[i];
          if (sql[i] === "'") {
            if (sql[i + 1] === "'") { out += sql[i + 1]; i += 2; continue; }
            i++; break;
          }
          i++;
        }
        continue;
      }
      if (c === ':') {
        let j = i + 1;
        let name = '';
        while (j < n && /[A-Za-z0-9_]/.test(sql[j])) { name += sql[j]; j++; }
        const slot = scope.findSlot(name);
        out += slot ? this.toSqlLiteral(slot.value) : sql.substring(i, j);
        i = j;
        continue;
      }
      if (/[A-Za-z_]/.test(c) && sql[i - 1] !== '.') {
        let j = i;
        let name = '';
        while (j < n && /[A-Za-z0-9_$#]/.test(sql[j])) { name += sql[j]; j++; }
        let k = j;
        while (k < n && (sql[k] === ' ' || sql[k] === '\t')) k++;
        const isQualifier = sql[k] === '.';
        const isCall = sql[k] === '(';
        const slot = scope.findSlot(name);
        if (slot && !isQualifier && !isCall && !this.isSqlKeyword(name)) {
          out += this.toSqlLiteral(slot.value);
          i = j;
          continue;
        }
        // Collection element reference in embedded SQL — `v_ids(i)` inside
        // a FORALL/FOR body. The subscript is a PL/SQL expression evaluated
        // here; the resolved element is inlined as a SQL literal.
        if (slot && isCall && slot.value instanceof PlsqlCollection && !this.isSqlKeyword(name)) {
          const open = k;
          let depth = 0; let m = open;
          while (m < n) {
            if (sql[m] === '(') depth++;
            else if (sql[m] === ')') { depth--; if (depth === 0) break; }
            m++;
          }
          if (m < n) {
            try {
              const idxExpr = PlsqlParser.parseExpression(sql.substring(open + 1, m));
              const idx = Number(this.evalExpr(idxExpr, scope));
              const coll = slot.value;
              if (!coll.entries.has(idx)) {
                throw new PlsqlException('SUBSCRIPT_BEYOND_COUNT', 6533, 'ORA-06533: Subscript beyond count');
              }
              out += this.toSqlLiteral(coll.entries.get(idx) ?? null);
              i = m + 1;
              continue;
            } catch (e) {
              if (e instanceof PlsqlException) throw e;
              // Unparseable subscript: leave the text for the SQL engine.
            }
          }
        }
        out += name;
        i = j;
        continue;
      }
      out += c;
      i++;
    }
    return out;
  }

  private isSqlKeyword(w: string): boolean {
    return SQL_KEYWORDS.has(w.toUpperCase());
  }
}

export { cloneValue };
