/**
 * Generic SQL Parser - Parses SQL tokens into AST
 */

import { SQLToken, SQLTokenType, tokenizeSQL } from './lexer';
import {
  SQLStatement,
  SQLExpression,
  SQLValue,
  SelectStatement,
  SelectColumn,
  TableReference,
  OrderByItem,
  InsertStatement,
  UpdateStatement,
  DeleteStatement,
  CreateTableStatement,
  ColumnDefinition,
  ForeignKeyConstraint,
  CheckConstraint,
  IndexDefinition,
  SQLDataType,
} from './types';

export interface ParseResult {
  success: boolean;
  statements: SQLStatement[];
  errors: ParseError[];
}

export interface ParseError {
  message: string;
  line: number;
  column: number;
  token?: SQLToken;
}

export class SQLParser {
  private tokens: SQLToken[] = [];
  private position: number = 0;
  private errors: ParseError[] = [];

  constructor(private input: string) {}

  parse(): ParseResult {
    this.tokens = tokenizeSQL(this.input);
    this.position = 0;
    this.errors = [];

    const statements: SQLStatement[] = [];

    while (!this.isAtEnd()) {
      try {
        const stmt = this.parseStatement();
        if (stmt) {
          statements.push(stmt);
        }
        // Skip semicolons between statements
        while (this.check(SQLTokenType.SEMICOLON)) {
          this.advance();
        }
      } catch (e) {
        // Recover by skipping to next semicolon or end
        this.synchronize();
      }
    }

    return {
      success: this.errors.length === 0,
      statements,
      errors: this.errors
    };
  }

  private parseStatement(): SQLStatement | null {
    if (this.check(SQLTokenType.SELECT)) {
      return this.parseSelect();
    }
    if (this.check(SQLTokenType.INSERT)) {
      return this.parseInsert();
    }
    if (this.check(SQLTokenType.UPDATE)) {
      return this.parseUpdate();
    }
    if (this.check(SQLTokenType.DELETE)) {
      return this.parseDelete();
    }
    if (this.check(SQLTokenType.CREATE)) {
      return this.parseCreate();
    }
    if (this.check(SQLTokenType.DROP)) {
      return this.parseDrop();
    }
    if (this.check(SQLTokenType.ALTER)) {
      return this.parseAlter();
    }
    if (this.check(SQLTokenType.TRUNCATE)) {
      return this.parseTruncate();
    }
    if (this.check(SQLTokenType.GRANT)) {
      return this.parseGrant();
    }
    if (this.check(SQLTokenType.REVOKE)) {
      return this.parseRevoke();
    }
    if (this.check(SQLTokenType.BEGIN)) {
      return this.parseBegin();
    }
    if (this.check(SQLTokenType.COMMIT)) {
      return this.parseCommit();
    }
    if (this.check(SQLTokenType.ROLLBACK)) {
      return this.parseRollback();
    }
    if (this.check(SQLTokenType.SAVEPOINT)) {
      return this.parseSavepoint();
    }
    if (this.check(SQLTokenType.DESCRIBE) || (this.check(SQLTokenType.DESC) && this.peek(1)?.type === SQLTokenType.IDENTIFIER)) {
      return this.parseDescribe();
    }
    if (this.check(SQLTokenType.SHOW)) {
      return this.parseShow();
    }
    if (this.check(SQLTokenType.SET)) {
      return this.parseSet();
    }
    if (this.check(SQLTokenType.USE)) {
      return this.parseUse();
    }

    // If no statement recognized, report error
    const token = this.current();
    this.error(`Unexpected token: ${token.value}`, token);
    return null;
  }

  // SELECT statement parser
  private parseSelect(): SelectStatement {
    this.expect(SQLTokenType.SELECT);

    const distinct = this.match(SQLTokenType.DISTINCT);
    if (!distinct) {
      this.match(SQLTokenType.ALL); // Optional ALL keyword
    }

    // Parse column list
    const columns = this.parseSelectColumns();

    // FROM clause
    let from: TableReference[] = [];
    if (this.match(SQLTokenType.FROM)) {
      from = this.parseFromClause();
    }

    // WHERE clause
    let where: SQLExpression | undefined;
    if (this.match(SQLTokenType.WHERE)) {
      where = this.parseExpression();
    }

    // GROUP BY clause
    let groupBy: SQLExpression[] | undefined;
    if (this.match(SQLTokenType.GROUP)) {
      this.expect(SQLTokenType.BY);
      groupBy = this.parseExpressionList();
    }

    // HAVING clause
    let having: SQLExpression | undefined;
    if (this.match(SQLTokenType.HAVING)) {
      having = this.parseExpression();
    }

    // ORDER BY clause
    let orderBy: OrderByItem[] | undefined;
    if (this.match(SQLTokenType.ORDER)) {
      this.expect(SQLTokenType.BY);
      orderBy = this.parseOrderByList();
    }

    // LIMIT clause
    let limit: number | undefined;
    let offset: number | undefined;
    if (this.match(SQLTokenType.LIMIT)) {
      const limitToken = this.expect(SQLTokenType.NUMBER_LITERAL);
      limit = parseInt(limitToken.value, 10);
      if (this.match(SQLTokenType.OFFSET)) {
        const offsetToken = this.expect(SQLTokenType.NUMBER_LITERAL);
        offset = parseInt(offsetToken.value, 10);
      }
    }

    // FOR UPDATE
    const forUpdate = this.match(SQLTokenType.FOR) && this.match(SQLTokenType.UPDATE);

    return {
      type: 'SELECT',
      distinct,
      columns,
      from,
      where,
      groupBy,
      having,
      orderBy,
      limit,
      offset,
      forUpdate
    };
  }

  private parseSelectColumns(): SelectColumn[] {
    const columns: SelectColumn[] = [];

    do {
      if (this.check(SQLTokenType.ASTERISK)) {
        this.advance();
        columns.push({
          expression: { type: 'LITERAL', value: '*' },
          all: true
        });
      } else {
        const expression = this.parseExpression();
        let alias: string | undefined;
        if (this.match(SQLTokenType.AS)) {
          alias = this.parseIdentifier();
        } else if (this.check(SQLTokenType.IDENTIFIER)) {
          // Implicit alias
          alias = this.parseIdentifier();
        }
        columns.push({ expression, alias });
      }
    } while (this.match(SQLTokenType.COMMA));

    return columns;
  }

  private parseFromClause(): TableReference[] {
    const tables: TableReference[] = [];
    tables.push(this.parseTableReference());

    while (this.checkJoinKeyword()) {
      const join = this.parseJoin();
      tables.push(join);
    }

    return tables;
  }

  private parseTableReference(): TableReference {
    let table: string;
    let schema: string | undefined;

    if (this.check(SQLTokenType.LPAREN)) {
      // Subquery
      this.advance();
      const subquery = this.parseSelect();
      this.expect(SQLTokenType.RPAREN);
      let alias: string | undefined;
      if (this.match(SQLTokenType.AS) || this.check(SQLTokenType.IDENTIFIER)) {
        alias = this.parseIdentifier();
      }
      return { table: '', alias, subquery };
    }

    table = this.parseIdentifier();
    if (this.match(SQLTokenType.DOT)) {
      schema = table;
      table = this.parseIdentifier();
    }

    let alias: string | undefined;
    if (this.match(SQLTokenType.AS) || this.check(SQLTokenType.IDENTIFIER)) {
      if (!this.checkJoinKeyword() && !this.check(SQLTokenType.WHERE) &&
          !this.check(SQLTokenType.GROUP) && !this.check(SQLTokenType.ORDER) &&
          !this.check(SQLTokenType.SEMICOLON) && !this.check(SQLTokenType.EOF)) {
        alias = this.parseIdentifier();
      }
    }

    return { table, schema, alias };
  }

  private checkJoinKeyword(): boolean {
    return this.check(SQLTokenType.JOIN) ||
           this.check(SQLTokenType.INNER) ||
           this.check(SQLTokenType.LEFT) ||
           this.check(SQLTokenType.RIGHT) ||
           this.check(SQLTokenType.FULL) ||
           this.check(SQLTokenType.CROSS) ||
           this.check(SQLTokenType.COMMA);
  }

  private parseJoin(): TableReference {
    let joinType: 'INNER' | 'LEFT' | 'RIGHT' | 'FULL' | 'CROSS' = 'INNER';

    if (this.match(SQLTokenType.COMMA)) {
      return this.parseTableReference();
    }

    if (this.match(SQLTokenType.INNER)) {
      joinType = 'INNER';
    } else if (this.match(SQLTokenType.LEFT)) {
      this.match(SQLTokenType.OUTER);
      joinType = 'LEFT';
    } else if (this.match(SQLTokenType.RIGHT)) {
      this.match(SQLTokenType.OUTER);
      joinType = 'RIGHT';
    } else if (this.match(SQLTokenType.FULL)) {
      this.match(SQLTokenType.OUTER);
      joinType = 'FULL';
    } else if (this.match(SQLTokenType.CROSS)) {
      joinType = 'CROSS';
    }

    this.expect(SQLTokenType.JOIN);
    const ref = this.parseTableReference();
    ref.joinType = joinType;

    if (joinType !== 'CROSS' && this.match(SQLTokenType.ON)) {
      ref.joinCondition = this.parseExpression();
    }

    return ref;
  }

  private parseOrderByList(): OrderByItem[] {
    const items: OrderByItem[] = [];

    do {
      const expression = this.parseExpression();
      let direction: 'ASC' | 'DESC' = 'ASC';
      let nulls: 'FIRST' | 'LAST' | undefined;

      if (this.match(SQLTokenType.DESC)) {
        direction = 'DESC';
      } else {
        this.match(SQLTokenType.ASC);
      }

      if (this.match(SQLTokenType.NULLS)) {
        if (this.match(SQLTokenType.FIRST)) {
          nulls = 'FIRST';
        } else if (this.match(SQLTokenType.LAST)) {
          nulls = 'LAST';
        }
      }

      items.push({ expression, direction, nulls });
    } while (this.match(SQLTokenType.COMMA));

    return items;
  }

  // INSERT statement parser
  private parseInsert(): InsertStatement {
    this.expect(SQLTokenType.INSERT);
    this.expect(SQLTokenType.INTO);

    let schema: string | undefined;
    let table = this.parseIdentifier();
    if (this.match(SQLTokenType.DOT)) {
      schema = table;
      table = this.parseIdentifier();
    }

    // Column list
    let columns: string[] | undefined;
    if (this.match(SQLTokenType.LPAREN)) {
      columns = [];
      do {
        columns.push(this.parseIdentifier());
      } while (this.match(SQLTokenType.COMMA));
      this.expect(SQLTokenType.RPAREN);
    }

    // VALUES or SELECT
    let values: SQLValue[][] | undefined;
    let select: SelectStatement | undefined;

    if (this.match(SQLTokenType.VALUES)) {
      values = [];
      do {
        this.expect(SQLTokenType.LPAREN);
        const row: SQLValue[] = [];
        do {
          row.push(this.parseLiteralValue());
        } while (this.match(SQLTokenType.COMMA));
        this.expect(SQLTokenType.RPAREN);
        values.push(row);
      } while (this.match(SQLTokenType.COMMA));
    } else if (this.check(SQLTokenType.SELECT)) {
      select = this.parseSelect();
    }

    return {
      type: 'INSERT',
      table,
      schema,
      columns,
      values,
      select
    };
  }

  // UPDATE statement parser
  private parseUpdate(): UpdateStatement {
    this.expect(SQLTokenType.UPDATE);

    let schema: string | undefined;
    let table = this.parseIdentifier();
    if (this.match(SQLTokenType.DOT)) {
      schema = table;
      table = this.parseIdentifier();
    }

    let alias: string | undefined;
    if (this.match(SQLTokenType.AS) || (this.check(SQLTokenType.IDENTIFIER) && !this.check(SQLTokenType.SET))) {
      alias = this.parseIdentifier();
    }

    this.expect(SQLTokenType.SET);

    // Parse SET clause
    const set: { column: string; value: SQLExpression }[] = [];
    do {
      const column = this.parseIdentifier();
      this.expect(SQLTokenType.EQUAL);
      const value = this.parseExpression();
      set.push({ column, value });
    } while (this.match(SQLTokenType.COMMA));

    // WHERE clause
    let where: SQLExpression | undefined;
    if (this.match(SQLTokenType.WHERE)) {
      where = this.parseExpression();
    }

    return {
      type: 'UPDATE',
      table,
      schema,
      alias,
      set,
      where
    };
  }

  // DELETE statement parser
  private parseDelete(): DeleteStatement {
    this.expect(SQLTokenType.DELETE);
    this.expect(SQLTokenType.FROM);

    let schema: string | undefined;
    let table = this.parseIdentifier();
    if (this.match(SQLTokenType.DOT)) {
      schema = table;
      table = this.parseIdentifier();
    }

    let alias: string | undefined;
    if (this.match(SQLTokenType.AS) || (this.check(SQLTokenType.IDENTIFIER) && !this.check(SQLTokenType.WHERE))) {
      alias = this.parseIdentifier();
    }

    // WHERE clause
    let where: SQLExpression | undefined;
    if (this.match(SQLTokenType.WHERE)) {
      where = this.parseExpression();
    }

    return {
      type: 'DELETE',
      table,
      schema,
      alias,
      where
    };
  }

  // CREATE statement parser
  private parseCreate(): SQLStatement {
    this.expect(SQLTokenType.CREATE);

    const temporary = this.match(SQLTokenType.TEMPORARY) || this.match(SQLTokenType.TEMP);

    if (this.check(SQLTokenType.TABLE)) {
      return this.parseCreateTable(temporary);
    }
    if (this.check(SQLTokenType.VIEW)) {
      return this.parseCreateView();
    }
    if (this.check(SQLTokenType.INDEX) || this.check(SQLTokenType.UNIQUE)) {
      return this.parseCreateIndex();
    }
    if (this.check(SQLTokenType.SEQUENCE)) {
      return this.parseCreateSequence();
    }
    if (this.check(SQLTokenType.USER)) {
      return this.parseCreateUser();
    }
    if (this.check(SQLTokenType.ROLE)) {
      return this.parseCreateRole();
    }
    if (this.check(SQLTokenType.SCHEMA) || this.check(SQLTokenType.DATABASE)) {
      return this.parseCreateSchema();
    }
    if (this.check(SQLTokenType.PROCEDURE) || this.check(SQLTokenType.FUNCTION)) {
      return this.parseCreateProcedure();
    }

    throw this.error('Expected TABLE, VIEW, INDEX, SEQUENCE, USER, ROLE, SCHEMA, or PROCEDURE after CREATE', this.current());
  }

  private parseCreateTable(temporary: boolean): CreateTableStatement {
    this.expect(SQLTokenType.TABLE);

    const ifNotExists = this.match(SQLTokenType.IF) && this.match(SQLTokenType.NOT) && this.match(SQLTokenType.EXISTS);

    let schema: string | undefined;
    let table = this.parseIdentifier();
    if (this.match(SQLTokenType.DOT)) {
      schema = table;
      table = this.parseIdentifier();
    }

    // Check for CREATE TABLE ... AS SELECT
    if (this.match(SQLTokenType.AS)) {
      const asSelect = this.parseSelect();
      return {
        type: 'CREATE_TABLE',
        table,
        schema,
        ifNotExists,
        columns: [],
        foreignKeys: [],
        checkConstraints: [],
        indexes: [],
        temporary,
        asSelect
      };
    }

    this.expect(SQLTokenType.LPAREN);

    const columns: ColumnDefinition[] = [];
    const foreignKeys: ForeignKeyConstraint[] = [];
    const checkConstraints: CheckConstraint[] = [];
    const indexes: IndexDefinition[] = [];
    let primaryKey: string[] | undefined;

    do {
      if (this.check(SQLTokenType.PRIMARY) || this.check(SQLTokenType.FOREIGN) ||
          this.check(SQLTokenType.UNIQUE) || this.check(SQLTokenType.CHECK) ||
          this.check(SQLTokenType.CONSTRAINT)) {
        // Table-level constraint
        const constraint = this.parseTableConstraint();
        if ('columns' in constraint && 'refTable' in constraint) {
          foreignKeys.push(constraint as ForeignKeyConstraint);
        } else if ('expression' in constraint) {
          checkConstraints.push(constraint as CheckConstraint);
        } else if ('columns' in constraint && !('refTable' in constraint)) {
          // Primary key or unique constraint
          if ((constraint as any).isPrimary) {
            primaryKey = (constraint as any).columns;
          } else {
            indexes.push({
              name: (constraint as any).name || '',
              columns: (constraint as any).columns,
              unique: true
            });
          }
        }
      } else {
        // Column definition
        const column = this.parseColumnDefinition();
        columns.push(column);
        if (column.primaryKey) {
          primaryKey = primaryKey || [];
          primaryKey.push(column.name);
        }
      }
    } while (this.match(SQLTokenType.COMMA));

    this.expect(SQLTokenType.RPAREN);

    return {
      type: 'CREATE_TABLE',
      table,
      schema,
      ifNotExists,
      columns,
      primaryKey,
      foreignKeys,
      checkConstraints,
      indexes,
      temporary
    };
  }

  private parseColumnDefinition(): ColumnDefinition {
    const name = this.parseIdentifier();
    const dataType = this.parseDataType();

    // Handle SERIAL types (PostgreSQL auto-increment)
    let actualType = dataType.type;
    let isAutoIncrement = false;
    const upperType = dataType.type.toUpperCase();
    if (upperType === 'SERIAL' || upperType === 'SERIAL4') {
      actualType = 'INTEGER';
      isAutoIncrement = true;
    } else if (upperType === 'SMALLSERIAL' || upperType === 'SERIAL2') {
      actualType = 'SMALLINT';
      isAutoIncrement = true;
    } else if (upperType === 'BIGSERIAL' || upperType === 'SERIAL8') {
      actualType = 'BIGINT';
      isAutoIncrement = true;
    }

    const column: ColumnDefinition = {
      name,
      dataType: actualType,
      length: dataType.length,
      precision: dataType.precision,
      scale: dataType.scale,
      nullable: true,
      primaryKey: false,
      unique: false,
      autoIncrement: isAutoIncrement
    };

    // Parse column constraints
    while (true) {
      if (this.match(SQLTokenType.NOT)) {
        this.expect(SQLTokenType.NULL);
        column.nullable = false;
      } else if (this.match(SQLTokenType.NULL)) {
        column.nullable = true;
      } else if (this.match(SQLTokenType.PRIMARY)) {
        this.expect(SQLTokenType.KEY);
        column.primaryKey = true;
        column.nullable = false;
      } else if (this.match(SQLTokenType.UNIQUE)) {
        column.unique = true;
      } else if (this.match(SQLTokenType.DEFAULT)) {
        column.defaultValue = this.parseLiteralValue();
      } else if (this.match(SQLTokenType.REFERENCES)) {
        const refTable = this.parseIdentifier();
        this.expect(SQLTokenType.LPAREN);
        const refColumn = this.parseIdentifier();
        this.expect(SQLTokenType.RPAREN);
        column.references = { table: refTable, column: refColumn };
        // Parse ON DELETE / ON UPDATE
        while (this.match(SQLTokenType.ON)) {
          if (this.match(SQLTokenType.DELETE)) {
            column.references.onDelete = this.parseReferentialAction();
          } else if (this.match(SQLTokenType.UPDATE)) {
            column.references.onUpdate = this.parseReferentialAction();
          }
        }
      } else if (this.match(SQLTokenType.CHECK)) {
        this.expect(SQLTokenType.LPAREN);
        column.check = this.parseExpressionAsString();
        this.expect(SQLTokenType.RPAREN);
      } else {
        break;
      }
    }

    return column;
  }

  private parseDataType(): { type: SQLDataType; length?: number; precision?: number; scale?: number } {
    const typeToken = this.advance();
    let type: SQLDataType;

    switch (typeToken.type) {
      case SQLTokenType.INTEGER:
      case SQLTokenType.INT:
        type = 'INTEGER';
        break;
      case SQLTokenType.BIGINT:
        type = 'BIGINT';
        break;
      case SQLTokenType.SMALLINT:
        type = 'SMALLINT';
        break;
      case SQLTokenType.TINYINT:
        type = 'TINYINT';
        break;
      case SQLTokenType.DECIMAL:
      case SQLTokenType.NUMERIC:
        type = 'DECIMAL';
        break;
      case SQLTokenType.FLOAT:
        type = 'FLOAT';
        break;
      case SQLTokenType.DOUBLE:
        type = 'DOUBLE';
        break;
      case SQLTokenType.REAL:
        type = 'REAL';
        break;
      case SQLTokenType.CHAR:
        type = 'CHAR';
        break;
      case SQLTokenType.VARCHAR:
        type = 'VARCHAR';
        break;
      case SQLTokenType.TEXT:
        type = 'TEXT';
        break;
      case SQLTokenType.CLOB:
        type = 'CLOB';
        break;
      case SQLTokenType.DATE:
        type = 'DATE';
        break;
      case SQLTokenType.TIME:
        type = 'TIME';
        break;
      case SQLTokenType.TIMESTAMP:
        type = 'TIMESTAMP';
        break;
      case SQLTokenType.DATETIME:
        type = 'DATETIME';
        break;
      case SQLTokenType.BOOLEAN:
        type = 'BOOLEAN';
        break;
      case SQLTokenType.BLOB:
        type = 'BLOB';
        break;
      case SQLTokenType.BINARY:
        type = 'BINARY';
        break;
      case SQLTokenType.VARBINARY:
        type = 'VARBINARY';
        break;
      case SQLTokenType.JSON:
        type = 'JSON';
        break;
      case SQLTokenType.XML:
        type = 'XML';
        break;
      case SQLTokenType.IDENTIFIER:
        // Allow vendor-specific types
        type = typeToken.value.toUpperCase() as SQLDataType;
        break;
      default:
        type = 'VARCHAR';
    }

    let length: number | undefined;
    let precision: number | undefined;
    let scale: number | undefined;

    // Parse optional length/precision
    if (this.match(SQLTokenType.LPAREN)) {
      const first = this.expect(SQLTokenType.NUMBER_LITERAL);
      precision = parseInt(first.value, 10);
      length = precision;

      if (this.match(SQLTokenType.COMMA)) {
        const second = this.expect(SQLTokenType.NUMBER_LITERAL);
        scale = parseInt(second.value, 10);
      }

      this.expect(SQLTokenType.RPAREN);
    }

    return { type, length, precision, scale };
  }

  private parseReferentialAction(): 'CASCADE' | 'SET NULL' | 'SET DEFAULT' | 'RESTRICT' | 'NO ACTION' {
    if (this.match(SQLTokenType.CASCADE)) {
      return 'CASCADE';
    }
    if (this.match(SQLTokenType.SET)) {
      if (this.match(SQLTokenType.NULL)) {
        return 'SET NULL';
      }
      if (this.match(SQLTokenType.DEFAULT)) {
        return 'SET DEFAULT';
      }
    }
    if (this.match(SQLTokenType.RESTRICT)) {
      return 'RESTRICT';
    }
    if (this.match(SQLTokenType.NO)) {
      this.expect(SQLTokenType.ACTION);
      return 'NO ACTION';
    }
    return 'NO ACTION';
  }

  private parseTableConstraint(): ForeignKeyConstraint | CheckConstraint | { name?: string; columns: string[]; isPrimary?: boolean } {
    let name: string | undefined;

    if (this.match(SQLTokenType.CONSTRAINT)) {
      name = this.parseIdentifier();
    }

    if (this.match(SQLTokenType.PRIMARY)) {
      this.expect(SQLTokenType.KEY);
      this.expect(SQLTokenType.LPAREN);
      const columns: string[] = [];
      do {
        columns.push(this.parseIdentifier());
      } while (this.match(SQLTokenType.COMMA));
      this.expect(SQLTokenType.RPAREN);
      return { name, columns, isPrimary: true };
    }

    if (this.match(SQLTokenType.UNIQUE)) {
      this.expect(SQLTokenType.LPAREN);
      const columns: string[] = [];
      do {
        columns.push(this.parseIdentifier());
      } while (this.match(SQLTokenType.COMMA));
      this.expect(SQLTokenType.RPAREN);
      return { name, columns };
    }

    if (this.match(SQLTokenType.FOREIGN)) {
      this.expect(SQLTokenType.KEY);
      this.expect(SQLTokenType.LPAREN);
      const columns: string[] = [];
      do {
        columns.push(this.parseIdentifier());
      } while (this.match(SQLTokenType.COMMA));
      this.expect(SQLTokenType.RPAREN);

      this.expect(SQLTokenType.REFERENCES);
      const refTable = this.parseIdentifier();

      this.expect(SQLTokenType.LPAREN);
      const refColumns: string[] = [];
      do {
        refColumns.push(this.parseIdentifier());
      } while (this.match(SQLTokenType.COMMA));
      this.expect(SQLTokenType.RPAREN);

      const fk: ForeignKeyConstraint = {
        name: name || `fk_${columns.join('_')}`,
        columns,
        refTable,
        refColumns
      };

      while (this.match(SQLTokenType.ON)) {
        if (this.match(SQLTokenType.DELETE)) {
          fk.onDelete = this.parseReferentialAction();
        } else if (this.match(SQLTokenType.UPDATE)) {
          fk.onUpdate = this.parseReferentialAction();
        }
      }

      return fk;
    }

    if (this.match(SQLTokenType.CHECK)) {
      this.expect(SQLTokenType.LPAREN);
      const expression = this.parseExpressionAsString();
      this.expect(SQLTokenType.RPAREN);
      return { name: name || 'check_constraint', expression } as CheckConstraint;
    }

    throw this.error('Expected PRIMARY, UNIQUE, FOREIGN, or CHECK', this.current());
  }

  // Stub methods for other CREATE types
  private parseCreateView(): SQLStatement {
    this.advance(); // VIEW
    const name = this.parseIdentifier();
    // Simplified - just store the AS SELECT
    this.expect(SQLTokenType.AS);
    const query = this.parseSelect();
    return { type: 'CREATE_VIEW', name, query } as any;
  }

  private parseCreateIndex(): SQLStatement {
    const unique = this.match(SQLTokenType.UNIQUE);
    this.expect(SQLTokenType.INDEX);
    const name = this.parseIdentifier();
    this.expect(SQLTokenType.ON);
    const table = this.parseIdentifier();
    this.expect(SQLTokenType.LPAREN);
    const columns: string[] = [];
    do {
      columns.push(this.parseIdentifier());
      this.match(SQLTokenType.ASC) || this.match(SQLTokenType.DESC);
    } while (this.match(SQLTokenType.COMMA));
    this.expect(SQLTokenType.RPAREN);
    return { type: 'CREATE_INDEX', name, table, columns, unique } as any;
  }

  private parseCreateSequence(): SQLStatement {
    this.advance(); // SEQUENCE
    const name = this.parseIdentifier();
    return { type: 'CREATE_SEQUENCE', name, startWith: 1, incrementBy: 1 } as any;
  }

  private parseCreateUser(): SQLStatement {
    this.advance(); // USER
    const name = this.parseIdentifier();
    return { type: 'CREATE_USER', name } as any;
  }

  private parseCreateRole(): SQLStatement {
    this.advance(); // ROLE
    const name = this.parseIdentifier();
    return { type: 'CREATE_ROLE', name } as any;
  }

  private parseCreateSchema(): SQLStatement {
    this.advance(); // SCHEMA or DATABASE
    const name = this.parseIdentifier();
    return { type: 'CREATE_SCHEMA', name } as any;
  }

  private parseCreateProcedure(): SQLStatement {
    const isFunction = this.match(SQLTokenType.FUNCTION);
    if (!isFunction) this.advance(); // PROCEDURE
    const name = this.parseIdentifier();
    return { type: isFunction ? 'CREATE_FUNCTION' : 'CREATE_PROCEDURE', name } as any;
  }

  // DROP statement
  private parseDrop(): SQLStatement {
    this.expect(SQLTokenType.DROP);
    const objectType = this.advance().value;
    const ifExists = this.match(SQLTokenType.IF) && this.match(SQLTokenType.EXISTS);
    const name = this.parseIdentifier();
    const cascade = this.match(SQLTokenType.CASCADE);
    return { type: `DROP_${objectType}` as any, name, ifExists, cascade } as any;
  }

  // ALTER statement
  private parseAlter(): SQLStatement {
    this.expect(SQLTokenType.ALTER);
    const objectType = this.advance().value;
    const name = this.parseIdentifier();
    return { type: `ALTER_${objectType}` as any, name } as any;
  }

  // TRUNCATE statement
  private parseTruncate(): SQLStatement {
    this.expect(SQLTokenType.TRUNCATE);
    this.match(SQLTokenType.TABLE);
    const table = this.parseIdentifier();
    return { type: 'TRUNCATE', table } as any;
  }

  // GRANT statement
  private parseGrant(): SQLStatement {
    this.expect(SQLTokenType.GRANT);
    const privileges: string[] = [];
    do {
      privileges.push(this.advance().value);
    } while (this.match(SQLTokenType.COMMA));
    this.expect(SQLTokenType.ON);
    const objectType = this.advance().value;
    const objectName = this.parseIdentifier();
    this.expect(SQLTokenType.TO);
    const grantee = this.parseIdentifier();
    const withGrantOption = this.match(SQLTokenType.WITH) && this.match(SQLTokenType.GRANT) && this.match(SQLTokenType.OPTION);
    return { type: 'GRANT', privileges, objectType, objectName, grantee, withGrantOption } as any;
  }

  // REVOKE statement
  private parseRevoke(): SQLStatement {
    this.expect(SQLTokenType.REVOKE);
    const privileges: string[] = [];
    do {
      privileges.push(this.advance().value);
    } while (this.match(SQLTokenType.COMMA));
    this.expect(SQLTokenType.ON);
    const objectType = this.advance().value;
    const objectName = this.parseIdentifier();
    this.expect(SQLTokenType.FROM);
    const grantee = this.parseIdentifier();
    return { type: 'REVOKE', privileges, objectType, objectName, grantee } as any;
  }

  // Transaction statements
  private parseBegin(): SQLStatement {
    this.expect(SQLTokenType.BEGIN);
    this.match(SQLTokenType.TRANSACTION);
    return { type: 'BEGIN' } as any;
  }

  private parseCommit(): SQLStatement {
    this.expect(SQLTokenType.COMMIT);
    return { type: 'COMMIT' } as any;
  }

  private parseRollback(): SQLStatement {
    this.expect(SQLTokenType.ROLLBACK);
    let savepoint: string | undefined;
    if (this.match(SQLTokenType.TO)) {
      this.match(SQLTokenType.SAVEPOINT);
      savepoint = this.parseIdentifier();
    }
    return { type: 'ROLLBACK', savepoint } as any;
  }

  private parseSavepoint(): SQLStatement {
    this.expect(SQLTokenType.SAVEPOINT);
    const name = this.parseIdentifier();
    return { type: 'SAVEPOINT', name } as any;
  }

  // Utility statements
  private parseDescribe(): SQLStatement {
    this.advance(); // DESCRIBE or DESC
    const table = this.parseIdentifier();
    return { type: 'DESCRIBE', table } as any;
  }

  private parseShow(): SQLStatement {
    this.expect(SQLTokenType.SHOW);
    const what = this.advance().value;
    return { type: 'SHOW', what } as any;
  }

  private parseSet(): SQLStatement {
    this.expect(SQLTokenType.SET);
    const variable = this.parseIdentifier();
    this.match(SQLTokenType.EQUAL) || this.match(SQLTokenType.TO);
    const value = this.parseLiteralValue();
    return { type: 'SET', variable, value } as any;
  }

  private parseUse(): SQLStatement {
    this.expect(SQLTokenType.USE);
    const database = this.parseIdentifier();
    return { type: 'USE', database } as any;
  }

  // Expression parsing
  private parseExpression(): SQLExpression {
    return this.parseOrExpression();
  }

  private parseOrExpression(): SQLExpression {
    let left = this.parseAndExpression();

    while (this.match(SQLTokenType.OR)) {
      const right = this.parseAndExpression();
      left = { type: 'OR', left, right };
    }

    return left;
  }

  private parseAndExpression(): SQLExpression {
    let left = this.parseNotExpression();

    while (this.match(SQLTokenType.AND)) {
      const right = this.parseNotExpression();
      left = { type: 'AND', left, right };
    }

    return left;
  }

  private parseNotExpression(): SQLExpression {
    if (this.match(SQLTokenType.NOT)) {
      const expr = this.parseNotExpression();
      return { type: 'NOT', left: expr };
    }
    return this.parseComparisonExpression();
  }

  private parseComparisonExpression(): SQLExpression {
    let left = this.parseAdditionExpression();

    if (this.match(SQLTokenType.IS)) {
      const not = this.match(SQLTokenType.NOT);
      this.expect(SQLTokenType.NULL);
      return { type: 'IS_NULL', left, operator: not ? 'IS NOT NULL' : 'IS NULL' };
    }

    if (this.match(SQLTokenType.IN)) {
      this.expect(SQLTokenType.LPAREN);
      const values: SQLExpression[] = [];
      do {
        values.push(this.parseExpression());
      } while (this.match(SQLTokenType.COMMA));
      this.expect(SQLTokenType.RPAREN);
      return { type: 'IN', left, arguments: values };
    }

    if (this.match(SQLTokenType.BETWEEN)) {
      const low = this.parseAdditionExpression();
      this.expect(SQLTokenType.AND);
      const high = this.parseAdditionExpression();
      return { type: 'BETWEEN', left, arguments: [low, high] };
    }

    if (this.match(SQLTokenType.LIKE)) {
      const pattern = this.parseAdditionExpression();
      return { type: 'LIKE', left, right: pattern };
    }

    const operators = [
      SQLTokenType.EQUAL,
      SQLTokenType.NOT_EQUAL,
      SQLTokenType.LESS_THAN,
      SQLTokenType.LESS_THAN_OR_EQUAL,
      SQLTokenType.GREATER_THAN,
      SQLTokenType.GREATER_THAN_OR_EQUAL
    ];

    for (const op of operators) {
      if (this.match(op)) {
        const operator = this.previous().value;
        const right = this.parseAdditionExpression();
        return { type: 'BINARY_OP', left, right, operator };
      }
    }

    return left;
  }

  private parseAdditionExpression(): SQLExpression {
    let left = this.parseMultiplicationExpression();

    while (this.match(SQLTokenType.PLUS) || this.match(SQLTokenType.MINUS) || this.match(SQLTokenType.CONCAT)) {
      const operator = this.previous().value;
      const right = this.parseMultiplicationExpression();
      left = { type: 'BINARY_OP', left, right, operator };
    }

    return left;
  }

  private parseMultiplicationExpression(): SQLExpression {
    let left = this.parseUnaryExpression();

    while (this.match(SQLTokenType.ASTERISK) || this.match(SQLTokenType.DIVIDE) || this.match(SQLTokenType.MODULO)) {
      const operator = this.previous().value;
      const right = this.parseUnaryExpression();
      left = { type: 'BINARY_OP', left, right, operator };
    }

    return left;
  }

  private parseUnaryExpression(): SQLExpression {
    if (this.match(SQLTokenType.MINUS)) {
      const expr = this.parseUnaryExpression();
      return { type: 'UNARY_OP', left: expr, operator: '-' };
    }
    if (this.match(SQLTokenType.PLUS)) {
      return this.parseUnaryExpression();
    }
    return this.parsePrimaryExpression();
  }

  private parsePrimaryExpression(): SQLExpression {
    // Parenthesized expression or subquery
    if (this.match(SQLTokenType.LPAREN)) {
      if (this.check(SQLTokenType.SELECT)) {
        const subquery = this.parseSelect();
        this.expect(SQLTokenType.RPAREN);
        return { type: 'SUBQUERY', value: subquery as any };
      }
      const expr = this.parseExpression();
      this.expect(SQLTokenType.RPAREN);
      return expr;
    }

    // CASE expression
    if (this.match(SQLTokenType.CASE)) {
      return this.parseCaseExpression();
    }

    // CAST expression
    if (this.match(SQLTokenType.CAST)) {
      this.expect(SQLTokenType.LPAREN);
      const expr = this.parseExpression();
      this.expect(SQLTokenType.AS);
      const dataType = this.parseDataType();
      this.expect(SQLTokenType.RPAREN);
      return { type: 'CAST', left: expr, name: dataType.type };
    }

    // EXISTS
    if (this.match(SQLTokenType.EXISTS)) {
      this.expect(SQLTokenType.LPAREN);
      const subquery = this.parseSelect();
      this.expect(SQLTokenType.RPAREN);
      return { type: 'EXISTS', value: subquery as any };
    }

    // NULL
    if (this.match(SQLTokenType.NULL)) {
      return { type: 'LITERAL', value: null };
    }

    // Boolean literals
    if (this.match(SQLTokenType.TRUE)) {
      return { type: 'LITERAL', value: true };
    }
    if (this.match(SQLTokenType.FALSE)) {
      return { type: 'LITERAL', value: false };
    }

    // String literal
    if (this.check(SQLTokenType.STRING_LITERAL)) {
      const token = this.advance();
      return { type: 'LITERAL', value: token.value };
    }

    // Number literal
    if (this.check(SQLTokenType.NUMBER_LITERAL)) {
      const token = this.advance();
      const value = token.value.includes('.') || token.value.includes('e') || token.value.includes('E')
        ? parseFloat(token.value)
        : parseInt(token.value, 10);
      return { type: 'LITERAL', value };
    }

    // Bind variable
    if (this.check(SQLTokenType.BIND_VARIABLE)) {
      const token = this.advance();
      return { type: 'PARAMETER', name: token.value };
    }

    // Parameter
    if (this.check(SQLTokenType.PARAMETER)) {
      const token = this.advance();
      return { type: 'PARAMETER', name: token.value };
    }

    // Identifier (column reference or function call)
    if (this.check(SQLTokenType.IDENTIFIER) || this.check(SQLTokenType.QUOTED_IDENTIFIER)) {
      return this.parseIdentifierOrFunction();
    }

    // Asterisk (for SELECT *)
    if (this.check(SQLTokenType.ASTERISK)) {
      this.advance();
      return { type: 'LITERAL', value: '*' };
    }

    throw this.error('Expected expression', this.current());
  }

  private parseCaseExpression(): SQLExpression {
    const whenClauses: { when: SQLExpression; then: SQLExpression }[] = [];
    let elseExpr: SQLExpression | undefined;

    // Simple CASE or searched CASE
    let caseExpr: SQLExpression | undefined;
    if (!this.check(SQLTokenType.WHEN)) {
      caseExpr = this.parseExpression();
    }

    while (this.match(SQLTokenType.WHEN)) {
      const when = this.parseExpression();
      this.expect(SQLTokenType.THEN);
      const then = this.parseExpression();
      whenClauses.push({ when, then });
    }

    if (this.match(SQLTokenType.ELSE)) {
      elseExpr = this.parseExpression();
    }

    this.expect(SQLTokenType.END);

    return { type: 'CASE', left: caseExpr, arguments: whenClauses.map(w => w.when), value: { whenClauses, elseExpr } as any };
  }

  private parseIdentifierOrFunction(): SQLExpression {
    let name = this.parseIdentifier();
    let schema: string | undefined;

    // Check for schema.name or table.column
    if (this.match(SQLTokenType.DOT)) {
      if (this.check(SQLTokenType.ASTERISK)) {
        // table.*
        this.advance();
        return { type: 'COLUMN_REF', name: '*', alias: name };
      }
      schema = name;
      name = this.parseIdentifier();

      // Check for schema.table.column
      if (this.match(SQLTokenType.DOT)) {
        const column = this.parseIdentifier();
        return { type: 'COLUMN_REF', name: column, alias: `${schema}.${name}` };
      }

      return { type: 'COLUMN_REF', name, alias: schema };
    }

    // Check for function call
    if (this.match(SQLTokenType.LPAREN)) {
      const args: SQLExpression[] = [];

      // Handle aggregate functions with DISTINCT
      const distinct = this.match(SQLTokenType.DISTINCT);

      if (!this.check(SQLTokenType.RPAREN)) {
        // Handle special case of COUNT(*)
        if (this.check(SQLTokenType.ASTERISK)) {
          this.advance();
          args.push({ type: 'LITERAL', value: '*' });
        } else {
          do {
            args.push(this.parseExpression());
          } while (this.match(SQLTokenType.COMMA));
        }
      }

      this.expect(SQLTokenType.RPAREN);

      const funcExpr: SQLExpression = {
        type: 'FUNCTION_CALL',
        name: name.toUpperCase(),
        arguments: args
      };

      // Handle window functions with OVER clause
      if (this.match(SQLTokenType.OVER)) {
        // Simplified OVER clause handling
        this.expect(SQLTokenType.LPAREN);
        while (!this.check(SQLTokenType.RPAREN)) {
          this.advance();
        }
        this.expect(SQLTokenType.RPAREN);
      }

      return funcExpr;
    }

    // Plain column reference
    return { type: 'COLUMN_REF', name };
  }

  private parseExpressionList(): SQLExpression[] {
    const expressions: SQLExpression[] = [];
    do {
      expressions.push(this.parseExpression());
    } while (this.match(SQLTokenType.COMMA));
    return expressions;
  }

  private parseExpressionAsString(): string {
    const start = this.position;
    let depth = 1;
    while (depth > 0 && !this.isAtEnd()) {
      if (this.check(SQLTokenType.LPAREN)) depth++;
      if (this.check(SQLTokenType.RPAREN)) depth--;
      if (depth > 0) this.advance();
    }
    return this.tokens.slice(start, this.position).map(t => t.value).join(' ');
  }

  // Helper methods
  private parseIdentifier(): string {
    if (this.check(SQLTokenType.IDENTIFIER)) {
      return this.advance().value;
    }
    if (this.check(SQLTokenType.QUOTED_IDENTIFIER)) {
      return this.advance().value;
    }
    // Allow keywords as identifiers in certain contexts
    const token = this.current();
    if (token.type !== SQLTokenType.EOF && token.type !== SQLTokenType.SEMICOLON) {
      return this.advance().value;
    }
    throw this.error('Expected identifier', this.current());
  }

  private parseLiteralValue(): SQLValue {
    if (this.match(SQLTokenType.NULL)) {
      return null;
    }
    if (this.match(SQLTokenType.TRUE)) {
      return true;
    }
    if (this.match(SQLTokenType.FALSE)) {
      return false;
    }
    if (this.check(SQLTokenType.STRING_LITERAL)) {
      return this.advance().value;
    }
    if (this.check(SQLTokenType.NUMBER_LITERAL)) {
      const token = this.advance();
      return token.value.includes('.') ? parseFloat(token.value) : parseInt(token.value, 10);
    }
    // For expressions used as default values
    const expr = this.parseExpression();
    if (expr.type === 'LITERAL') {
      return expr.value as SQLValue;
    }
    return null;
  }

  private current(): SQLToken {
    return this.tokens[this.position] || { type: SQLTokenType.EOF, value: '', line: 0, column: 0, position: 0 };
  }

  private previous(): SQLToken {
    return this.tokens[this.position - 1];
  }

  private peek(offset: number): SQLToken | undefined {
    return this.tokens[this.position + offset];
  }

  private isAtEnd(): boolean {
    return this.current().type === SQLTokenType.EOF;
  }

  private check(type: SQLTokenType): boolean {
    return this.current().type === type;
  }

  private match(type: SQLTokenType): boolean {
    if (this.check(type)) {
      this.advance();
      return true;
    }
    return false;
  }

  private advance(): SQLToken {
    if (!this.isAtEnd()) {
      this.position++;
    }
    return this.previous();
  }

  private expect(type: SQLTokenType): SQLToken {
    if (this.check(type)) {
      return this.advance();
    }
    throw this.error(`Expected ${type}`, this.current());
  }

  private error(message: string, token: SQLToken): ParseError {
    const error: ParseError = {
      message,
      line: token.line,
      column: token.column,
      token
    };
    this.errors.push(error);
    return error;
  }

  private synchronize(): void {
    this.advance();
    while (!this.isAtEnd()) {
      if (this.previous().type === SQLTokenType.SEMICOLON) return;
      switch (this.current().type) {
        case SQLTokenType.SELECT:
        case SQLTokenType.INSERT:
        case SQLTokenType.UPDATE:
        case SQLTokenType.DELETE:
        case SQLTokenType.CREATE:
        case SQLTokenType.DROP:
        case SQLTokenType.ALTER:
        case SQLTokenType.GRANT:
        case SQLTokenType.REVOKE:
        case SQLTokenType.BEGIN:
        case SQLTokenType.COMMIT:
        case SQLTokenType.ROLLBACK:
          return;
      }
      this.advance();
    }
  }
}

/**
 * Parse SQL input into AST
 */
export function parseSQL(input: string): ParseResult {
  const parser = new SQLParser(input);
  return parser.parse();
}
