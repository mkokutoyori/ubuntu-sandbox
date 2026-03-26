/**
 * OracleParser — SQL parser for Oracle dialect.
 *
 * Extends BaseParser with Oracle-specific syntax:
 *   - CONNECT BY / START WITH (hierarchical queries)
 *   - STARTUP / SHUTDOWN
 *   - ALTER SYSTEM / ALTER DATABASE
 *   - CREATE TABLESPACE
 *   - Oracle outer join (+)
 */

import { TokenType } from '../engine/lexer/Token';
import { BaseParser } from '../engine/parser/BaseParser';
import type {
  Statement, ConnectByClause, StartupStatement, ShutdownStatement,
  AlterSystemStatement, AlterDatabaseStatement,
  CreateTablespaceStatement, DropTablespaceStatement,
  MergeStatement, Expression, SetTransactionStatement,
  AuditStatement, NoauditStatement,
} from '../engine/parser/ASTNode';
import type { SourcePosition } from '../engine/lexer/Token';

export class OracleParser extends BaseParser {

  // ── PRIOR as unary operator ──────────────────────────────────────

  protected override parseUnary(): Expression {
    if (this.checkKeyword('PRIOR')) {
      const pos = this.current().position;
      this.advance();
      const operand = this.parseUnary();
      return { type: 'UnaryExpr', position: pos, operator: 'PRIOR', operand };
    }
    return super.parseUnary();
  }

  // ── CONNECT BY / START WITH ───────────────────────────────────────

  protected override parseConnectByClause(): ConnectByClause | null {
    const pos = this.current().position;

    if (this.matchKeyword('START')) {
      this.expectKeyword('WITH');
      const startWith = this.parseExpression();
      this.expectKeyword('CONNECT');
      this.expectKeyword('BY');
      const noCycle = this.matchKeyword('NOCYCLE');
      const condition = this.parseExpression();
      return { type: 'ConnectByClause', position: pos, condition, noCycle, startWith };
    }

    if (this.matchKeyword('CONNECT')) {
      this.expectKeyword('BY');
      const noCycle = this.matchKeyword('NOCYCLE');
      const condition = this.parseExpression();
      let startWith = undefined;
      if (this.matchKeyword('START')) {
        this.expectKeyword('WITH');
        startWith = this.parseExpression();
      }
      return { type: 'ConnectByClause', position: pos, condition, noCycle, startWith };
    }

    return null;
  }

  // ── Dialect-specific statements ───────────────────────────────────

  protected override parseDialectStatement(): Statement | null {
    const token = this.current();
    if (token.type !== TokenType.KEYWORD) return null;

    switch (token.value) {
      case 'STARTUP': return this.parseStartup();
      case 'SHUTDOWN': return this.parseShutdown();
      case 'MERGE': return this.parseMerge();
      case 'EXPLAIN': return this.parseExplainPlan();
      case 'AUDIT': return this.parseAudit();
      case 'NOAUDIT': return this.parseNoaudit();
    }
    return null;
  }

  // ── MERGE ────────────────────────────────────────────────────────

  private parseMerge(): MergeStatement {
    const pos = this.current().position;
    this.expectKeyword('MERGE');
    this.expectKeyword('INTO');

    // Target table
    const targetSchema = this.parseSchemaPrefix();
    const targetName = this.expectIdentifier();
    const targetAlias = this.parseOptionalAlias();
    const target = {
      type: 'TableRef' as const, position: pos,
      schema: targetSchema, name: targetName, alias: targetAlias,
    };

    this.expectKeyword('USING');
    const sourceSchema = this.parseSchemaPrefix();
    const sourceName = this.expectIdentifier();
    const sourceAlias = this.parseOptionalAlias();
    const source = {
      type: 'TableRef' as const, position: pos,
      schema: sourceSchema, name: sourceName, alias: sourceAlias,
    };

    this.expectKeyword('ON');
    this.expect(TokenType.LPAREN);
    const on = this.parseExpression();
    this.expect(TokenType.RPAREN);

    let whenMatched: MergeStatement['whenMatched'];
    let whenNotMatched: MergeStatement['whenNotMatched'];

    // WHEN MATCHED / WHEN NOT MATCHED (in any order)
    for (let i = 0; i < 2; i++) {
      if (!this.checkKeyword('WHEN')) break;
      this.advance(); // WHEN

      if (this.matchKeyword('MATCHED')) {
        this.expectKeyword('THEN');
        this.expectKeyword('UPDATE');
        this.expectKeyword('SET');

        const assignments: import('../engine/parser/ASTNode').Assignment[] = [];
        do {
          // Parse qualified column: t.col = s.col or col = value
          let colName: string;
          const id1 = this.expectIdentifier();
          if (this.match(TokenType.DOT)) {
            colName = this.expectIdentifier();
          } else {
            colName = id1;
          }
          this.expect(TokenType.COMPARISON_OP, '=');
          const value = this.parseExpression();
          assignments.push({ type: 'Assignment', position: pos, column: colName, value });
        } while (this.match(TokenType.COMMA));

        whenMatched = { assignments };
      } else if (this.matchKeyword('NOT')) {
        this.expectKeyword('MATCHED');
        this.expectKeyword('THEN');
        this.expectKeyword('INSERT');

        this.expect(TokenType.LPAREN);
        const columns: string[] = [];
        do { columns.push(this.expectIdentifier()); } while (this.match(TokenType.COMMA));
        this.expect(TokenType.RPAREN);

        this.expectKeyword('VALUES');
        this.expect(TokenType.LPAREN);
        const values: Expression[] = [];
        do { values.push(this.parseExpression()); } while (this.match(TokenType.COMMA));
        this.expect(TokenType.RPAREN);

        whenNotMatched = { columns, values };
      }
    }

    return { type: 'MergeStatement', position: pos, target, source, on, whenMatched, whenNotMatched };
  }

  private parseSchemaPrefix(): string | undefined {
    // Look ahead for schema.name pattern
    if (this.check(TokenType.IDENTIFIER) && this.peekNext()?.type === TokenType.DOT) {
      const schema = this.advance().value;
      this.advance(); // consume .
      return schema;
    }
    return undefined;
  }

  private parseOptionalAlias(): string | undefined {
    // Check for alias (optional AS keyword)
    if (this.checkKeyword('ON') || this.checkKeyword('USING') || this.checkKeyword('WHEN') ||
        this.check(TokenType.SEMICOLON) || this.check(TokenType.EOF) ||
        this.check(TokenType.LPAREN)) {
      return undefined;
    }
    if (this.matchKeyword('AS')) {
      return this.expectIdentifier();
    }
    if (this.check(TokenType.IDENTIFIER)) {
      return this.advance().value;
    }
    return undefined;
  }

  protected override parseDialectCreate(pos: SourcePosition, orReplace: boolean): Statement | null {
    if (this.matchKeyword('TABLESPACE')) return this.parseCreateTablespace(pos);
    if (this.matchKeyword('TEMPORARY')) {
      this.expectKeyword('TABLESPACE');
      return this.parseCreateTablespace(pos, true);
    }
    if (this.matchKeyword('UNDO')) {
      this.expectKeyword('TABLESPACE');
      return this.parseCreateTablespace(pos, false, true);
    }
    if (this.matchKeyword('TRIGGER')) return this.parseCreateTrigger(pos, orReplace);
    if (this.matchKeyword('SYNONYM')) return this.parseCreateSynonym(pos, orReplace, false);
    if (this.matchKeyword('PUBLIC')) {
      if (this.matchKeyword('SYNONYM')) return this.parseCreateSynonym(pos, orReplace, true);
      if (this.matchKeyword('DATABASE')) { this.expectKeyword('LINK'); return this.parseCreateDbLink(pos, true); }
    }
    if (this.matchKeyword('DATABASE')) { this.expectKeyword('LINK'); return this.parseCreateDbLink(pos, false); }
    if (this.matchKeyword('MATERIALIZED')) { this.expectKeyword('VIEW'); return this.parseCreateMaterializedView(pos, orReplace); }
    return null;
  }

  protected override parseDialectAlter(pos: SourcePosition): Statement | null {
    if (this.matchKeyword('SYSTEM')) return this.parseAlterSystem(pos);
    if (this.matchKeyword('DATABASE')) return this.parseAlterDatabase(pos);
    if (this.matchKeyword('SEQUENCE')) return this.parseAlterSequence(pos);
    if (this.matchKeyword('INDEX')) return this.parseAlterIndex(pos);
    return null;
  }

  protected override parseDialectDrop(pos: SourcePosition): Statement | null {
    if (this.matchKeyword('TABLESPACE')) return this.parseDropTablespace(pos);
    if (this.matchKeyword('TRIGGER')) {
      const schema = this.parseSchemaPrefix();
      const name = this.expectIdentifier();
      return { type: 'DropTriggerStatement', position: pos, schema, name } as import('../engine/parser/ASTNode').DropTriggerStatement;
    }
    if (this.matchKeyword('SYNONYM')) {
      const schema = this.parseSchemaPrefix();
      const name = this.expectIdentifier();
      return { type: 'DropSynonymStatement', position: pos, isPublic: false, schema, name } as import('../engine/parser/ASTNode').DropSynonymStatement;
    }
    if (this.matchKeyword('PUBLIC')) {
      if (this.matchKeyword('SYNONYM')) {
        const name = this.expectIdentifier();
        return { type: 'DropSynonymStatement', position: pos, isPublic: true, name } as import('../engine/parser/ASTNode').DropSynonymStatement;
      }
      if (this.matchKeyword('DATABASE')) {
        this.expectKeyword('LINK');
        const name = this.expectIdentifier();
        return { type: 'DropDbLinkStatement', position: pos, isPublic: true, name } as any;
      }
    }
    if (this.matchKeyword('DATABASE')) {
      this.expectKeyword('LINK');
      const name = this.expectIdentifier();
      return { type: 'DropDbLinkStatement', position: pos, isPublic: false, name } as any;
    }
    if (this.matchKeyword('MATERIALIZED')) {
      this.expectKeyword('VIEW');
      const schema = this.parseSchemaPrefix();
      const name = this.expectIdentifier();
      return { type: 'DropMaterializedViewStatement', position: pos, schema, name } as any;
    }
    return null;
  }

  // ── STARTUP ───────────────────────────────────────────────────────

  private parseStartup(): StartupStatement {
    const pos = this.current().position;
    this.expectKeyword('STARTUP');
    let mode: StartupStatement['mode'];
    if (this.matchKeyword('NOMOUNT')) mode = 'NOMOUNT';
    else if (this.matchKeyword('MOUNT')) mode = 'MOUNT';
    else if (this.matchKeyword('RESTRICT')) mode = 'RESTRICT';
    else if (this.matchKeyword('FORCE')) mode = 'FORCE';
    return { type: 'StartupStatement', position: pos, mode };
  }

  // ── SHUTDOWN ──────────────────────────────────────────────────────

  private parseShutdown(): ShutdownStatement {
    const pos = this.current().position;
    this.expectKeyword('SHUTDOWN');
    let mode: ShutdownStatement['mode'];
    if (this.matchKeyword('IMMEDIATE')) mode = 'IMMEDIATE';
    else if (this.matchKeyword('ABORT')) mode = 'ABORT';
    else if (this.matchKeyword('TRANSACTIONAL')) mode = 'TRANSACTIONAL';
    else if (this.matchKeyword('NORMAL')) mode = 'NORMAL';
    return { type: 'ShutdownStatement', position: pos, mode };
  }

  // ── ALTER SYSTEM ──────────────────────────────────────────────────

  private parseAlterSystem(pos: SourcePosition): AlterSystemStatement {
    // ALTER SYSTEM SET param = value [SCOPE = ...]
    // ALTER SYSTEM FLUSH SHARED_POOL / BUFFER_CACHE
    // ALTER SYSTEM SWITCH LOGFILE
    // ALTER SYSTEM CHECKPOINT
    if (this.matchKeyword('SET')) {
      const parameter = this.expectIdentifier();
      this.expect(TokenType.COMPARISON_OP, '=');
      // Value can be string, number, or identifier
      let value: string;
      if (this.check(TokenType.STRING_LITERAL)) {
        const raw = this.advance().value;
        value = raw.slice(1, -1);
      } else if (this.check(TokenType.NUMBER_LITERAL)) {
        value = this.advance().value;
      } else {
        value = this.expectIdentifier();
      }
      let scope: AlterSystemStatement['scope'];
      if (this.matchKeyword('SCOPE')) {
        this.expect(TokenType.COMPARISON_OP, '=');
        const s = this.expectIdentifier().toUpperCase();
        if (s === 'MEMORY' || s === 'SPFILE' || s === 'BOTH') scope = s;
      }
      return { type: 'AlterSystemStatement', position: pos, action: 'SET', parameter, value, scope };
    }
    if (this.matchKeyword('FLUSH')) {
      const target = this.expectIdentifier();
      return { type: 'AlterSystemStatement', position: pos, action: 'FLUSH', parameter: target };
    }
    if (this.matchKeyword('SWITCH')) {
      this.expectKeyword('LOGFILE');
      return { type: 'AlterSystemStatement', position: pos, action: 'SWITCH LOGFILE' };
    }
    if (this.matchKeyword('CHECKPOINT')) {
      return { type: 'AlterSystemStatement', position: pos, action: 'CHECKPOINT' };
    }
    throw this.error('Unsupported ALTER SYSTEM action');
  }

  // ── ALTER DATABASE ────────────────────────────────────────────────

  private parseAlterDatabase(pos: SourcePosition): AlterDatabaseStatement {
    if (this.matchKeyword('OPEN')) {
      const readOnly = this.matchKeyword('READ') ? (this.expectKeyword('ONLY'), true) : false;
      return { type: 'AlterDatabaseStatement', position: pos, action: 'OPEN', details: readOnly ? 'READ ONLY' : undefined };
    }
    if (this.matchKeyword('MOUNT')) {
      return { type: 'AlterDatabaseStatement', position: pos, action: 'MOUNT' };
    }
    if (this.matchKeyword('ARCHIVELOG')) {
      return { type: 'AlterDatabaseStatement', position: pos, action: 'ARCHIVELOG' };
    }
    if (this.matchKeyword('NOARCHIVELOG')) {
      return { type: 'AlterDatabaseStatement', position: pos, action: 'NOARCHIVELOG' };
    }
    // Generic fallback
    let action = '';
    while (!this.check(TokenType.SEMICOLON) && !this.check(TokenType.EOF)) {
      action += this.advance().value + ' ';
    }
    return { type: 'AlterDatabaseStatement', position: pos, action: action.trim() };
  }

  // ── CREATE TABLESPACE ─────────────────────────────────────────────

  private parseCreateTablespace(pos: SourcePosition, temporary: boolean = false, undo: boolean = false): CreateTablespaceStatement {
    const name = this.expectIdentifier();
    const fileKeyword = temporary ? 'TEMPFILE' : 'DATAFILE';
    let datafile = '';
    let size = '';
    let autoextend: CreateTablespaceStatement['autoextend'];

    if (this.matchKeyword(fileKeyword)) {
      if (this.check(TokenType.STRING_LITERAL)) {
        const raw = this.advance().value;
        datafile = raw.slice(1, -1);
      }
      if (this.matchKeyword('SIZE')) {
        size = this.advance().value;
        // Allow size suffixes: 100M, 2G, etc.
        if (this.check(TokenType.IDENTIFIER)) size += this.advance().value;
      }
      if (this.matchKeyword('AUTOEXTEND')) {
        if (this.matchKeyword('ON')) {
          let next: string | undefined;
          let maxSize: string | undefined;
          if (this.matchKeyword('NEXT')) {
            next = this.advance().value;
            if (this.check(TokenType.IDENTIFIER)) next += this.advance().value;
          }
          if (this.matchKeyword('MAXSIZE')) {
            if (this.matchKeyword('UNLIMITED')) maxSize = 'UNLIMITED';
            else {
              maxSize = this.advance().value;
              if (this.check(TokenType.IDENTIFIER)) maxSize += this.advance().value;
            }
          }
          autoextend = { on: true, next, maxSize };
        } else {
          this.matchKeyword('OFF');
          autoextend = { on: false };
        }
      }
    }

    // Consume remaining clauses (EXTENT MANAGEMENT, SEGMENT SPACE, etc.) — skip for now
    while (!this.check(TokenType.SEMICOLON) && !this.check(TokenType.EOF)) {
      this.advance();
    }

    return {
      type: 'CreateTablespaceStatement', position: pos,
      name, temporary: temporary || undefined, undo: undo || undefined,
      datafile, size, autoextend,
    };
  }

  // ── DROP TABLESPACE ───────────────────────────────────────────────

  private parseDropTablespace(pos: SourcePosition): DropTablespaceStatement {
    const name = this.expectIdentifier();
    let includeContents = false;
    let includeDatafiles = false;
    if (this.matchKeyword('INCLUDING')) {
      this.expectKeyword('CONTENTS');
      includeContents = true;
      if (this.matchKeyword('AND')) {
        this.expectKeyword('DATAFILES');
        includeDatafiles = true;
      }
    }
    return {
      type: 'DropTablespaceStatement', position: pos, name,
      includeContents: includeContents || undefined,
      includeDatafiles: includeDatafiles || undefined,
    };
  }

  // ── CREATE TRIGGER ─────────────────────────────────────────────────

  private parseCreateTrigger(pos: import('../engine/lexer/Token').SourcePosition, orReplace?: boolean): import('../engine/parser/ASTNode').CreateTriggerStatement {
    const schema = this.parseSchemaPrefix();
    const name = this.expectIdentifier();

    // Timing: BEFORE | AFTER | INSTEAD OF
    let timing: 'BEFORE' | 'AFTER' | 'INSTEAD OF';
    if (this.matchKeyword('BEFORE')) {
      timing = 'BEFORE';
    } else if (this.matchKeyword('AFTER')) {
      timing = 'AFTER';
    } else if (this.matchKeyword('INSTEAD')) {
      this.expectKeyword('OF');
      timing = 'INSTEAD OF';
    } else {
      throw this.error('Expected BEFORE, AFTER, or INSTEAD OF');
    }

    // Events: INSERT | UPDATE | DELETE (separated by OR)
    const events: Array<'INSERT' | 'UPDATE' | 'DELETE'> = [];
    do {
      if (this.matchKeyword('INSERT')) events.push('INSERT');
      else if (this.matchKeyword('UPDATE')) events.push('UPDATE');
      else if (this.matchKeyword('DELETE')) events.push('DELETE');
      else throw this.error('Expected INSERT, UPDATE, or DELETE');
    } while (this.matchKeyword('OR'));

    // ON table
    this.expectKeyword('ON');
    const tableSchema = this.parseSchemaPrefix();
    const tableName = this.expectIdentifier();

    // Optional: FOR EACH ROW
    let forEachRow = false;
    if (this.matchKeyword('FOR')) {
      this.expectKeyword('EACH');
      this.expectKeyword('ROW');
      forEachRow = true;
    }

    // Optional: WHEN (condition) - skip for now, consume as string
    let whenCondition: string | undefined;
    if (this.matchKeyword('WHEN')) {
      // Consume everything in parens
      this.expect(TokenType.LPAREN);
      let depth = 1;
      const parts: string[] = [];
      while (depth > 0 && !this.check(TokenType.EOF) && !this.check(TokenType.SEMICOLON)) {
        if (this.check(TokenType.LPAREN)) depth++;
        if (this.check(TokenType.RPAREN)) depth--;
        if (depth > 0) parts.push(this.advance().value);
        else this.advance(); // consume closing paren
      }
      whenCondition = parts.join(' ');
    }

    // Body: everything from BEGIN/DECLARE to END; (or just a single PL/SQL statement)
    // Consume all remaining tokens as body text
    const bodyParts: string[] = [];
    while (!this.check(TokenType.EOF) && !this.check(TokenType.SEMICOLON)) {
      bodyParts.push(this.advance().value);
    }
    const body = bodyParts.join(' ');

    return {
      type: 'CreateTriggerStatement', position: pos,
      orReplace, schema, name, timing, events,
      tableName, tableSchema,
      forEachRow, whenCondition, body,
    };
  }

  // ── EXPLAIN PLAN ──────────────────────────────────────────────────

  private parseExplainPlan(): import('../engine/parser/ASTNode').ExplainPlanStatement {
    const pos = this.current().position;
    this.expectKeyword('EXPLAIN');
    this.expectKeyword('PLAN');

    let statementId: string | undefined;
    if (this.matchKeyword('SET')) {
      this.expectKeyword('STATEMENT_ID');
      // Consume '=' (tokenized as COMPARISON_OP)
      if (this.current().type === TokenType.COMPARISON_OP && this.current().value === '=') {
        this.advance();
      }
      const tok = this.current();
      if (tok.type === TokenType.STRING_LITERAL) {
        statementId = tok.value;
        this.advance();
      }
    }

    let targetTable: string | undefined;
    if (this.matchKeyword('INTO')) {
      targetTable = this.expectIdentifier();
    }

    this.expectKeyword('FOR');

    // Parse the inner statement (SELECT, INSERT, UPDATE, DELETE)
    const statement = this.parseStatement();

    return {
      type: 'ExplainPlanStatement', position: pos,
      statementId, targetTable, statement,
    };
  }

  // ── CREATE SYNONYM ─────────────────────────────────────────────────

  private parseCreateSynonym(pos: SourcePosition, orReplace: boolean, isPublic: boolean): import('../engine/parser/ASTNode').CreateSynonymStatement {
    const schema = this.parseSchemaPrefix();
    const name = this.expectIdentifier();
    this.expectKeyword('FOR');
    const targetSchema = this.parseSchemaPrefix();
    const targetName = this.expectIdentifier();
    return { type: 'CreateSynonymStatement', position: pos, orReplace: orReplace || undefined, isPublic: isPublic || undefined, schema, name, targetSchema, targetName };
  }

  // ── ALTER SEQUENCE ─────────────────────────────────────────────────

  private parseAlterSequence(pos: SourcePosition): import('../engine/parser/ASTNode').AlterSequenceStatement {
    const schema = this.parseSchemaPrefix();
    const name = this.expectIdentifier();
    const result: import('../engine/parser/ASTNode').AlterSequenceStatement = { type: 'AlterSequenceStatement', position: pos, schema, name };

    while (!this.check(TokenType.SEMICOLON) && !this.check(TokenType.EOF)) {
      if (this.matchKeyword('INCREMENT')) { this.expectKeyword('BY'); result.incrementBy = Number(this.expect(TokenType.NUMBER_LITERAL).value); }
      else if (this.matchKeyword('MINVALUE')) { result.minValue = Number(this.expect(TokenType.NUMBER_LITERAL).value); }
      else if (this.matchKeyword('MAXVALUE')) { result.maxValue = Number(this.expect(TokenType.NUMBER_LITERAL).value); }
      else if (this.matchKeyword('CACHE')) { result.cache = Number(this.expect(TokenType.NUMBER_LITERAL).value); }
      else if (this.matchKeyword('NOCACHE')) { result.cache = 0; }
      else if (this.matchKeyword('CYCLE')) { result.cycle = true; }
      else if (this.matchKeyword('NOCYCLE')) { result.cycle = false; }
      else break;
    }
    return result;
  }

  // ── ALTER INDEX ────────────────────────────────────────────────────

  private parseAlterIndex(pos: SourcePosition): import('../engine/parser/ASTNode').AlterIndexStatement {
    const schema = this.parseSchemaPrefix();
    const name = this.expectIdentifier();
    if (this.matchKeyword('REBUILD')) {
      return { type: 'AlterIndexStatement', position: pos, schema, name, action: 'REBUILD' };
    }
    if (this.matchKeyword('RENAME')) {
      this.expectKeyword('TO');
      const newName = this.expectIdentifier();
      return { type: 'AlterIndexStatement', position: pos, schema, name, action: 'RENAME', newName };
    }
    throw this.error('Expected REBUILD or RENAME after ALTER INDEX');
  }

  // ── CREATE DATABASE LINK (stub) ────────────────────────────────────

  private parseCreateDbLink(pos: SourcePosition, isPublic: boolean): any {
    const name = this.expectIdentifier();
    // Consume CONNECT TO user IDENTIFIED BY password USING 'tns_alias'
    let connectUser: string | undefined;
    let usingAlias: string | undefined;
    if (this.matchKeyword('CONNECT')) {
      this.expectKeyword('TO');
      connectUser = this.expectIdentifier();
      this.expectKeyword('IDENTIFIED');
      this.expectKeyword('BY');
      this.advance(); // skip password
    }
    if (this.matchKeyword('USING')) {
      usingAlias = this.expect(TokenType.STRING_LITERAL).value;
    }
    return { type: 'CreateDbLinkStatement', position: pos, isPublic, name, connectUser, usingAlias };
  }

  // ── CREATE MATERIALIZED VIEW (stub) ────────────────────────────────

  private parseCreateMaterializedView(pos: SourcePosition, _orReplace: boolean): any {
    const schema = this.parseSchemaPrefix();
    const name = this.expectIdentifier();
    // Skip optional BUILD, REFRESH clauses
    while (!this.check(TokenType.EOF) && !this.checkKeyword('AS')) {
      this.advance();
    }
    this.expectKeyword('AS');
    const query = this.parseSelect();
    return { type: 'CreateMaterializedViewStatement', position: pos, schema, name, query };
  }

  // ── AUDIT / NOAUDIT ────────────────────────────────────────────

  private parseAudit(): AuditStatement {
    const pos = this.current().position;
    this.expectKeyword('AUDIT');
    // Parse audit option (multi-word: e.g., CREATE TABLE, SELECT TABLE)
    let auditOption = this.expectIdentifierOrKeyword();
    while (this.check(TokenType.KEYWORD) || this.check(TokenType.IDENTIFIER)) {
      const next = this.current().value.toUpperCase();
      if (['BY', 'WHENEVER'].includes(next)) break;
      auditOption += ' ' + this.advance().value;
    }
    let byUser: string | undefined;
    let byMode: 'ACCESS' | 'SESSION' | undefined;
    if (this.matchKeyword('BY')) {
      const next = this.current().value.toUpperCase();
      if (next === 'ACCESS') {
        this.advance();
        byMode = 'ACCESS';
      } else if (next === 'SESSION') {
        this.advance();
        byMode = 'SESSION';
      } else {
        byUser = this.expectIdentifier();
      }
    }
    if (this.matchKeyword('BY')) {
      const next = this.current().value.toUpperCase();
      if (next === 'ACCESS') { this.advance(); byMode = 'ACCESS'; }
      else if (next === 'SESSION') { this.advance(); byMode = 'SESSION'; }
    }
    return { type: 'AuditStatement', position: pos, auditOption: auditOption.toUpperCase(), byUser: byUser?.toUpperCase(), byMode };
  }

  private parseNoaudit(): NoauditStatement {
    const pos = this.current().position;
    this.expectKeyword('NOAUDIT');
    let auditOption = this.expectIdentifierOrKeyword();
    while (this.check(TokenType.KEYWORD) || this.check(TokenType.IDENTIFIER)) {
      const next = this.current().value.toUpperCase();
      if (['BY', 'WHENEVER'].includes(next)) break;
      auditOption += ' ' + this.advance().value;
    }
    let byUser: string | undefined;
    if (this.matchKeyword('BY')) {
      byUser = this.expectIdentifier();
    }
    return { type: 'NoauditStatement', position: pos, auditOption: auditOption.toUpperCase(), byUser: byUser?.toUpperCase() };
  }
}
