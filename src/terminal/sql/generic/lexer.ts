/**
 * Generic SQL Lexer - Tokenizes SQL statements
 */

export enum SQLTokenType {
  // Keywords
  SELECT = 'SELECT',
  INSERT = 'INSERT',
  UPDATE = 'UPDATE',
  DELETE = 'DELETE',
  FROM = 'FROM',
  WHERE = 'WHERE',
  AND = 'AND',
  OR = 'OR',
  NOT = 'NOT',
  IN = 'IN',
  BETWEEN = 'BETWEEN',
  LIKE = 'LIKE',
  IS = 'IS',
  NULL = 'NULL',
  TRUE = 'TRUE',
  FALSE = 'FALSE',
  AS = 'AS',
  ON = 'ON',
  JOIN = 'JOIN',
  INNER = 'INNER',
  LEFT = 'LEFT',
  RIGHT = 'RIGHT',
  FULL = 'FULL',
  OUTER = 'OUTER',
  CROSS = 'CROSS',
  GROUP = 'GROUP',
  BY = 'BY',
  HAVING = 'HAVING',
  ORDER = 'ORDER',
  ASC = 'ASC',
  DESC = 'DESC',
  LIMIT = 'LIMIT',
  OFFSET = 'OFFSET',
  DISTINCT = 'DISTINCT',
  ALL = 'ALL',
  UNION = 'UNION',
  INTERSECT = 'INTERSECT',
  EXCEPT = 'EXCEPT',
  INTO = 'INTO',
  VALUES = 'VALUES',
  SET = 'SET',
  CREATE = 'CREATE',
  ALTER = 'ALTER',
  DROP = 'DROP',
  TABLE = 'TABLE',
  VIEW = 'VIEW',
  INDEX = 'INDEX',
  SEQUENCE = 'SEQUENCE',
  SCHEMA = 'SCHEMA',
  DATABASE = 'DATABASE',
  PROCEDURE = 'PROCEDURE',
  FUNCTION = 'FUNCTION',
  TRIGGER = 'TRIGGER',
  USER = 'USER',
  ROLE = 'ROLE',
  IF = 'IF',
  EXISTS = 'EXISTS',
  PRIMARY = 'PRIMARY',
  FOREIGN = 'FOREIGN',
  KEY = 'KEY',
  REFERENCES = 'REFERENCES',
  UNIQUE = 'UNIQUE',
  CHECK = 'CHECK',
  DEFAULT = 'DEFAULT',
  CONSTRAINT = 'CONSTRAINT',
  CASCADE = 'CASCADE',
  RESTRICT = 'RESTRICT',
  NO = 'NO',
  ACTION = 'ACTION',
  NULLS = 'NULLS',
  FIRST = 'FIRST',
  LAST = 'LAST',
  BEGIN = 'BEGIN',
  COMMIT = 'COMMIT',
  ROLLBACK = 'ROLLBACK',
  SAVEPOINT = 'SAVEPOINT',
  TRANSACTION = 'TRANSACTION',
  GRANT = 'GRANT',
  REVOKE = 'REVOKE',
  TO = 'TO',
  WITH = 'WITH',
  OPTION = 'OPTION',
  ADMIN = 'ADMIN',
  TRUNCATE = 'TRUNCATE',
  DESCRIBE = 'DESCRIBE',
  EXPLAIN = 'EXPLAIN',
  SHOW = 'SHOW',
  USE = 'USE',
  CALL = 'CALL',
  EXECUTE = 'EXECUTE',
  CASE = 'CASE',
  WHEN = 'WHEN',
  THEN = 'THEN',
  ELSE = 'ELSE',
  END = 'END',
  CAST = 'CAST',
  CONVERT = 'CONVERT',
  TEMPORARY = 'TEMPORARY',
  TEMP = 'TEMP',
  RETURNING = 'RETURNING',
  FOR = 'FOR',
  ESCAPE = 'ESCAPE',
  RECURSIVE = 'RECURSIVE',
  OVER = 'OVER',
  PARTITION = 'PARTITION',
  ROWS = 'ROWS',
  RANGE = 'RANGE',
  UNBOUNDED = 'UNBOUNDED',
  PRECEDING = 'PRECEDING',
  FOLLOWING = 'FOLLOWING',
  CURRENT = 'CURRENT',
  ROW = 'ROW',

  // Security-related keywords
  IDENTIFIED = 'IDENTIFIED',
  ACCOUNT = 'ACCOUNT',
  LOCK = 'LOCK',
  UNLOCK = 'UNLOCK',
  EXPIRE = 'EXPIRE',
  PASSWORD = 'PASSWORD',
  PROFILE = 'PROFILE',
  QUOTA = 'QUOTA',
  UNLIMITED = 'UNLIMITED',
  TABLESPACE = 'TABLESPACE',
  AUDIT = 'AUDIT',
  NOAUDIT = 'NOAUDIT',
  SESSION = 'SESSION',
  PRIVILEGES = 'PRIVILEGES',
  PUBLIC = 'PUBLIC',

  // Data types (common)
  INTEGER = 'INTEGER',
  INT = 'INT',
  BIGINT = 'BIGINT',
  SMALLINT = 'SMALLINT',
  TINYINT = 'TINYINT',
  DECIMAL = 'DECIMAL',
  NUMERIC = 'NUMERIC',
  FLOAT = 'FLOAT',
  DOUBLE = 'DOUBLE',
  REAL = 'REAL',
  CHAR = 'CHAR',
  VARCHAR = 'VARCHAR',
  TEXT = 'TEXT',
  CLOB = 'CLOB',
  DATE = 'DATE',
  TIME = 'TIME',
  TIMESTAMP = 'TIMESTAMP',
  DATETIME = 'DATETIME',
  BOOLEAN = 'BOOLEAN',
  BLOB = 'BLOB',
  BINARY = 'BINARY',
  VARBINARY = 'VARBINARY',
  JSON = 'JSON',
  XML = 'XML',

  // Identifiers and literals
  IDENTIFIER = 'IDENTIFIER',
  QUOTED_IDENTIFIER = 'QUOTED_IDENTIFIER',
  STRING_LITERAL = 'STRING_LITERAL',
  NUMBER_LITERAL = 'NUMBER_LITERAL',
  PARAMETER = 'PARAMETER',
  BIND_VARIABLE = 'BIND_VARIABLE',

  // Operators
  EQUAL = 'EQUAL',
  NOT_EQUAL = 'NOT_EQUAL',
  LESS_THAN = 'LESS_THAN',
  LESS_THAN_OR_EQUAL = 'LESS_THAN_OR_EQUAL',
  GREATER_THAN = 'GREATER_THAN',
  GREATER_THAN_OR_EQUAL = 'GREATER_THAN_OR_EQUAL',
  PLUS = 'PLUS',
  MINUS = 'MINUS',
  MULTIPLY = 'MULTIPLY',
  DIVIDE = 'DIVIDE',
  MODULO = 'MODULO',
  CONCAT = 'CONCAT',
  BITAND = 'BITAND',
  BITOR = 'BITOR',
  BITXOR = 'BITXOR',
  BITNOT = 'BITNOT',

  // Punctuation
  LPAREN = 'LPAREN',
  RPAREN = 'RPAREN',
  LBRACKET = 'LBRACKET',
  RBRACKET = 'RBRACKET',
  COMMA = 'COMMA',
  DOT = 'DOT',
  SEMICOLON = 'SEMICOLON',
  COLON = 'COLON',
  ASTERISK = 'ASTERISK',
  QUESTION = 'QUESTION',
  AT = 'AT',

  // Special
  COMMENT = 'COMMENT',
  NEWLINE = 'NEWLINE',
  WHITESPACE = 'WHITESPACE',
  EOF = 'EOF',
  UNKNOWN = 'UNKNOWN'
}

export interface SQLToken {
  type: SQLTokenType;
  value: string;
  line: number;
  column: number;
  position: number;
}

// SQL keywords map
const SQL_KEYWORDS: Map<string, SQLTokenType> = new Map([
  ['SELECT', SQLTokenType.SELECT],
  ['INSERT', SQLTokenType.INSERT],
  ['UPDATE', SQLTokenType.UPDATE],
  ['DELETE', SQLTokenType.DELETE],
  ['FROM', SQLTokenType.FROM],
  ['WHERE', SQLTokenType.WHERE],
  ['AND', SQLTokenType.AND],
  ['OR', SQLTokenType.OR],
  ['NOT', SQLTokenType.NOT],
  ['IN', SQLTokenType.IN],
  ['BETWEEN', SQLTokenType.BETWEEN],
  ['LIKE', SQLTokenType.LIKE],
  ['IS', SQLTokenType.IS],
  ['NULL', SQLTokenType.NULL],
  ['TRUE', SQLTokenType.TRUE],
  ['FALSE', SQLTokenType.FALSE],
  ['AS', SQLTokenType.AS],
  ['ON', SQLTokenType.ON],
  ['JOIN', SQLTokenType.JOIN],
  ['INNER', SQLTokenType.INNER],
  ['LEFT', SQLTokenType.LEFT],
  ['RIGHT', SQLTokenType.RIGHT],
  ['FULL', SQLTokenType.FULL],
  ['OUTER', SQLTokenType.OUTER],
  ['CROSS', SQLTokenType.CROSS],
  ['GROUP', SQLTokenType.GROUP],
  ['BY', SQLTokenType.BY],
  ['HAVING', SQLTokenType.HAVING],
  ['ORDER', SQLTokenType.ORDER],
  ['ASC', SQLTokenType.ASC],
  ['DESC', SQLTokenType.DESC],
  ['LIMIT', SQLTokenType.LIMIT],
  ['OFFSET', SQLTokenType.OFFSET],
  ['DISTINCT', SQLTokenType.DISTINCT],
  ['ALL', SQLTokenType.ALL],
  ['UNION', SQLTokenType.UNION],
  ['INTERSECT', SQLTokenType.INTERSECT],
  ['EXCEPT', SQLTokenType.EXCEPT],
  ['INTO', SQLTokenType.INTO],
  ['VALUES', SQLTokenType.VALUES],
  ['SET', SQLTokenType.SET],
  ['CREATE', SQLTokenType.CREATE],
  ['ALTER', SQLTokenType.ALTER],
  ['DROP', SQLTokenType.DROP],
  ['TABLE', SQLTokenType.TABLE],
  ['VIEW', SQLTokenType.VIEW],
  ['INDEX', SQLTokenType.INDEX],
  ['SEQUENCE', SQLTokenType.SEQUENCE],
  ['SCHEMA', SQLTokenType.SCHEMA],
  ['DATABASE', SQLTokenType.DATABASE],
  ['PROCEDURE', SQLTokenType.PROCEDURE],
  ['FUNCTION', SQLTokenType.FUNCTION],
  ['TRIGGER', SQLTokenType.TRIGGER],
  ['USER', SQLTokenType.USER],
  ['ROLE', SQLTokenType.ROLE],
  ['IF', SQLTokenType.IF],
  ['EXISTS', SQLTokenType.EXISTS],
  ['PRIMARY', SQLTokenType.PRIMARY],
  ['FOREIGN', SQLTokenType.FOREIGN],
  ['KEY', SQLTokenType.KEY],
  ['REFERENCES', SQLTokenType.REFERENCES],
  ['UNIQUE', SQLTokenType.UNIQUE],
  ['CHECK', SQLTokenType.CHECK],
  ['DEFAULT', SQLTokenType.DEFAULT],
  ['CONSTRAINT', SQLTokenType.CONSTRAINT],
  ['CASCADE', SQLTokenType.CASCADE],
  ['RESTRICT', SQLTokenType.RESTRICT],
  ['NO', SQLTokenType.NO],
  ['ACTION', SQLTokenType.ACTION],
  ['NULLS', SQLTokenType.NULLS],
  ['FIRST', SQLTokenType.FIRST],
  ['LAST', SQLTokenType.LAST],
  ['BEGIN', SQLTokenType.BEGIN],
  ['COMMIT', SQLTokenType.COMMIT],
  ['ROLLBACK', SQLTokenType.ROLLBACK],
  ['SAVEPOINT', SQLTokenType.SAVEPOINT],
  ['TRANSACTION', SQLTokenType.TRANSACTION],
  ['GRANT', SQLTokenType.GRANT],
  ['REVOKE', SQLTokenType.REVOKE],
  ['TO', SQLTokenType.TO],
  ['WITH', SQLTokenType.WITH],
  ['OPTION', SQLTokenType.OPTION],
  ['ADMIN', SQLTokenType.ADMIN],
  ['TRUNCATE', SQLTokenType.TRUNCATE],
  ['DESCRIBE', SQLTokenType.DESCRIBE],
  ['DESC', SQLTokenType.DESC],
  ['EXPLAIN', SQLTokenType.EXPLAIN],
  ['SHOW', SQLTokenType.SHOW],
  ['USE', SQLTokenType.USE],
  ['CALL', SQLTokenType.CALL],
  ['EXECUTE', SQLTokenType.EXECUTE],
  ['EXEC', SQLTokenType.EXECUTE],
  ['CASE', SQLTokenType.CASE],
  ['WHEN', SQLTokenType.WHEN],
  ['THEN', SQLTokenType.THEN],
  ['ELSE', SQLTokenType.ELSE],
  ['END', SQLTokenType.END],
  ['CAST', SQLTokenType.CAST],
  ['CONVERT', SQLTokenType.CONVERT],
  ['TEMPORARY', SQLTokenType.TEMPORARY],
  ['TEMP', SQLTokenType.TEMP],
  ['RETURNING', SQLTokenType.RETURNING],
  ['FOR', SQLTokenType.FOR],
  ['ESCAPE', SQLTokenType.ESCAPE],
  ['RECURSIVE', SQLTokenType.RECURSIVE],
  ['OVER', SQLTokenType.OVER],
  ['PARTITION', SQLTokenType.PARTITION],
  ['ROWS', SQLTokenType.ROWS],
  ['RANGE', SQLTokenType.RANGE],
  ['UNBOUNDED', SQLTokenType.UNBOUNDED],
  ['PRECEDING', SQLTokenType.PRECEDING],
  ['FOLLOWING', SQLTokenType.FOLLOWING],
  ['CURRENT', SQLTokenType.CURRENT],
  ['ROW', SQLTokenType.ROW],
  // Security keywords
  ['IDENTIFIED', SQLTokenType.IDENTIFIED],
  ['ACCOUNT', SQLTokenType.ACCOUNT],
  ['LOCK', SQLTokenType.LOCK],
  ['UNLOCK', SQLTokenType.UNLOCK],
  ['EXPIRE', SQLTokenType.EXPIRE],
  ['PASSWORD', SQLTokenType.PASSWORD],
  ['PROFILE', SQLTokenType.PROFILE],
  ['QUOTA', SQLTokenType.QUOTA],
  ['UNLIMITED', SQLTokenType.UNLIMITED],
  ['TABLESPACE', SQLTokenType.TABLESPACE],
  ['AUDIT', SQLTokenType.AUDIT],
  ['NOAUDIT', SQLTokenType.NOAUDIT],
  ['SESSION', SQLTokenType.SESSION],
  ['PRIVILEGES', SQLTokenType.PRIVILEGES],
  ['PUBLIC', SQLTokenType.PUBLIC],
  // Data types
  ['INTEGER', SQLTokenType.INTEGER],
  ['INT', SQLTokenType.INT],
  ['BIGINT', SQLTokenType.BIGINT],
  ['SMALLINT', SQLTokenType.SMALLINT],
  ['TINYINT', SQLTokenType.TINYINT],
  ['DECIMAL', SQLTokenType.DECIMAL],
  ['NUMERIC', SQLTokenType.NUMERIC],
  ['FLOAT', SQLTokenType.FLOAT],
  ['DOUBLE', SQLTokenType.DOUBLE],
  ['REAL', SQLTokenType.REAL],
  ['CHAR', SQLTokenType.CHAR],
  ['VARCHAR', SQLTokenType.VARCHAR],
  ['TEXT', SQLTokenType.TEXT],
  ['CLOB', SQLTokenType.CLOB],
  ['DATE', SQLTokenType.DATE],
  ['TIME', SQLTokenType.TIME],
  ['TIMESTAMP', SQLTokenType.TIMESTAMP],
  ['DATETIME', SQLTokenType.DATETIME],
  ['BOOLEAN', SQLTokenType.BOOLEAN],
  ['BOOL', SQLTokenType.BOOLEAN],
  ['BLOB', SQLTokenType.BLOB],
  ['BINARY', SQLTokenType.BINARY],
  ['VARBINARY', SQLTokenType.VARBINARY],
  ['JSON', SQLTokenType.JSON],
  ['XML', SQLTokenType.XML],
]);

export class SQLLexer {
  private input: string;
  private position: number = 0;
  private line: number = 1;
  private column: number = 1;
  private tokens: SQLToken[] = [];

  constructor(input: string) {
    this.input = input;
  }

  tokenize(): SQLToken[] {
    this.tokens = [];
    this.position = 0;
    this.line = 1;
    this.column = 1;

    while (this.position < this.input.length) {
      const token = this.nextToken();
      if (token.type !== SQLTokenType.WHITESPACE && token.type !== SQLTokenType.COMMENT) {
        this.tokens.push(token);
      }
    }

    this.tokens.push({
      type: SQLTokenType.EOF,
      value: '',
      line: this.line,
      column: this.column,
      position: this.position
    });

    return this.tokens;
  }

  private nextToken(): SQLToken {
    const startLine = this.line;
    const startColumn = this.column;
    const startPosition = this.position;

    const char = this.input[this.position];

    // Whitespace
    if (/\s/.test(char)) {
      return this.readWhitespace(startLine, startColumn, startPosition);
    }

    // Single-line comment --
    if (char === '-' && this.peek(1) === '-') {
      return this.readLineComment(startLine, startColumn, startPosition);
    }

    // Multi-line comment /* */
    if (char === '/' && this.peek(1) === '*') {
      return this.readBlockComment(startLine, startColumn, startPosition);
    }

    // String literal 'text'
    if (char === "'") {
      return this.readStringLiteral(startLine, startColumn, startPosition);
    }

    // Quoted identifier "identifier" or `identifier`
    if (char === '"' || char === '`') {
      return this.readQuotedIdentifier(startLine, startColumn, startPosition, char);
    }

    // Number
    if (/\d/.test(char) || (char === '.' && /\d/.test(this.peek(1) || ''))) {
      return this.readNumber(startLine, startColumn, startPosition);
    }

    // Identifier or keyword
    if (/[a-zA-Z_]/.test(char)) {
      return this.readIdentifierOrKeyword(startLine, startColumn, startPosition);
    }

    // Bind variable :name or $1
    if (char === ':' && /[a-zA-Z_]/.test(this.peek(1) || '')) {
      return this.readBindVariable(startLine, startColumn, startPosition);
    }
    if (char === '$' && /\d/.test(this.peek(1) || '')) {
      return this.readParameter(startLine, startColumn, startPosition);
    }

    // Operators and punctuation
    return this.readOperatorOrPunctuation(startLine, startColumn, startPosition);
  }

  private readWhitespace(line: number, column: number, position: number): SQLToken {
    let value = '';
    while (this.position < this.input.length && /\s/.test(this.input[this.position])) {
      if (this.input[this.position] === '\n') {
        this.line++;
        this.column = 1;
      } else {
        this.column++;
      }
      value += this.input[this.position];
      this.position++;
    }
    return { type: SQLTokenType.WHITESPACE, value, line, column, position };
  }

  private readLineComment(line: number, column: number, position: number): SQLToken {
    let value = '--';
    this.position += 2;
    this.column += 2;
    while (this.position < this.input.length && this.input[this.position] !== '\n') {
      value += this.input[this.position];
      this.position++;
      this.column++;
    }
    return { type: SQLTokenType.COMMENT, value, line, column, position };
  }

  private readBlockComment(line: number, column: number, position: number): SQLToken {
    let value = '/*';
    this.position += 2;
    this.column += 2;
    while (this.position < this.input.length - 1) {
      if (this.input[this.position] === '*' && this.input[this.position + 1] === '/') {
        value += '*/';
        this.position += 2;
        this.column += 2;
        break;
      }
      if (this.input[this.position] === '\n') {
        this.line++;
        this.column = 1;
      } else {
        this.column++;
      }
      value += this.input[this.position];
      this.position++;
    }
    return { type: SQLTokenType.COMMENT, value, line, column, position };
  }

  private readStringLiteral(line: number, column: number, position: number): SQLToken {
    let value = '';
    this.position++; // skip opening quote
    this.column++;
    while (this.position < this.input.length) {
      const char = this.input[this.position];
      if (char === "'") {
        // Check for escaped quote ''
        if (this.peek(1) === "'") {
          value += "'";
          this.position += 2;
          this.column += 2;
        } else {
          this.position++;
          this.column++;
          break;
        }
      } else {
        if (char === '\n') {
          this.line++;
          this.column = 1;
        } else {
          this.column++;
        }
        value += char;
        this.position++;
      }
    }
    return { type: SQLTokenType.STRING_LITERAL, value, line, column, position };
  }

  private readQuotedIdentifier(line: number, column: number, position: number, quote: string): SQLToken {
    let value = '';
    this.position++; // skip opening quote
    this.column++;
    while (this.position < this.input.length) {
      const char = this.input[this.position];
      if (char === quote) {
        // Check for escaped quote
        if (this.peek(1) === quote) {
          value += quote;
          this.position += 2;
          this.column += 2;
        } else {
          this.position++;
          this.column++;
          break;
        }
      } else {
        this.column++;
        value += char;
        this.position++;
      }
    }
    return { type: SQLTokenType.QUOTED_IDENTIFIER, value, line, column, position };
  }

  private readNumber(line: number, column: number, position: number): SQLToken {
    let value = '';
    let hasDecimal = false;
    let hasExponent = false;

    while (this.position < this.input.length) {
      const char = this.input[this.position];
      if (/\d/.test(char)) {
        value += char;
        this.position++;
        this.column++;
      } else if (char === '.' && !hasDecimal && !hasExponent) {
        hasDecimal = true;
        value += char;
        this.position++;
        this.column++;
      } else if ((char === 'e' || char === 'E') && !hasExponent) {
        hasExponent = true;
        value += char;
        this.position++;
        this.column++;
        // Handle optional sign after exponent
        if (this.position < this.input.length && (this.input[this.position] === '+' || this.input[this.position] === '-')) {
          value += this.input[this.position];
          this.position++;
          this.column++;
        }
      } else {
        break;
      }
    }
    return { type: SQLTokenType.NUMBER_LITERAL, value, line, column, position };
  }

  private readIdentifierOrKeyword(line: number, column: number, position: number): SQLToken {
    let value = '';
    while (this.position < this.input.length && /[a-zA-Z0-9_$#]/.test(this.input[this.position])) {
      value += this.input[this.position];
      this.position++;
      this.column++;
    }

    const upperValue = value.toUpperCase();
    const keywordType = SQL_KEYWORDS.get(upperValue);
    if (keywordType) {
      return { type: keywordType, value: upperValue, line, column, position };
    }
    return { type: SQLTokenType.IDENTIFIER, value, line, column, position };
  }

  private readBindVariable(line: number, column: number, position: number): SQLToken {
    let value = ':';
    this.position++;
    this.column++;
    while (this.position < this.input.length && /[a-zA-Z0-9_]/.test(this.input[this.position])) {
      value += this.input[this.position];
      this.position++;
      this.column++;
    }
    return { type: SQLTokenType.BIND_VARIABLE, value, line, column, position };
  }

  private readParameter(line: number, column: number, position: number): SQLToken {
    let value = '$';
    this.position++;
    this.column++;
    while (this.position < this.input.length && /\d/.test(this.input[this.position])) {
      value += this.input[this.position];
      this.position++;
      this.column++;
    }
    return { type: SQLTokenType.PARAMETER, value, line, column, position };
  }

  private readOperatorOrPunctuation(line: number, column: number, position: number): SQLToken {
    const char = this.input[this.position];
    const next = this.peek(1);

    let type: SQLTokenType;
    let value: string;

    switch (char) {
      case '(':
        type = SQLTokenType.LPAREN;
        value = char;
        break;
      case ')':
        type = SQLTokenType.RPAREN;
        value = char;
        break;
      case '[':
        type = SQLTokenType.LBRACKET;
        value = char;
        break;
      case ']':
        type = SQLTokenType.RBRACKET;
        value = char;
        break;
      case ',':
        type = SQLTokenType.COMMA;
        value = char;
        break;
      case '.':
        type = SQLTokenType.DOT;
        value = char;
        break;
      case ';':
        type = SQLTokenType.SEMICOLON;
        value = char;
        break;
      case ':':
        type = SQLTokenType.COLON;
        value = char;
        break;
      case '*':
        type = SQLTokenType.ASTERISK;
        value = char;
        break;
      case '?':
        type = SQLTokenType.QUESTION;
        value = char;
        break;
      case '@':
        type = SQLTokenType.AT;
        value = char;
        break;
      case '+':
        type = SQLTokenType.PLUS;
        value = char;
        break;
      case '-':
        type = SQLTokenType.MINUS;
        value = char;
        break;
      case '/':
        type = SQLTokenType.DIVIDE;
        value = char;
        break;
      case '%':
        type = SQLTokenType.MODULO;
        value = char;
        break;
      case '&':
        type = SQLTokenType.BITAND;
        value = char;
        break;
      case '|':
        if (next === '|') {
          type = SQLTokenType.CONCAT;
          value = '||';
          this.position++;
          this.column++;
        } else {
          type = SQLTokenType.BITOR;
          value = char;
        }
        break;
      case '^':
        type = SQLTokenType.BITXOR;
        value = char;
        break;
      case '~':
        type = SQLTokenType.BITNOT;
        value = char;
        break;
      case '=':
        type = SQLTokenType.EQUAL;
        value = char;
        break;
      case '<':
        if (next === '=') {
          type = SQLTokenType.LESS_THAN_OR_EQUAL;
          value = '<=';
          this.position++;
          this.column++;
        } else if (next === '>') {
          type = SQLTokenType.NOT_EQUAL;
          value = '<>';
          this.position++;
          this.column++;
        } else {
          type = SQLTokenType.LESS_THAN;
          value = char;
        }
        break;
      case '>':
        if (next === '=') {
          type = SQLTokenType.GREATER_THAN_OR_EQUAL;
          value = '>=';
          this.position++;
          this.column++;
        } else {
          type = SQLTokenType.GREATER_THAN;
          value = char;
        }
        break;
      case '!':
        if (next === '=') {
          type = SQLTokenType.NOT_EQUAL;
          value = '!=';
          this.position++;
          this.column++;
        } else {
          type = SQLTokenType.UNKNOWN;
          value = char;
        }
        break;
      default:
        type = SQLTokenType.UNKNOWN;
        value = char;
    }

    this.position++;
    this.column++;
    return { type, value, line, column, position };
  }

  private peek(offset: number): string | null {
    const pos = this.position + offset;
    return pos < this.input.length ? this.input[pos] : null;
  }
}

/**
 * Tokenize SQL input
 */
export function tokenizeSQL(input: string): SQLToken[] {
  const lexer = new SQLLexer(input);
  return lexer.tokenize();
}
