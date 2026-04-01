/**
 * BaseParser — Abstract recursive-descent SQL parser.
 *
 * Consumes tokens produced by a BaseLexer and builds an AST.
 * Handles the universal SQL grammar (SELECT, INSERT, UPDATE, DELETE,
 * basic DDL). Subclasses extend for dialect-specific syntax.
 *
 * Design:
 *   - LL(1) with occasional lookahead for ambiguous constructs.
 *   - Token consumption via expect(), match(), check() helpers.
 *   - Error recovery: throws ParserError with position info.
 */

import { Token, TokenType } from '../lexer/Token';
import { ParserError } from './ParserError';
import type {
  Statement, Expression, SelectStatement, SelectItem, OrderByItem,
  TableRef, JoinClause, TableReference, Assignment,
  InsertStatement, UpdateStatement, DeleteStatement,
  ColumnDefinition, TableConstraint, ColumnConstraint, TypeSpec,
  LiteralExpr, IdentifierExpr, StarExpr, BinaryExpr, UnaryExpr,
  FunctionCallExpr, CaseExpr, SubqueryExpr, IsNullExpr,
  BetweenExpr, InExpr, LikeExpr, ParenExpr, WithClause,
  CTEDefinition, CommitStatement, RollbackStatement, SavepointStatement,
} from './ASTNode';

export abstract class BaseParser {
  protected tokens: Token[] = [];
  protected pos: number = 0;

  /**
   * Parse a list of tokens into a single SQL statement.
   */
  parse(tokens: Token[]): Statement {
    this.tokens = tokens;
    this.pos = 0;
    const stmt = this.parseStatement();
    // Consume optional trailing semicolon
    if (this.check(TokenType.SEMICOLON)) this.advance();
    // Expect EOF
    if (!this.check(TokenType.EOF)) {
      throw this.error(`Unexpected token after statement: ${this.current().value}`);
    }
    return stmt;
  }

  /**
   * Parse multiple statements separated by semicolons.
   */
  parseMultiple(tokens: Token[]): Statement[] {
    this.tokens = tokens;
    this.pos = 0;
    const statements: Statement[] = [];
    while (!this.check(TokenType.EOF)) {
      if (this.check(TokenType.SEMICOLON)) { this.advance(); continue; }
      statements.push(this.parseStatement());
      if (this.check(TokenType.SEMICOLON)) this.advance();
    }
    return statements;
  }

  // ── Statement dispatch ────────────────────────────────────────────

  protected parseStatement(): Statement {
    const token = this.current();

    if (token.type === TokenType.KEYWORD) {
      switch (token.value) {
        case 'SELECT': return this.parseSelect();
        case 'WITH': return this.parseSelect(); // WITH ... SELECT
        case 'INSERT': return this.parseInsert();
        case 'UPDATE': return this.parseUpdate();
        case 'DELETE': return this.parseDelete();
        case 'CREATE': return this.parseCreate();
        case 'ALTER': return this.parseAlter();
        case 'DROP': return this.parseDrop();
        case 'TRUNCATE': return this.parseTruncate();
        case 'GRANT': return this.parseGrant();
        case 'REVOKE': return this.parseRevoke();
        case 'COMMIT': return this.parseCommit();
        case 'ROLLBACK': return this.parseRollback();
        case 'SAVEPOINT': return this.parseSavepoint();
      }
    }

    // Parenthesized SELECT: (SELECT ...) UNION (SELECT ...) etc.
    if (token.type === TokenType.LPAREN) {
      const next = this.peekNext();
      if (next && next.type === TokenType.KEYWORD && (next.value === 'SELECT' || next.value === 'WITH')) {
        this.advance(); // consume (
        const inner = this.parseSelect();
        this.expect(TokenType.RPAREN);
        // Check for set operations (UNION, INTERSECT, MINUS, EXCEPT)
        return this.parseSetOperation(inner);
      }
    }

    // Let dialect handle
    const dialectStmt = this.parseDialectStatement();
    if (dialectStmt) return dialectStmt;

    throw this.error(`Unexpected token: ${token.value}`);
  }

  /**
   * Override to parse dialect-specific statements (e.g., STARTUP, SHUTDOWN).
   */
  protected parseDialectStatement(): Statement | null {
    return null;
  }

  // ── SELECT ────────────────────────────────────────────────────────

  protected parseSelect(): SelectStatement {
    const pos = this.current().position;
    let withClause: WithClause | undefined;

    // WITH clause
    if (this.matchKeyword('WITH')) {
      withClause = this.parseWithClause(pos);
    }

    this.expectKeyword('SELECT');
    const distinct = this.matchKeyword('DISTINCT') || this.matchKeyword('UNIQUE');
    if (!distinct) this.matchKeyword('ALL'); // consume optional ALL

    // Hint (skip it — store for later)
    if (this.check(TokenType.HINT)) this.advance();

    const columns = this.parseSelectList();
    let from: TableReference[] | undefined;
    let joins: JoinClause[] | undefined;
    let where: Expression | undefined;
    let groupBy: Expression[] | undefined;
    let having: Expression | undefined;
    let orderBy: OrderByItem[] | undefined;

    if (this.matchKeyword('FROM')) {
      const result = this.parseFromClause();
      from = result.tables;
      joins = result.joins.length > 0 ? result.joins : undefined;
    }

    if (this.matchKeyword('WHERE')) {
      where = this.parseExpression();
    }

    // Oracle CONNECT BY — handled by dialect
    const connectBy = this.parseConnectByClause();

    if (this.matchKeyword('GROUP')) {
      this.expectKeyword('BY');
      groupBy = this.parseExpressionList();
    }

    if (this.matchKeyword('HAVING')) {
      having = this.parseExpression();
    }

    if (this.matchKeyword('ORDER')) {
      this.expectKeyword('BY');
      orderBy = this.parseOrderByList();
    }

    const fetch = this.parseFetchClause();
    const forUpdate = this.parseForUpdateClause();

    let stmt: SelectStatement = {
      type: 'SelectStatement',
      position: pos,
      withClause,
      distinct: distinct || undefined,
      columns,
      from,
      joins,
      where,
      connectBy: connectBy || undefined,
      groupBy,
      having,
      orderBy,
      fetch: fetch || undefined,
      forUpdate: forUpdate || undefined,
    };

    // Set operations
    stmt = this.parseSetOperation(stmt);

    return stmt;
  }

  protected parseWithClause(pos: import('../lexer/Token').SourcePosition): WithClause {
    const recursive = this.matchKeyword('RECURSIVE');
    const ctes: CTEDefinition[] = [];
    do {
      const cteName = this.expectIdentifier();
      let columns: string[] | undefined;
      if (this.match(TokenType.LPAREN)) {
        columns = [];
        do {
          columns.push(this.expectIdentifier());
        } while (this.match(TokenType.COMMA));
        this.expect(TokenType.RPAREN);
      }
      this.expectKeyword('AS');
      this.expect(TokenType.LPAREN);
      const query = this.parseSelect();
      this.expect(TokenType.RPAREN);
      ctes.push({ type: 'CTEDefinition', position: pos, name: cteName, columns, query });
    } while (this.match(TokenType.COMMA));
    return { type: 'WithClause', position: pos, recursive, ctes };
  }

  protected parseSelectList(): SelectItem[] {
    const items: SelectItem[] = [];
    do {
      items.push(this.parseSelectItem());
    } while (this.match(TokenType.COMMA));
    return items;
  }

  protected parseSelectItem(): SelectItem {
    const pos = this.current().position;

    // table.*
    if (this.check(TokenType.IDENTIFIER) && this.peekNext()?.type === TokenType.DOT && this.peekAt(2)?.type === TokenType.STAR) {
      const table = this.advance().value;
      this.advance(); // .
      this.advance(); // *
      const star: StarExpr = { type: 'Star', position: pos, table };
      return { type: 'SelectItem', position: pos, expr: star };
    }

    // *
    if (this.check(TokenType.STAR)) {
      this.advance();
      const star: StarExpr = { type: 'Star', position: pos };
      return { type: 'SelectItem', position: pos, expr: star };
    }

    const expr = this.parseExpression();
    let alias: string | undefined;
    if (this.matchKeyword('AS')) {
      alias = this.expectIdentifierOrString();
    } else if (this.check(TokenType.IDENTIFIER) && !this.isStatementBoundary()) {
      alias = this.advance().value;
    } else if (this.check(TokenType.QUOTED_IDENTIFIER)) {
      alias = this.advance().value.slice(1, -1); // Remove quotes
    }
    return { type: 'SelectItem', position: pos, expr, alias };
  }

  protected parseFromClause(): { tables: TableReference[]; joins: JoinClause[] } {
    const tables: TableReference[] = [];
    const joins: JoinClause[] = [];

    tables.push(this.parseTableReference());

    // Additional tables (comma-join) or explicit joins
    while (true) {
      if (this.match(TokenType.COMMA)) {
        tables.push(this.parseTableReference());
        continue;
      }
      const join = this.tryParseJoin();
      if (join) {
        joins.push(join);
        continue;
      }
      break;
    }

    return { tables, joins };
  }

  protected parseTableReference(): TableReference {
    const pos = this.current().position;

    // Subquery: (SELECT ...)
    if (this.check(TokenType.LPAREN)) {
      this.advance();
      const query = this.parseSelect();
      this.expect(TokenType.RPAREN);
      const alias = this.parseOptionalAlias() ?? 'subquery';
      return { type: 'SubqueryTableRef', position: pos, query, alias };
    }

    // schema.table or just table
    let schema: string | undefined;
    let name = this.expectIdentifier();
    if (this.match(TokenType.DOT)) {
      schema = name;
      name = this.expectIdentifier();
    }

    // DB link: @link_name
    let dbLink: string | undefined;
    if (this.match(TokenType.AT)) {
      dbLink = this.expectIdentifier();
    }

    const alias = this.parseOptionalAlias();
    return { type: 'TableRef', position: pos, schema, name, alias, dbLink };
  }

  protected tryParseJoin(): JoinClause | null {
    const pos = this.current().position;
    let joinType: JoinClause['joinType'] = 'INNER';
    let hasJoinKeyword = false;

    if (this.matchKeyword('NATURAL')) {
      joinType = 'NATURAL';
      this.matchKeyword('INNER') || this.matchKeyword('LEFT') || this.matchKeyword('RIGHT') || this.matchKeyword('FULL');
      this.matchKeyword('OUTER');
      hasJoinKeyword = true;
    } else if (this.matchKeyword('INNER')) {
      joinType = 'INNER'; hasJoinKeyword = true;
    } else if (this.matchKeyword('LEFT')) {
      joinType = 'LEFT'; this.matchKeyword('OUTER'); hasJoinKeyword = true;
    } else if (this.matchKeyword('RIGHT')) {
      joinType = 'RIGHT'; this.matchKeyword('OUTER'); hasJoinKeyword = true;
    } else if (this.matchKeyword('FULL')) {
      joinType = 'FULL'; this.matchKeyword('OUTER'); hasJoinKeyword = true;
    } else if (this.matchKeyword('CROSS')) {
      joinType = 'CROSS'; hasJoinKeyword = true;
    }

    if (!this.matchKeyword('JOIN')) {
      if (hasJoinKeyword) throw this.error('Expected JOIN');
      return null;
    }

    const table = this.parseTableReference();
    let on: Expression | undefined;
    let using: string[] | undefined;

    if (this.matchKeyword('ON')) {
      on = this.parseExpression();
    } else if (this.matchKeyword('USING')) {
      this.expect(TokenType.LPAREN);
      using = [];
      do { using.push(this.expectIdentifier()); } while (this.match(TokenType.COMMA));
      this.expect(TokenType.RPAREN);
    }

    return { type: 'JoinClause', position: pos, joinType, table, on, using };
  }

  protected parseOrderByList(): OrderByItem[] {
    const items: OrderByItem[] = [];
    do {
      const pos = this.current().position;
      const expr = this.parseExpression();
      let direction: 'ASC' | 'DESC' = 'ASC';
      if (this.matchKeyword('DESC')) direction = 'DESC';
      else this.matchKeyword('ASC');
      let nullsPosition: 'FIRST' | 'LAST' | undefined;
      if (this.matchKeyword('NULLS')) {
        if (this.matchKeyword('FIRST')) nullsPosition = 'FIRST';
        else { this.expectKeyword('LAST'); nullsPosition = 'LAST'; }
      }
      items.push({ type: 'OrderByItem', position: pos, expr, direction, nullsPosition });
    } while (this.match(TokenType.COMMA));
    return items;
  }

  protected parseFetchClause(): SelectStatement['fetch'] | null {
    // OFFSET n ROWS
    let offset: Expression | undefined;
    if (this.matchKeyword('OFFSET')) {
      offset = this.parseExpression();
      this.matchKeyword('ROWS') || this.matchKeyword('ROW');
    }
    // FETCH FIRST/NEXT n ROWS ONLY/WITH TIES
    if (this.matchKeyword('FETCH')) {
      this.matchKeyword('FIRST') || this.matchKeyword('NEXT');
      const count = this.parseExpression();
      const percent = this.matchKeyword('PERCENT');
      this.matchKeyword('ROWS') || this.matchKeyword('ROW');
      const withTies = this.matchKeyword('WITH') ? (this.expectKeyword('TIES'), true) : (this.matchKeyword('ONLY'), false);
      return { offset, count, percent: percent || undefined, withTies: withTies || undefined };
    }
    if (offset) return { offset };
    return null;
  }

  protected parseForUpdateClause(): SelectStatement['forUpdate'] | null {
    if (!this.matchKeyword('FOR')) return null;
    this.expectKeyword('UPDATE');
    let columns: string[] | undefined;
    if (this.matchKeyword('OF')) {
      columns = [];
      do { columns.push(this.expectIdentifier()); } while (this.match(TokenType.COMMA));
    }
    let wait: number | 'NOWAIT' | 'SKIP_LOCKED' | undefined;
    if (this.matchKeyword('NOWAIT')) wait = 'NOWAIT';
    else if (this.matchKeyword('SKIP')) { this.expectKeyword('LOCKED'); wait = 'SKIP_LOCKED'; }
    else if (this.matchKeyword('WAIT')) { wait = Number(this.expect(TokenType.NUMBER_LITERAL).value); }
    return { columns, wait };
  }

  protected parseSetOperation(left: SelectStatement): SelectStatement {
    while (true) {
      let op: 'UNION' | 'UNION_ALL' | 'INTERSECT' | 'MINUS' | 'EXCEPT' | null = null;
      if (this.matchKeyword('UNION')) {
        op = this.matchKeyword('ALL') ? 'UNION_ALL' : 'UNION';
      } else if (this.matchKeyword('INTERSECT')) {
        op = 'INTERSECT';
      } else if (this.matchKeyword('MINUS')) {
        op = 'MINUS';
      } else if (this.matchKeyword('EXCEPT')) {
        op = 'EXCEPT';
      }
      if (!op) break;

      // Parse the right side — may be parenthesized: (SELECT ...) or plain SELECT ...
      let right: SelectStatement;
      if (this.check(TokenType.LPAREN)) {
        this.advance(); // consume (
        right = this.parseSelect();
        this.expect(TokenType.RPAREN);
      } else {
        this.expectKeyword('SELECT');
        this.pos--; // back up so parseSelect can consume SELECT
        right = this.parseSelect();
      }
      left = { ...left, setOp: { op, right } };
    }
    return left;
  }

  /** Oracle CONNECT BY — base implementation returns null. Override in OracleParser. */
  protected parseConnectByClause(): import('./ASTNode').ConnectByClause | null {
    return null;
  }

  // ── INSERT ────────────────────────────────────────────────────────

  protected parseInsert(): InsertStatement {
    const pos = this.current().position;
    this.expectKeyword('INSERT');
    if (this.check(TokenType.HINT)) this.advance();
    this.expectKeyword('INTO');

    const table = this.parseTableRefSimple();
    let columns: string[] | undefined;
    if (this.match(TokenType.LPAREN)) {
      columns = [];
      do { columns.push(this.expectIdentifier()); } while (this.match(TokenType.COMMA));
      this.expect(TokenType.RPAREN);
    }

    let values: Expression[][] | undefined;
    let query: SelectStatement | undefined;

    if (this.matchKeyword('VALUES')) {
      values = [];
      do {
        this.expect(TokenType.LPAREN);
        values.push(this.parseExpressionList());
        this.expect(TokenType.RPAREN);
      } while (this.match(TokenType.COMMA));
    } else if (this.checkKeyword('SELECT') || this.checkKeyword('WITH')) {
      query = this.parseSelect();
    }

    const returning = this.parseReturningClause();
    return { type: 'InsertStatement', position: pos, table, columns, values, query, returning: returning || undefined };
  }

  // ── UPDATE ────────────────────────────────────────────────────────

  protected parseUpdate(): UpdateStatement {
    const pos = this.current().position;
    this.expectKeyword('UPDATE');
    if (this.check(TokenType.HINT)) this.advance();
    const table = this.parseTableRefSimple();
    this.expectKeyword('SET');
    const assignments = this.parseAssignmentList();
    let where: Expression | undefined;
    if (this.matchKeyword('WHERE')) where = this.parseExpression();
    const returning = this.parseReturningClause();
    return { type: 'UpdateStatement', position: pos, table, assignments, where, returning: returning || undefined };
  }

  // ── DELETE ────────────────────────────────────────────────────────

  protected parseDelete(): DeleteStatement {
    const pos = this.current().position;
    this.expectKeyword('DELETE');
    if (this.check(TokenType.HINT)) this.advance();
    this.matchKeyword('FROM');
    const table = this.parseTableRefSimple();
    let where: Expression | undefined;
    if (this.matchKeyword('WHERE')) where = this.parseExpression();
    const returning = this.parseReturningClause();
    return { type: 'DeleteStatement', position: pos, table, where, returning: returning || undefined };
  }

  // ── CREATE ────────────────────────────────────────────────────────

  protected parseCreate(): Statement {
    const pos = this.current().position;
    this.expectKeyword('CREATE');
    const orReplace = this.matchKeyword('OR') ? (this.expectKeyword('REPLACE'), true) : false;

    if (this.matchKeyword('TABLE') || (this.matchKeyword('GLOBAL') && (this.expectKeyword('TEMPORARY'), this.expectKeyword('TABLE'), true))) {
      return this.parseCreateTable(pos, orReplace);
    }
    if (this.matchKeyword('VIEW')) return this.parseCreateView(pos, orReplace);
    if (this.matchKeyword('INDEX')) return this.parseCreateIndex(pos, false, false);
    if (this.matchKeyword('UNIQUE')) { this.expectKeyword('INDEX'); return this.parseCreateIndex(pos, true, false); }
    if (this.matchKeyword('BITMAP')) { this.expectKeyword('INDEX'); return this.parseCreateIndex(pos, false, true); }
    if (this.matchKeyword('SEQUENCE')) return this.parseCreateSequence(pos);
    if (this.matchKeyword('USER')) return this.parseCreateUser(pos);
    if (this.matchKeyword('ROLE')) return this.parseCreateRole(pos);
    if (this.matchKeyword('PROFILE')) return this.parseCreateProfile(pos);

    // Delegate to dialect for TABLESPACE, PROCEDURE, FUNCTION, PACKAGE, TRIGGER, etc.
    const dialectResult = this.parseDialectCreate(pos, orReplace);
    if (dialectResult) return dialectResult;

    throw this.error(`Unsupported CREATE target: ${this.current().value}`);
  }

  /** Override for dialect-specific CREATE targets. */
  protected parseDialectCreate(_pos: import('../lexer/Token').SourcePosition, _orReplace: boolean): Statement | null {
    return null;
  }

  protected parseCreateTable(pos: import('../lexer/Token').SourcePosition, _orReplace: boolean): import('./ASTNode').CreateTableStatement {
    let schema: string | undefined;
    let name = this.expectIdentifier();
    if (this.match(TokenType.DOT)) { schema = name; name = this.expectIdentifier(); }

    // AS SELECT
    if (this.matchKeyword('AS')) {
      const asSelect = this.parseSelect();
      return { type: 'CreateTableStatement', position: pos, schema, name, columns: [], constraints: [], asSelect };
    }

    this.expect(TokenType.LPAREN);
    const columns: ColumnDefinition[] = [];
    const constraints: TableConstraint[] = [];

    do {
      // Table-level constraint?
      if (this.checkKeyword('CONSTRAINT') || this.checkKeyword('PRIMARY') || this.checkKeyword('FOREIGN') || this.checkKeyword('UNIQUE') || this.checkKeyword('CHECK')) {
        constraints.push(this.parseTableConstraint());
      } else {
        columns.push(this.parseColumnDefinition());
      }
    } while (this.match(TokenType.COMMA));

    this.expect(TokenType.RPAREN);

    let tablespace: string | undefined;
    if (this.matchKeyword('TABLESPACE')) tablespace = this.expectIdentifier();

    return { type: 'CreateTableStatement', position: pos, schema, name, columns, constraints, tablespace };
  }

  protected parseColumnDefinition(): ColumnDefinition {
    const pos = this.current().position;
    const name = this.expectIdentifier();
    const dataType = this.parseTypeSpec();
    let defaultValue: Expression | undefined;
    const constraints: ColumnConstraint[] = [];

    if (this.matchKeyword('DEFAULT')) {
      defaultValue = this.parseExpression();
    }

    // Column constraints
    while (true) {
      const constraint = this.parseColumnConstraint();
      if (!constraint) break;
      constraints.push(constraint);
    }

    return { type: 'ColumnDefinition', position: pos, name, dataType, defaultValue, constraints };
  }

  protected parseTypeSpec(): TypeSpec {
    const pos = this.current().position;
    let name = this.expectIdentifierOrKeyword();

    // Multi-word types: TIMESTAMP WITH TIME ZONE, INTERVAL YEAR TO MONTH, etc.
    if (name === 'TIMESTAMP' && this.matchKeyword('WITH')) {
      if (this.matchKeyword('LOCAL')) {
        this.expectKeyword('TIME'); this.expectKeyword('ZONE');
        name = 'TIMESTAMP WITH LOCAL TIME ZONE';
      } else {
        this.expectKeyword('TIME'); this.expectKeyword('ZONE');
        name = 'TIMESTAMP WITH TIME ZONE';
      }
    } else if (name === 'INTERVAL') {
      if (this.matchKeyword('YEAR')) {
        this.expectKeyword('TO'); this.expectKeyword('MONTH');
        name = 'INTERVAL YEAR TO MONTH';
      } else if (this.matchKeyword('DAY')) {
        this.expectKeyword('TO'); this.expectKeyword('SECOND');
        name = 'INTERVAL DAY TO SECOND';
      }
    } else if (name === 'DOUBLE') {
      this.expectKeyword('PRECISION');
      name = 'DOUBLE PRECISION';
    } else if (name === 'LONG') {
      if (this.matchKeyword('RAW')) name = 'LONG RAW';
    }

    let precision: number | undefined;
    let scale: number | undefined;

    if (this.match(TokenType.LPAREN)) {
      precision = Number(this.expect(TokenType.NUMBER_LITERAL).value);
      if (this.match(TokenType.COMMA)) {
        scale = Number(this.expect(TokenType.NUMBER_LITERAL).value);
      }
      this.expect(TokenType.RPAREN);
    }

    return { type: 'TypeSpec', position: pos, name, precision, scale };
  }

  protected parseColumnConstraint(): ColumnConstraint | null {
    const pos = this.current().position;
    let constraintName: string | undefined;

    if (this.matchKeyword('CONSTRAINT')) {
      constraintName = this.expectIdentifier();
    }

    if (this.matchKeyword('NOT')) {
      this.expectKeyword('NULL');
      return { type: 'ColumnConstraint', position: pos, constraintName, constraintType: 'NOT_NULL' };
    }
    if (this.checkKeyword('NULL') && !constraintName) {
      this.advance();
      return { type: 'ColumnConstraint', position: pos, constraintType: 'NULL' };
    }
    if (this.matchKeyword('UNIQUE')) {
      return { type: 'ColumnConstraint', position: pos, constraintName, constraintType: 'UNIQUE' };
    }
    if (this.matchKeyword('PRIMARY')) {
      this.expectKeyword('KEY');
      return { type: 'ColumnConstraint', position: pos, constraintName, constraintType: 'PRIMARY_KEY' };
    }
    if (this.matchKeyword('CHECK')) {
      this.expect(TokenType.LPAREN);
      const checkExpr = this.parseExpression();
      this.expect(TokenType.RPAREN);
      return { type: 'ColumnConstraint', position: pos, constraintName, constraintType: 'CHECK', checkExpr };
    }
    if (this.matchKeyword('REFERENCES')) {
      const refTable = this.expectIdentifier();
      let refColumn: string | undefined;
      if (this.match(TokenType.LPAREN)) {
        refColumn = this.expectIdentifier();
        this.expect(TokenType.RPAREN);
      }
      let onDelete: 'CASCADE' | 'SET_NULL' | undefined;
      if (this.matchKeyword('ON')) {
        this.expectKeyword('DELETE');
        if (this.matchKeyword('CASCADE')) onDelete = 'CASCADE';
        else { this.expectKeyword('SET'); this.expectKeyword('NULL'); onDelete = 'SET_NULL'; }
      }
      return { type: 'ColumnConstraint', position: pos, constraintName, constraintType: 'REFERENCES', refTable, refColumn, onDelete };
    }

    // If we consumed CONSTRAINT name but no recognized constraint follows, backtrack
    if (constraintName) {
      this.pos -= 2; // rough backtrack
    }
    return null;
  }

  protected parseTableConstraint(): TableConstraint {
    const pos = this.current().position;
    let constraintName: string | undefined;

    if (this.matchKeyword('CONSTRAINT')) constraintName = this.expectIdentifier();

    if (this.matchKeyword('PRIMARY')) {
      this.expectKeyword('KEY');
      this.expect(TokenType.LPAREN);
      const columns = this.parseIdentifierList();
      this.expect(TokenType.RPAREN);
      return { type: 'TableConstraint', position: pos, constraintName, constraintType: 'PRIMARY_KEY', columns };
    }
    if (this.matchKeyword('UNIQUE')) {
      this.expect(TokenType.LPAREN);
      const columns = this.parseIdentifierList();
      this.expect(TokenType.RPAREN);
      return { type: 'TableConstraint', position: pos, constraintName, constraintType: 'UNIQUE', columns };
    }
    if (this.matchKeyword('FOREIGN')) {
      this.expectKeyword('KEY');
      this.expect(TokenType.LPAREN);
      const columns = this.parseIdentifierList();
      this.expect(TokenType.RPAREN);
      this.expectKeyword('REFERENCES');
      const refTable = this.expectIdentifier();
      let refColumns: string[] | undefined;
      if (this.match(TokenType.LPAREN)) {
        refColumns = this.parseIdentifierList();
        this.expect(TokenType.RPAREN);
      }
      let onDelete: 'CASCADE' | 'SET_NULL' | undefined;
      if (this.matchKeyword('ON')) {
        this.expectKeyword('DELETE');
        if (this.matchKeyword('CASCADE')) onDelete = 'CASCADE';
        else { this.expectKeyword('SET'); this.expectKeyword('NULL'); onDelete = 'SET_NULL'; }
      }
      return { type: 'TableConstraint', position: pos, constraintName, constraintType: 'FOREIGN_KEY', columns, refTable, refColumns, onDelete };
    }
    if (this.matchKeyword('CHECK')) {
      this.expect(TokenType.LPAREN);
      const checkExpr = this.parseExpression();
      this.expect(TokenType.RPAREN);
      return { type: 'TableConstraint', position: pos, constraintName, constraintType: 'CHECK', columns: [], checkExpr };
    }

    throw this.error('Expected constraint type (PRIMARY KEY, UNIQUE, FOREIGN KEY, CHECK)');
  }

  protected parseCreateView(pos: import('../lexer/Token').SourcePosition, orReplace: boolean): import('./ASTNode').CreateViewStatement {
    let schema: string | undefined;
    let name = this.expectIdentifier();
    if (this.match(TokenType.DOT)) { schema = name; name = this.expectIdentifier(); }
    let columns: string[] | undefined;
    if (this.match(TokenType.LPAREN)) {
      columns = this.parseIdentifierList();
      this.expect(TokenType.RPAREN);
    }
    this.expectKeyword('AS');
    const query = this.parseSelect();
    const withCheckOption = this.matchKeyword('WITH') ? (this.expectKeyword('CHECK'), this.expectKeyword('OPTION'), true) : false;
    return { type: 'CreateViewStatement', position: pos, orReplace: orReplace || undefined, schema, name, columns, query, withCheckOption: withCheckOption || undefined };
  }

  protected parseCreateIndex(pos: import('../lexer/Token').SourcePosition, unique: boolean, bitmap: boolean): import('./ASTNode').CreateIndexStatement {
    let schema: string | undefined;
    let name = this.expectIdentifier();
    if (this.match(TokenType.DOT)) { schema = name; name = this.expectIdentifier(); }
    this.expectKeyword('ON');
    let tableSchema: string | undefined;
    let tableName = this.expectIdentifier();
    if (this.match(TokenType.DOT)) { tableSchema = tableName; tableName = this.expectIdentifier(); }
    this.expect(TokenType.LPAREN);
    const columns: import('./ASTNode').CreateIndexStatement['columns'] = [];
    do {
      const colName = this.expectIdentifier();
      if (this.match(TokenType.LPAREN)) {
        // Function-based index: e.g. UPPER(col), NVL(col, 'X')
        const funcName = colName.toUpperCase();
        const args: string[] = [];
        let depth = 1;
        let currentArg = '';
        while (depth > 0 && !this.check(TokenType.EOF)) {
          if (this.check(TokenType.LPAREN)) { depth++; currentArg += '('; this.advance(); }
          else if (this.check(TokenType.RPAREN)) {
            depth--;
            if (depth === 0) { this.advance(); break; }
            currentArg += ')'; this.advance();
          } else if (this.check(TokenType.COMMA) && depth === 1) {
            args.push(currentArg.trim());
            currentArg = '';
            this.advance();
          } else {
            const tok = this.current();
            currentArg += tok.type === TokenType.STRING_LITERAL ? `'${tok.value}'` : String(tok.value);
            this.advance();
          }
        }
        if (currentArg.trim()) args.push(currentArg.trim());
        const expressionText = `${funcName}(${args.join(', ')})`;
        let direction: 'ASC' | 'DESC' | undefined;
        if (this.matchKeyword('ASC')) direction = 'ASC';
        else if (this.matchKeyword('DESC')) direction = 'DESC';
        columns.push({ name: expressionText, direction, expression: expressionText });
      } else {
        let direction: 'ASC' | 'DESC' | undefined;
        if (this.matchKeyword('ASC')) direction = 'ASC';
        else if (this.matchKeyword('DESC')) direction = 'DESC';
        columns.push({ name: colName, direction });
      }
    } while (this.match(TokenType.COMMA));
    this.expect(TokenType.RPAREN);
    let tablespace: string | undefined;
    if (this.matchKeyword('TABLESPACE')) tablespace = this.expectIdentifier();
    return { type: 'CreateIndexStatement', position: pos, unique: unique || undefined, bitmap: bitmap || undefined, schema, name, table: tableName, tableSchema, columns, tablespace };
  }

  protected parseCreateSequence(pos: import('../lexer/Token').SourcePosition): import('./ASTNode').CreateSequenceStatement {
    let schema: string | undefined;
    let name = this.expectIdentifier();
    if (this.match(TokenType.DOT)) { schema = name; name = this.expectIdentifier(); }
    let startWith: number | undefined, incrementBy: number | undefined;
    let cache: number | 'NOCACHE' | undefined;
    let cycle: boolean | undefined;
    while (!this.check(TokenType.SEMICOLON) && !this.check(TokenType.EOF)) {
      if (this.matchKeyword('START')) { this.expectKeyword('WITH'); startWith = Number(this.expect(TokenType.NUMBER_LITERAL).value); }
      else if (this.matchKeyword('INCREMENT')) { this.expectKeyword('BY'); incrementBy = Number(this.expect(TokenType.NUMBER_LITERAL).value); }
      else if (this.matchKeyword('CACHE')) { cache = Number(this.expect(TokenType.NUMBER_LITERAL).value); }
      else if (this.matchKeyword('NOCACHE')) { cache = 'NOCACHE'; }
      else if (this.matchKeyword('CYCLE')) { cycle = true; }
      else if (this.matchKeyword('NOCYCLE')) { cycle = false; }
      else break;
    }
    return { type: 'CreateSequenceStatement', position: pos, schema, name, startWith, incrementBy, cache, cycle };
  }

  protected parseCreateUser(pos: import('../lexer/Token').SourcePosition): import('./ASTNode').CreateUserStatement {
    const username = this.expectIdentifier();
    let password: string | undefined;
    if (this.matchKeyword('IDENTIFIED')) {
      this.expectKeyword('BY');
      password = this.expectIdentifierOrString();
    }
    let defaultTablespace: string | undefined;
    let temporaryTablespace: string | undefined;
    let profile: string | undefined;
    let accountLocked: boolean | undefined;
    while (!this.check(TokenType.SEMICOLON) && !this.check(TokenType.EOF)) {
      if (this.matchKeyword('DEFAULT')) { this.expectKeyword('TABLESPACE'); defaultTablespace = this.expectIdentifier(); }
      else if (this.matchKeyword('TEMPORARY')) { this.expectKeyword('TABLESPACE'); temporaryTablespace = this.expectIdentifier(); }
      else if (this.matchKeyword('PROFILE')) { profile = this.expectIdentifier(); }
      else if (this.matchKeyword('ACCOUNT')) { this.expectKeyword('LOCK'); accountLocked = true; }
      else break;
    }
    return { type: 'CreateUserStatement', position: pos, username, password, defaultTablespace, temporaryTablespace, profile, accountLocked };
  }

  protected parseCreateRole(pos: import('../lexer/Token').SourcePosition): import('./ASTNode').CreateRoleStatement {
    const name = this.expectIdentifier();
    return { type: 'CreateRoleStatement', position: pos, name };
  }

  // ── ALTER ─────────────────────────────────────────────────────────

  protected parseAlter(): Statement {
    const pos = this.current().position;
    this.expectKeyword('ALTER');
    if (this.checkKeyword('TABLE')) return this.parseAlterTable(pos);
    if (this.checkKeyword('USER')) return this.parseAlterUser(pos);
    if (this.matchKeyword('PROFILE')) return this.parseAlterProfile(pos);
    // Delegate to dialect
    const dialectResult = this.parseDialectAlter(pos);
    if (dialectResult) return dialectResult;
    throw this.error(`Unsupported ALTER target: ${this.current().value}`);
  }

  protected parseDialectAlter(_pos: import('../lexer/Token').SourcePosition): Statement | null {
    return null;
  }

  protected parseAlterTable(pos: import('../lexer/Token').SourcePosition): import('./ASTNode').AlterTableStatement {
    this.expectKeyword('TABLE');
    let schema: string | undefined;
    let name = this.expectIdentifier();
    if (this.match(TokenType.DOT)) { schema = name; name = this.expectIdentifier(); }
    const actions: import('./ASTNode').AlterTableAction[] = [];

    if (this.matchKeyword('ADD')) {
      if (this.match(TokenType.LPAREN) || this.checkKeyword('CONSTRAINT') || this.checkKeyword('PRIMARY') || this.checkKeyword('UNIQUE') || this.checkKeyword('FOREIGN') || this.checkKeyword('CHECK')) {
        const hadParen = this.tokens[this.pos - 1]?.type === TokenType.LPAREN;
        const constraint = this.parseTableConstraint();
        if (hadParen) this.expect(TokenType.RPAREN);
        actions.push({ action: 'ADD_CONSTRAINT', constraint });
      } else {
        actions.push({ action: 'ADD_COLUMN', column: this.parseColumnDefinition() });
      }
    } else if (this.matchKeyword('MODIFY')) {
      actions.push({ action: 'MODIFY_COLUMN', column: this.parseColumnDefinition() });
    } else if (this.matchKeyword('DROP')) {
      if (this.matchKeyword('COLUMN')) {
        actions.push({ action: 'DROP_COLUMN', columnName: this.expectIdentifier() });
      } else if (this.matchKeyword('CONSTRAINT')) {
        const constraintName = this.expectIdentifier();
        const cascade = this.matchKeyword('CASCADE');
        actions.push({ action: 'DROP_CONSTRAINT', constraintName, cascade: cascade || undefined });
      }
    } else if (this.matchKeyword('RENAME')) {
      if (this.matchKeyword('COLUMN')) {
        const oldName = this.expectIdentifier();
        this.expectKeyword('TO');
        const newName = this.expectIdentifier();
        actions.push({ action: 'RENAME_COLUMN', oldName, newName });
      } else {
        this.expectKeyword('TO');
        const newName = this.expectIdentifier();
        actions.push({ action: 'RENAME_TABLE', newName });
      }
    }

    return { type: 'AlterTableStatement', position: pos, schema, name, actions };
  }

  protected parseAlterUser(pos: import('../lexer/Token').SourcePosition): import('./ASTNode').AlterUserStatement {
    this.expectKeyword('USER');
    const username = this.expectIdentifier();
    let password: string | undefined;
    let accountLock: boolean | undefined;
    let accountUnlock: boolean | undefined;
    let passwordExpire: boolean | undefined;

    while (!this.check(TokenType.SEMICOLON) && !this.check(TokenType.EOF)) {
      if (this.matchKeyword('IDENTIFIED')) { this.expectKeyword('BY'); password = this.expectIdentifierOrString(); }
      else if (this.matchKeyword('ACCOUNT')) {
        if (this.matchKeyword('LOCK')) accountLock = true;
        else { this.expectKeyword('UNLOCK'); accountUnlock = true; }
      }
      else if (this.matchKeyword('PASSWORD')) { this.expectKeyword('EXPIRE'); passwordExpire = true; }
      else break;
    }
    return { type: 'AlterUserStatement', position: pos, username, password, accountLock, accountUnlock, passwordExpire };
  }

  // ── DROP ──────────────────────────────────────────────────────────

  protected parseDrop(): Statement {
    const pos = this.current().position;
    this.expectKeyword('DROP');
    if (this.matchKeyword('TABLE')) return this.parseDropTable(pos);
    if (this.matchKeyword('VIEW')) return this.parseDropView(pos);
    if (this.matchKeyword('INDEX')) return this.parseDropIndex(pos);
    if (this.matchKeyword('SEQUENCE')) return this.parseDropSequence(pos);
    if (this.matchKeyword('USER')) return this.parseDropUser(pos);
    if (this.matchKeyword('ROLE')) return this.parseDropRole(pos);
    if (this.matchKeyword('PROFILE')) return this.parseDropProfile(pos);
    const dialect = this.parseDialectDrop(pos);
    if (dialect) return dialect;
    throw this.error(`Unsupported DROP target: ${this.current().value}`);
  }

  protected parseDialectDrop(_pos: import('../lexer/Token').SourcePosition): Statement | null { return null; }

  protected parseDropTable(pos: import('../lexer/Token').SourcePosition): import('./ASTNode').DropTableStatement {
    const ifExists = this.matchKeyword('IF') ? (this.expectKeyword('EXISTS'), true) : false;
    let schema: string | undefined;
    let name = this.expectIdentifier();
    if (this.match(TokenType.DOT)) { schema = name; name = this.expectIdentifier(); }
    const cascade = this.matchKeyword('CASCADE') ? (this.matchKeyword('CONSTRAINTS'), true) : false;
    const purge = this.matchKeyword('PURGE');
    return { type: 'DropTableStatement', position: pos, schema, name, cascade: cascade || undefined, purge: purge || undefined, ifExists: ifExists || undefined };
  }

  protected parseDropView(pos: import('../lexer/Token').SourcePosition): import('./ASTNode').DropViewStatement {
    let schema: string | undefined;
    let name = this.expectIdentifier();
    if (this.match(TokenType.DOT)) { schema = name; name = this.expectIdentifier(); }
    return { type: 'DropViewStatement', position: pos, schema, name };
  }

  protected parseDropIndex(pos: import('../lexer/Token').SourcePosition): import('./ASTNode').DropIndexStatement {
    let schema: string | undefined;
    let name = this.expectIdentifier();
    if (this.match(TokenType.DOT)) { schema = name; name = this.expectIdentifier(); }
    return { type: 'DropIndexStatement', position: pos, schema, name };
  }

  protected parseDropSequence(pos: import('../lexer/Token').SourcePosition): import('./ASTNode').DropSequenceStatement {
    let schema: string | undefined;
    let name = this.expectIdentifier();
    if (this.match(TokenType.DOT)) { schema = name; name = this.expectIdentifier(); }
    return { type: 'DropSequenceStatement', position: pos, schema, name };
  }

  protected parseDropUser(pos: import('../lexer/Token').SourcePosition): import('./ASTNode').DropUserStatement {
    const username = this.expectIdentifier();
    const cascade = this.matchKeyword('CASCADE');
    return { type: 'DropUserStatement', position: pos, username, cascade: cascade || undefined };
  }

  protected parseDropRole(pos: import('../lexer/Token').SourcePosition): import('./ASTNode').DropRoleStatement {
    const name = this.expectIdentifier();
    return { type: 'DropRoleStatement', position: pos, name };
  }

  // ── PROFILE management ──────────────────────────────────────────

  protected parseCreateProfile(pos: import('../lexer/Token').SourcePosition): import('./ASTNode').CreateProfileStatement {
    const profileName = this.expectIdentifier();
    // LIMIT may be a keyword or identifier depending on lexer
    if (!this.matchKeyword('LIMIT')) {
      if (this.check(TokenType.IDENTIFIER) && this.current().value.toUpperCase() === 'LIMIT') {
        this.advance();
      }
    }
    const limits = this.parseProfileLimits();
    return { type: 'CreateProfileStatement', position: pos, profileName, limits };
  }

  protected parseAlterProfile(pos: import('../lexer/Token').SourcePosition): import('./ASTNode').AlterProfileStatement {
    const profileName = this.expectIdentifier();
    if (!this.matchKeyword('LIMIT')) {
      if (this.check(TokenType.IDENTIFIER) && this.current().value.toUpperCase() === 'LIMIT') {
        this.advance();
      }
    }
    const limits = this.parseProfileLimits();
    return { type: 'AlterProfileStatement', position: pos, profileName, limits };
  }

  protected parseDropProfile(pos: import('../lexer/Token').SourcePosition): import('./ASTNode').DropProfileStatement {
    const profileName = this.expectIdentifier();
    const cascade = this.matchKeyword('CASCADE');
    return { type: 'DropProfileStatement', position: pos, profileName, cascade: cascade || undefined };
  }

  private parseProfileLimits(): Map<string, string> {
    const limits = new Map<string, string>();
    while (!this.check(TokenType.EOF) && !this.check(TokenType.SEMICOLON)) {
      if (!this.check(TokenType.IDENTIFIER) && !this.check(TokenType.KEYWORD)) break;
      const resName = this.expectIdentifierOrKeyword();
      // Value can be a number, keyword (UNLIMITED, DEFAULT, NULL), or identifier (function name)
      let value: string;
      if (this.check(TokenType.NUMBER_LITERAL)) {
        value = this.advance().value;
      } else {
        value = this.expectIdentifierOrKeyword();
      }
      limits.set(resName.toUpperCase(), value.toUpperCase());
    }
    return limits;
  }

  // ── TRUNCATE ──────────────────────────────────────────────────────

  protected parseTruncate(): import('./ASTNode').TruncateTableStatement {
    const pos = this.current().position;
    this.expectKeyword('TRUNCATE');
    this.expectKeyword('TABLE');
    let schema: string | undefined;
    let name = this.expectIdentifier();
    if (this.match(TokenType.DOT)) { schema = name; name = this.expectIdentifier(); }
    return { type: 'TruncateTableStatement', position: pos, schema, name };
  }

  // ── GRANT / REVOKE ────────────────────────────────────────────────

  protected parseGrant(): import('./ASTNode').GrantStatement {
    const pos = this.current().position;
    this.expectKeyword('GRANT');
    const privileges = this.parsePrivilegeList();
    let objectName: string | undefined;
    let objectSchema: string | undefined;
    if (this.matchKeyword('ON')) {
      objectName = this.expectIdentifier();
      if (this.match(TokenType.DOT)) { objectSchema = objectName; objectName = this.expectIdentifier(); }
    }
    this.expectKeyword('TO');
    const grantee = this.expectIdentifier();
    let withGrantOption = false;
    let withAdminOption = false;
    if (this.matchKeyword('WITH')) {
      if (this.matchKeyword('GRANT')) {
        this.expectKeyword('OPTION');
        withGrantOption = true;
      } else if (this.matchKeyword('ADMIN')) {
        this.expectKeyword('OPTION');
        withAdminOption = true;
      }
    }
    return { type: 'GrantStatement', position: pos, privileges, objectSchema, objectName, grantee, withGrantOption: withGrantOption || undefined, withAdminOption: withAdminOption || undefined };
  }

  protected parseRevoke(): import('./ASTNode').RevokeStatement {
    const pos = this.current().position;
    this.expectKeyword('REVOKE');
    const privileges = this.parsePrivilegeList();
    let objectName: string | undefined;
    let objectSchema: string | undefined;
    if (this.matchKeyword('ON')) {
      objectName = this.expectIdentifier();
      if (this.match(TokenType.DOT)) { objectSchema = objectName; objectName = this.expectIdentifier(); }
    }
    this.expectKeyword('FROM');
    const grantee = this.expectIdentifier();
    return { type: 'RevokeStatement', position: pos, privileges, objectSchema, objectName, grantee };
  }

  protected parsePrivilegeList(): string[] {
    const privs: string[] = [];
    do {
      let priv = this.expectIdentifierOrKeyword();
      // Multi-word privileges: CREATE SESSION, SELECT ANY TABLE, etc.
      while (this.check(TokenType.KEYWORD) || this.check(TokenType.IDENTIFIER)) {
        const next = this.current().value.toUpperCase();
        if (['ON', 'TO', 'FROM', 'WITH'].includes(next)) break;
        priv += ' ' + this.advance().value;
      }
      privs.push(priv);
    } while (this.match(TokenType.COMMA));
    return privs;
  }

  // ── COMMIT / ROLLBACK / SAVEPOINT ─────────────────────────────────

  protected parseCommit(): CommitStatement {
    const pos = this.current().position;
    this.expectKeyword('COMMIT');
    return { type: 'CommitStatement', position: pos };
  }

  protected parseRollback(): RollbackStatement {
    const pos = this.current().position;
    this.expectKeyword('ROLLBACK');
    let savepoint: string | undefined;
    if (this.matchKeyword('TO')) {
      this.matchKeyword('SAVEPOINT');
      savepoint = this.expectIdentifier();
    }
    return { type: 'RollbackStatement', position: pos, savepoint };
  }

  protected parseSavepoint(): SavepointStatement {
    const pos = this.current().position;
    this.expectKeyword('SAVEPOINT');
    const name = this.expectIdentifier();
    return { type: 'SavepointStatement', position: pos, name };
  }

  // ── RETURNING clause ──────────────────────────────────────────────

  protected parseReturningClause(): import('./ASTNode').ReturningClause | null {
    if (!this.matchKeyword('RETURNING')) return null;
    const pos = this.tokens[this.pos - 1].position;
    const columns = this.parseExpressionList();
    this.expectKeyword('INTO');
    const into: string[] = [];
    do { into.push(this.expect(TokenType.BIND_VARIABLE).value); } while (this.match(TokenType.COMMA));
    return { type: 'ReturningClause', position: pos, columns, into };
  }

  // ── Expression Parser (Pratt / Precedence Climbing) ───────────────

  protected parseExpression(): Expression {
    return this.parseOr();
  }

  protected parseOr(): Expression {
    let left = this.parseAnd();
    while (this.matchKeyword('OR')) {
      const pos = this.tokens[this.pos - 1].position;
      const right = this.parseAnd();
      left = { type: 'BinaryExpr', position: pos, operator: 'OR', left, right };
    }
    return left;
  }

  protected parseAnd(): Expression {
    let left = this.parseNot();
    while (this.matchKeyword('AND')) {
      const pos = this.tokens[this.pos - 1].position;
      const right = this.parseNot();
      left = { type: 'BinaryExpr', position: pos, operator: 'AND', left, right };
    }
    return left;
  }

  protected parseNot(): Expression {
    if (this.matchKeyword('NOT')) {
      const pos = this.tokens[this.pos - 1].position;
      return { type: 'UnaryExpr', position: pos, operator: 'NOT', operand: this.parseNot() };
    }
    return this.parseComparison();
  }

  protected parseComparison(): Expression {
    // EXISTS must be checked before parsing left operand
    if (this.checkKeyword('EXISTS')) {
      const pos = this.current().position;
      this.advance(); // consume EXISTS
      this.expect(TokenType.LPAREN);
      const query = this.parseSelect();
      this.expect(TokenType.RPAREN);
      return { type: 'UnaryExpr', position: pos, operator: 'EXISTS', operand: { type: 'SubqueryExpr', position: pos, query } };
    }

    let left = this.parseAddition();
    const pos = this.current().position;

    // IS [NOT] NULL
    if (this.matchKeyword('IS')) {
      const negated = this.matchKeyword('NOT');
      this.expectKeyword('NULL');
      return { type: 'IsNullExpr', position: pos, expr: left, negated };
    }

    // [NOT] BETWEEN
    const notBetween = this.matchKeyword('NOT');
    if (this.matchKeyword('BETWEEN')) {
      const low = this.parseAddition();
      this.expectKeyword('AND');
      const high = this.parseAddition();
      return { type: 'BetweenExpr', position: pos, expr: left, low, high, negated: notBetween };
    }

    // [NOT] IN
    if (this.matchKeyword('IN')) {
      this.expect(TokenType.LPAREN);
      if (this.checkKeyword('SELECT')) {
        const query = this.parseSelect();
        this.expect(TokenType.RPAREN);
        return { type: 'InExpr', position: pos, expr: left, values: query, negated: notBetween };
      }
      const values = this.parseExpressionList();
      this.expect(TokenType.RPAREN);
      return { type: 'InExpr', position: pos, expr: left, values, negated: notBetween };
    }

    // [NOT] LIKE
    if (this.matchKeyword('LIKE')) {
      const pattern = this.parseAddition();
      let escape: Expression | undefined;
      if (this.matchKeyword('ESCAPE')) escape = this.parsePrimary();
      return { type: 'LikeExpr', position: pos, expr: left, pattern, escape, negated: notBetween };
    }

    if (notBetween) {
      // We consumed NOT but no BETWEEN/IN/LIKE followed — this is an error
      throw this.error('Expected BETWEEN, IN, or LIKE after NOT');
    }

    // Comparison operators
    if (this.check(TokenType.COMPARISON_OP)) {
      const op = this.advance().value;
      const right = this.parseAddition();
      left = { type: 'BinaryExpr', position: pos, operator: op, left, right };
    }

    return left;
  }

  protected parseAddition(): Expression {
    let left = this.parseMultiplication();
    while (this.check(TokenType.ARITHMETIC_OP) && (this.current().value === '+' || this.current().value === '-')) {
      const pos = this.current().position;
      const op = this.advance().value;
      const right = this.parseMultiplication();
      left = { type: 'BinaryExpr', position: pos, operator: op, left, right };
    }
    // String concatenation ||
    while (this.check(TokenType.CONCAT_OP)) {
      const pos = this.current().position;
      this.advance();
      const right = this.parseMultiplication();
      left = { type: 'BinaryExpr', position: pos, operator: '||', left, right };
    }
    return left;
  }

  protected parseMultiplication(): Expression {
    let left = this.parseUnary();
    while (this.check(TokenType.STAR) || (this.check(TokenType.SLASH))) {
      const pos = this.current().position;
      const op = this.advance().value;
      const right = this.parseUnary();
      left = { type: 'BinaryExpr', position: pos, operator: op, left, right };
    }
    return left;
  }

  protected parseUnary(): Expression {
    if (this.check(TokenType.ARITHMETIC_OP) && (this.current().value === '-' || this.current().value === '+')) {
      const pos = this.current().position;
      const op = this.advance().value;
      const operand = this.parseUnary();
      return { type: 'UnaryExpr', position: pos, operator: op, operand };
    }
    return this.parsePrimary();
  }

  protected parsePrimary(): Expression {
    const token = this.current();
    const pos = token.position;

    // Number literal
    if (token.type === TokenType.NUMBER_LITERAL) {
      this.advance();
      return { type: 'Literal', position: pos, dataType: 'number', value: Number(token.value) };
    }

    // String literal
    if (token.type === TokenType.STRING_LITERAL) {
      this.advance();
      let val = token.value;
      // Oracle q-quote syntax: q'[text]', q'{text}', q'<text>', q'(text)', q'!text!'
      const qMatch = val.match(/^[qQ]'([\[\{<(])([\s\S]*?)([\]\}>)])'$/);
      if (qMatch) {
        val = qMatch[2];
      } else if (/^[qQ]'(.)[\s\S]*\1'$/.test(val)) {
        // q-quote with custom single-char delimiter: q'!text!'
        val = val.slice(3, -2);
      } else if (val.startsWith("N'") && val.endsWith("'")) {
        val = val.slice(2, -1).replace(/''/g, "'");
      } else if (val.startsWith("'") && val.endsWith("'")) {
        val = val.slice(1, -1).replace(/''/g, "'");
      }
      // Oracle treats empty string as NULL
      if (val === '') {
        return { type: 'Literal', position: pos, dataType: 'null', value: null };
      }
      return { type: 'Literal', position: pos, dataType: 'string', value: val };
    }

    // NULL
    if (this.matchKeyword('NULL')) {
      return { type: 'Literal', position: pos, dataType: 'null', value: null };
    }

    // TRUE / FALSE
    if (this.matchKeyword('TRUE')) {
      return { type: 'Literal', position: pos, dataType: 'boolean', value: true };
    }
    if (this.matchKeyword('FALSE')) {
      return { type: 'Literal', position: pos, dataType: 'boolean', value: false };
    }

    // DATE 'literal' — Oracle date literal (ANSI SQL)
    if (this.checkKeyword('DATE') && this.peekNext()?.type === TokenType.STRING_LITERAL) {
      this.advance(); // consume DATE
      const strToken = this.advance();
      let val = strToken.value;
      if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
      return { type: 'Literal', position: pos, dataType: 'date', value: val };
    }

    // TIMESTAMP 'literal' — ANSI timestamp literal
    if (this.checkKeyword('TIMESTAMP') && this.peekNext()?.type === TokenType.STRING_LITERAL) {
      this.advance(); // consume TIMESTAMP
      const strToken = this.advance();
      let val = strToken.value;
      if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
      return { type: 'Literal', position: pos, dataType: 'timestamp', value: val };
    }

    // CASE expression
    if (this.matchKeyword('CASE')) {
      return this.parseCaseExpression(pos);
    }

    // CAST(expr AS type)
    if (this.checkKeyword('CAST') && this.peekNext()?.type === TokenType.LPAREN) {
      this.advance();
      this.expect(TokenType.LPAREN);
      const expr = this.parseExpression();
      this.expectKeyword('AS');
      const targetType = this.parseTypeSpec();
      this.expect(TokenType.RPAREN);
      return { type: 'CastExpr', position: pos, expr, targetType };
    }

    // EXTRACT(field FROM expr) — special SQL syntax
    if (this.checkKeyword('EXTRACT') && this.peekNext()?.type === TokenType.LPAREN) {
      this.advance(); // EXTRACT
      this.expect(TokenType.LPAREN);
      // field is one of: YEAR, MONTH, DAY, HOUR, MINUTE, SECOND, TIMEZONE_HOUR, TIMEZONE_MINUTE, TIMEZONE_REGION, TIMEZONE_ABBR
      const fieldToken = this.advance();
      const field = fieldToken.value.toUpperCase();
      this.expectKeyword('FROM');
      const sourceExpr = this.parseExpression();
      this.expect(TokenType.RPAREN);
      // Represent as FunctionCall with two args: field literal + source expression
      const fieldLiteral: LiteralExpr = { type: 'Literal', position: fieldToken.position, value: field, dataType: 'string' };
      return { type: 'FunctionCall', position: pos, name: 'EXTRACT', args: [fieldLiteral, sourceExpr] };
    }

    // TRIM([LEADING|TRAILING|BOTH] [chars FROM] expr) — special SQL syntax
    if (this.checkKeyword('TRIM') && this.peekNext()?.type === TokenType.LPAREN) {
      this.advance(); // TRIM
      this.expect(TokenType.LPAREN);
      let trimSpec: string = 'BOTH';
      let trimChars: Expression | undefined;

      // Check for LEADING/TRAILING/BOTH (may be identifiers or keywords depending on lexer)
      const trimToken = this.current();
      const trimTokenVal = trimToken.value.toUpperCase();
      if ((trimToken.type === TokenType.KEYWORD || trimToken.type === TokenType.IDENTIFIER) && (trimTokenVal === 'LEADING' || trimTokenVal === 'TRAILING' || trimTokenVal === 'BOTH')) {
        this.advance();
        trimSpec = trimTokenVal;
        // Optional trim character(s) followed by FROM
        if (!this.checkKeyword('FROM')) {
          trimChars = this.parseExpression();
        }
        this.expectKeyword('FROM');
        const sourceExpr = this.parseExpression();
        this.expect(TokenType.RPAREN);
        const specLiteral: LiteralExpr = { type: 'Literal', position: pos, value: trimSpec, dataType: 'string' };
        const args: Expression[] = trimChars ? [sourceExpr, trimChars, specLiteral] : [sourceExpr, { type: 'Literal', position: pos, value: ' ', dataType: 'string' } as LiteralExpr, specLiteral];
        return { type: 'FunctionCall', position: pos, name: 'TRIM', args };
      }

      // Regular TRIM(expr) or TRIM(chars FROM expr)
      const firstExpr = this.parseExpression();
      if (this.matchKeyword('FROM')) {
        const sourceExpr = this.parseExpression();
        this.expect(TokenType.RPAREN);
        const specLiteral: LiteralExpr = { type: 'Literal', position: pos, value: 'BOTH', dataType: 'string' };
        return { type: 'FunctionCall', position: pos, name: 'TRIM', args: [sourceExpr, firstExpr, specLiteral] };
      }
      this.expect(TokenType.RPAREN);
      return { type: 'FunctionCall', position: pos, name: 'TRIM', args: [firstExpr] };
    }

    // Parenthesized expression or subquery
    if (this.check(TokenType.LPAREN)) {
      this.advance();
      if (this.checkKeyword('SELECT')) {
        const query = this.parseSelect();
        this.expect(TokenType.RPAREN);
        return { type: 'SubqueryExpr', position: pos, query };
      }
      const expr = this.parseExpression();
      this.expect(TokenType.RPAREN);
      return { type: 'ParenExpr', position: pos, expr };
    }

    // Bind variable
    if (token.type === TokenType.BIND_VARIABLE) {
      this.advance();
      return { type: 'BindVariable', position: pos, name: token.value.slice(1) };
    }

    // Identifier, function call, or sequence.NEXTVAL/CURRVAL
    if (token.type === TokenType.IDENTIFIER || token.type === TokenType.KEYWORD || token.type === TokenType.QUOTED_IDENTIFIER) {
      return this.parseIdentifierOrFunctionCall();
    }

    // Star (in expression context, e.g., COUNT(*))
    if (token.type === TokenType.STAR) {
      this.advance();
      return { type: 'Star', position: pos };
    }

    throw this.error(`Unexpected token in expression: ${token.value} (${token.type})`);
  }

  protected parseIdentifierOrFunctionCall(): Expression {
    const pos = this.current().position;
    const name = this.advance().value;
    const cleanName = name.startsWith('"') ? name.slice(1, -1) : name;

    // Function call: name(...)
    if (this.check(TokenType.LPAREN) && !this.isStatementBoundary()) {
      this.advance(); // (
      const distinct = this.matchKeyword('DISTINCT');
      let args: Expression[] = [];
      if (!this.check(TokenType.RPAREN)) {
        // Special case: COUNT(*)
        if (this.check(TokenType.STAR) && this.peekNext()?.type === TokenType.RPAREN) {
          args.push({ type: 'Star', position: this.current().position });
          this.advance();
        } else {
          args = this.parseExpressionList();
        }
      }
      this.expect(TokenType.RPAREN);

      // Analytic window: OVER (...)
      let over: import('./ASTNode').WindowSpec | undefined;
      if (this.matchKeyword('OVER')) {
        over = this.parseWindowSpec();
      }

      return { type: 'FunctionCall', position: pos, name: cleanName.toUpperCase(), args, distinct: distinct || undefined, over };
    }

    // Dotted reference: schema.table.column or table.column or seq.NEXTVAL
    if (this.check(TokenType.DOT)) {
      this.advance();
      const next = this.advance();
      const nextVal = next.value.toUpperCase();

      // sequence.NEXTVAL / sequence.CURRVAL
      if (nextVal === 'NEXTVAL' || nextVal === 'CURRVAL') {
        return { type: 'SequenceExpr', position: pos, sequenceName: cleanName, operation: nextVal as 'NEXTVAL' | 'CURRVAL' };
      }

      // schema.table.column or table.column
      if (this.check(TokenType.DOT)) {
        this.advance();
        const col = this.advance().value;
        return { type: 'Identifier', position: pos, schema: cleanName, table: next.value, name: col };
      }

      // table.column — check for function call: schema.function(...)
      if (this.check(TokenType.LPAREN)) {
        this.advance();
        const args = this.check(TokenType.RPAREN) ? [] : this.parseExpressionList();
        this.expect(TokenType.RPAREN);
        return { type: 'FunctionCall', position: pos, schema: cleanName, name: next.value.toUpperCase(), args };
      }

      return { type: 'Identifier', position: pos, table: cleanName, name: next.value };
    }

    return { type: 'Identifier', position: pos, name: cleanName };
  }

  protected parseCaseExpression(pos: import('../lexer/Token').SourcePosition): CaseExpr {
    let operand: Expression | undefined;
    // Simple CASE: CASE expr WHEN ...
    if (!this.checkKeyword('WHEN')) {
      operand = this.parseExpression();
    }
    const whenClauses: { when: Expression; then: Expression }[] = [];
    while (this.matchKeyword('WHEN')) {
      const when = this.parseExpression();
      this.expectKeyword('THEN');
      const then = this.parseExpression();
      whenClauses.push({ when, then });
    }
    let elseClause: Expression | undefined;
    if (this.matchKeyword('ELSE')) {
      elseClause = this.parseExpression();
    }
    this.expectKeyword('END');
    return { type: 'CaseExpr', position: pos, operand, whenClauses, elseClause };
  }

  protected parseWindowSpec(): import('./ASTNode').WindowSpec {
    this.expect(TokenType.LPAREN);
    let partitionBy: Expression[] | undefined;
    let orderBy: OrderByItem[] | undefined;
    if (this.matchKeyword('PARTITION')) {
      this.expectKeyword('BY');
      partitionBy = this.parseExpressionList();
    }
    if (this.matchKeyword('ORDER')) {
      this.expectKeyword('BY');
      orderBy = this.parseOrderByList();
    }
    // Window frame (ROWS/RANGE BETWEEN ... AND ...)
    let frame: import('./ASTNode').WindowFrame | undefined;
    if (this.checkKeyword('ROWS') || this.checkKeyword('RANGE')) {
      const frameType = this.current().value!.toUpperCase() as 'ROWS' | 'RANGE';
      this.advance();
      if (this.matchKeyword('BETWEEN')) {
        const start = this.parseFrameBound();
        this.expectKeyword('AND');
        const end = this.parseFrameBound();
        frame = { type: frameType, start, end };
      } else {
        // Single bound: e.g. ROWS UNBOUNDED PRECEDING or ROWS 3 PRECEDING
        const start = this.parseFrameBound();
        frame = { type: frameType, start };
      }
    }
    this.expect(TokenType.RPAREN);
    return { partitionBy, orderBy, frame };
  }

  private parseFrameBound(): import('./ASTNode').FrameBound {
    if (this.matchKeyword('UNBOUNDED')) {
      if (this.matchKeyword('PRECEDING')) return { type: 'UNBOUNDED_PRECEDING' };
      this.expectKeyword('FOLLOWING');
      return { type: 'UNBOUNDED_FOLLOWING' };
    }
    if (this.matchKeyword('CURRENT')) {
      this.expectKeyword('ROW');
      return { type: 'CURRENT_ROW' };
    }
    // Numeric offset: e.g. 3 PRECEDING or 3 FOLLOWING
    const value = this.parseExpression();
    if (this.matchKeyword('PRECEDING')) return { type: 'PRECEDING', value };
    this.expectKeyword('FOLLOWING');
    return { type: 'FOLLOWING', value };
  }

  // ── Helpers ───────────────────────────────────────────────────────

  protected parseExpressionList(): Expression[] {
    const exprs: Expression[] = [];
    do { exprs.push(this.parseExpression()); } while (this.match(TokenType.COMMA));
    return exprs;
  }

  protected parseIdentifierList(): string[] {
    const ids: string[] = [];
    do { ids.push(this.expectIdentifier()); } while (this.match(TokenType.COMMA));
    return ids;
  }

  protected parseAssignmentList(): Assignment[] {
    const assignments: Assignment[] = [];
    do {
      const pos = this.current().position;
      const column = this.expectIdentifier();
      this.expect(TokenType.COMPARISON_OP, '=');
      const value = this.parseExpression();
      assignments.push({ type: 'Assignment', position: pos, column, value });
    } while (this.match(TokenType.COMMA));
    return assignments;
  }

  protected parseTableRefSimple(): TableRef {
    const pos = this.current().position;
    let schema: string | undefined;
    let name = this.expectIdentifier();
    if (this.match(TokenType.DOT)) { schema = name; name = this.expectIdentifier(); }
    const alias = this.parseOptionalAlias();
    return { type: 'TableRef', position: pos, schema, name, alias };
  }

  protected parseOptionalAlias(): string | undefined {
    if (this.matchKeyword('AS')) return this.expectIdentifierOrString();
    if (this.check(TokenType.IDENTIFIER) && !this.isStatementBoundary()) {
      return this.advance().value;
    }
    return undefined;
  }

  /** Check if the current token starts a new clause (WHERE, ORDER, etc.). */
  protected isStatementBoundary(): boolean {
    if (!this.check(TokenType.KEYWORD)) return false;
    const kw = this.current().value;
    return ['FROM', 'WHERE', 'GROUP', 'HAVING', 'ORDER', 'UNION', 'INTERSECT', 'MINUS', 'EXCEPT',
      'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'NATURAL', 'ON', 'SET',
      'VALUES', 'INTO', 'RETURNING', 'FOR', 'FETCH', 'OFFSET', 'CONNECT', 'START',
      'WHEN', 'THEN', 'ELSE', 'END', 'AND', 'OR', 'NOT',
      'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'GRANT', 'REVOKE',
    ].includes(kw);
  }

  // ── Token consumption helpers ─────────────────────────────────────

  protected current(): Token {
    return this.tokens[this.pos] ?? { type: TokenType.EOF, value: '', position: { offset: 0, line: 0, column: 0 } };
  }

  protected peekNext(): Token | undefined {
    return this.tokens[this.pos + 1];
  }

  protected peekAt(offset: number): Token | undefined {
    return this.tokens[this.pos + offset];
  }

  protected advance(): Token {
    const t = this.current();
    this.pos++;
    return t;
  }

  protected check(type: TokenType): boolean {
    return this.current().type === type;
  }

  protected checkKeyword(keyword: string): boolean {
    return this.current().type === TokenType.KEYWORD && this.current().value === keyword;
  }

  protected match(type: TokenType): boolean {
    if (this.check(type)) { this.advance(); return true; }
    return false;
  }

  protected matchKeyword(keyword: string): boolean {
    if (this.checkKeyword(keyword)) { this.advance(); return true; }
    // Also match identifiers that are non-reserved keywords
    if (this.current().type === TokenType.IDENTIFIER && this.current().value.toUpperCase() === keyword) {
      this.advance(); return true;
    }
    return false;
  }

  protected expect(type: TokenType, value?: string): Token {
    if (value) {
      if (this.current().type !== type || this.current().value !== value) {
        throw this.error(`Expected '${value}'`, type.toString(), this.current().value);
      }
    } else if (this.current().type !== type) {
      throw this.error(`Expected ${type}`, type.toString(), `${this.current().type}:${this.current().value}`);
    }
    return this.advance();
  }

  protected expectKeyword(keyword: string): Token {
    if (!this.matchKeyword(keyword)) {
      throw this.error(`Expected keyword '${keyword}'`, keyword, this.current().value);
    }
    return this.tokens[this.pos - 1];
  }

  protected expectIdentifier(): string {
    const t = this.current();
    if (t.type === TokenType.IDENTIFIER) { this.advance(); return t.value; }
    if (t.type === TokenType.QUOTED_IDENTIFIER) { this.advance(); return t.value.slice(1, -1); }
    // Allow non-reserved keywords as identifiers
    if (t.type === TokenType.KEYWORD) { this.advance(); return t.value; }
    throw this.error('Expected identifier', 'IDENTIFIER', `${t.type}:${t.value}`);
  }

  protected expectIdentifierOrKeyword(): string {
    const t = this.current();
    if (t.type === TokenType.IDENTIFIER || t.type === TokenType.KEYWORD || t.type === TokenType.QUOTED_IDENTIFIER) {
      this.advance();
      return t.type === TokenType.QUOTED_IDENTIFIER ? t.value.slice(1, -1) : t.value.toUpperCase();
    }
    throw this.error('Expected identifier or keyword', 'IDENTIFIER', `${t.type}:${t.value}`);
  }

  protected expectIdentifierOrString(): string {
    const t = this.current();
    if (t.type === TokenType.STRING_LITERAL) {
      this.advance();
      return t.value.slice(1, -1).replace(/''/g, "'");
    }
    return this.expectIdentifier();
  }

  protected error(message: string, expected?: string, found?: string): ParserError {
    return new ParserError(message, this.current().position, expected, found);
  }
}
