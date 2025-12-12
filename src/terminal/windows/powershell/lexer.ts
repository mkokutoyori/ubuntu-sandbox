/**
 * PowerShell Lexer - Tokenization
 */

export enum TokenType {
  // Literals
  NUMBER = 'NUMBER',
  STRING = 'STRING',
  EXPANDABLE_STRING = 'EXPANDABLE_STRING',
  HERE_STRING = 'HERE_STRING',
  VARIABLE = 'VARIABLE',
  IDENTIFIER = 'IDENTIFIER',
  COMMAND = 'COMMAND',

  // Keywords
  IF = 'IF',
  ELSE = 'ELSE',
  ELSEIF = 'ELSEIF',
  WHILE = 'WHILE',
  FOR = 'FOR',
  FOREACH = 'FOREACH',
  DO = 'DO',
  UNTIL = 'UNTIL',
  SWITCH = 'SWITCH',
  FUNCTION = 'FUNCTION',
  PARAM = 'PARAM',
  RETURN = 'RETURN',
  BREAK = 'BREAK',
  CONTINUE = 'CONTINUE',
  THROW = 'THROW',
  TRY = 'TRY',
  CATCH = 'CATCH',
  FINALLY = 'FINALLY',
  BEGIN = 'BEGIN',
  PROCESS = 'PROCESS',
  END = 'END',
  IN = 'IN',
  EXIT = 'EXIT',

  // Operators
  PLUS = 'PLUS',
  MINUS = 'MINUS',
  MULTIPLY = 'MULTIPLY',
  DIVIDE = 'DIVIDE',
  MODULO = 'MODULO',
  ASSIGN = 'ASSIGN',
  PLUS_ASSIGN = 'PLUS_ASSIGN',
  MINUS_ASSIGN = 'MINUS_ASSIGN',
  MULTIPLY_ASSIGN = 'MULTIPLY_ASSIGN',
  DIVIDE_ASSIGN = 'DIVIDE_ASSIGN',

  // Comparison
  EQ = 'EQ',
  NE = 'NE',
  GT = 'GT',
  GE = 'GE',
  LT = 'LT',
  LE = 'LE',
  LIKE = 'LIKE',
  NOTLIKE = 'NOTLIKE',
  MATCH = 'MATCH',
  NOTMATCH = 'NOTMATCH',
  CONTAINS = 'CONTAINS',
  NOTCONTAINS = 'NOTCONTAINS',
  IN_OP = 'IN_OP',
  NOTIN = 'NOTIN',

  // Logical
  AND = 'AND',
  OR = 'OR',
  NOT = 'NOT',
  BAND = 'BAND',
  BOR = 'BOR',
  BXOR = 'BXOR',
  BNOT = 'BNOT',

  // Delimiters
  LPAREN = 'LPAREN',
  RPAREN = 'RPAREN',
  LBRACE = 'LBRACE',
  RBRACE = 'RBRACE',
  LBRACKET = 'LBRACKET',
  RBRACKET = 'RBRACKET',
  COMMA = 'COMMA',
  SEMICOLON = 'SEMICOLON',
  PIPE = 'PIPE',
  DOT = 'DOT',
  DOUBLE_COLON = 'DOUBLE_COLON',
  AT = 'AT',
  HASH = 'HASH',

  // Special
  NEWLINE = 'NEWLINE',
  EOF = 'EOF',
  COMMENT = 'COMMENT',
  PARAMETER = 'PARAMETER',
  SUBEXPRESSION = 'SUBEXPRESSION',
  ARRAY_SUBEXPRESSION = 'ARRAY_SUBEXPRESSION',
}

export interface Token {
  type: TokenType;
  value: string;
  line: number;
  column: number;
}

const KEYWORDS: Record<string, TokenType> = {
  'if': TokenType.IF,
  'else': TokenType.ELSE,
  'elseif': TokenType.ELSEIF,
  'while': TokenType.WHILE,
  'for': TokenType.FOR,
  'foreach': TokenType.FOREACH,
  'do': TokenType.DO,
  'until': TokenType.UNTIL,
  'switch': TokenType.SWITCH,
  'function': TokenType.FUNCTION,
  'param': TokenType.PARAM,
  'return': TokenType.RETURN,
  'break': TokenType.BREAK,
  'continue': TokenType.CONTINUE,
  'throw': TokenType.THROW,
  'try': TokenType.TRY,
  'catch': TokenType.CATCH,
  'finally': TokenType.FINALLY,
  'begin': TokenType.BEGIN,
  'process': TokenType.PROCESS,
  'end': TokenType.END,
  'in': TokenType.IN,
  'exit': TokenType.EXIT,
};

const COMPARISON_OPERATORS: Record<string, TokenType> = {
  '-eq': TokenType.EQ,
  '-ne': TokenType.NE,
  '-gt': TokenType.GT,
  '-ge': TokenType.GE,
  '-lt': TokenType.LT,
  '-le': TokenType.LE,
  '-like': TokenType.LIKE,
  '-notlike': TokenType.NOTLIKE,
  '-match': TokenType.MATCH,
  '-notmatch': TokenType.NOTMATCH,
  '-contains': TokenType.CONTAINS,
  '-notcontains': TokenType.NOTCONTAINS,
  '-in': TokenType.IN_OP,
  '-notin': TokenType.NOTIN,
  '-and': TokenType.AND,
  '-or': TokenType.OR,
  '-not': TokenType.NOT,
  '-band': TokenType.BAND,
  '-bor': TokenType.BOR,
  '-bxor': TokenType.BXOR,
  '-bnot': TokenType.BNOT,
};

export class PSLexer {
  private input: string;
  private pos: number = 0;
  private line: number = 1;
  private column: number = 1;
  private tokens: Token[] = [];

  constructor(input: string) {
    this.input = input;
  }

  tokenize(): Token[] {
    while (this.pos < this.input.length) {
      this.scanToken();
    }

    this.tokens.push({
      type: TokenType.EOF,
      value: '',
      line: this.line,
      column: this.column,
    });

    return this.tokens;
  }

  private peek(offset: number = 0): string {
    return this.input[this.pos + offset] || '';
  }

  private advance(): string {
    const char = this.input[this.pos++];
    if (char === '\n') {
      this.line++;
      this.column = 1;
    } else {
      this.column++;
    }
    return char;
  }

  private addToken(type: TokenType, value: string): void {
    this.tokens.push({
      type,
      value,
      line: this.line,
      column: this.column - value.length,
    });
  }

  private scanToken(): void {
    const char = this.peek();

    // Whitespace (not newline)
    if (char === ' ' || char === '\t' || char === '\r') {
      this.advance();
      return;
    }

    // Newline
    if (char === '\n') {
      this.advance();
      this.addToken(TokenType.NEWLINE, '\n');
      return;
    }

    // Comments
    if (char === '#') {
      this.scanComment();
      return;
    }

    // Block comment
    if (char === '<' && this.peek(1) === '#') {
      this.scanBlockComment();
      return;
    }

    // Variable
    if (char === '$') {
      this.scanVariable();
      return;
    }

    // Parameter (e.g., -Name)
    if (char === '-' && /[a-zA-Z]/.test(this.peek(1))) {
      this.scanParameter();
      return;
    }

    // String
    if (char === '"') {
      this.scanExpandableString();
      return;
    }

    if (char === "'") {
      this.scanLiteralString();
      return;
    }

    // Here-string
    if (char === '@' && (this.peek(1) === '"' || this.peek(1) === "'")) {
      this.scanHereString();
      return;
    }

    // Number
    if (/[0-9]/.test(char) || (char === '.' && /[0-9]/.test(this.peek(1)))) {
      this.scanNumber();
      return;
    }

    // Operators and delimiters
    switch (char) {
      case '+':
        this.advance();
        if (this.peek() === '=') {
          this.advance();
          this.addToken(TokenType.PLUS_ASSIGN, '+=');
        } else {
          this.addToken(TokenType.PLUS, '+');
        }
        return;

      case '-':
        this.advance();
        if (this.peek() === '=') {
          this.advance();
          this.addToken(TokenType.MINUS_ASSIGN, '-=');
        } else {
          this.addToken(TokenType.MINUS, '-');
        }
        return;

      case '*':
        this.advance();
        if (this.peek() === '=') {
          this.advance();
          this.addToken(TokenType.MULTIPLY_ASSIGN, '*=');
        } else {
          this.addToken(TokenType.MULTIPLY, '*');
        }
        return;

      case '/':
        this.advance();
        if (this.peek() === '=') {
          this.advance();
          this.addToken(TokenType.DIVIDE_ASSIGN, '/=');
        } else {
          this.addToken(TokenType.DIVIDE, '/');
        }
        return;

      case '%':
        this.advance();
        this.addToken(TokenType.MODULO, '%');
        return;

      case '=':
        this.advance();
        this.addToken(TokenType.ASSIGN, '=');
        return;

      case '(':
        this.advance();
        this.addToken(TokenType.LPAREN, '(');
        return;

      case ')':
        this.advance();
        this.addToken(TokenType.RPAREN, ')');
        return;

      case '{':
        this.advance();
        this.addToken(TokenType.LBRACE, '{');
        return;

      case '}':
        this.advance();
        this.addToken(TokenType.RBRACE, '}');
        return;

      case '[':
        this.advance();
        this.addToken(TokenType.LBRACKET, '[');
        return;

      case ']':
        this.advance();
        this.addToken(TokenType.RBRACKET, ']');
        return;

      case ',':
        this.advance();
        this.addToken(TokenType.COMMA, ',');
        return;

      case ';':
        this.advance();
        this.addToken(TokenType.SEMICOLON, ';');
        return;

      case '|':
        this.advance();
        this.addToken(TokenType.PIPE, '|');
        return;

      case '.':
        this.advance();
        this.addToken(TokenType.DOT, '.');
        return;

      case ':':
        if (this.peek(1) === ':') {
          this.advance();
          this.advance();
          this.addToken(TokenType.DOUBLE_COLON, '::');
          return;
        }
        break;

      case '@':
        this.advance();
        this.addToken(TokenType.AT, '@');
        return;

      case '!':
        this.advance();
        this.addToken(TokenType.NOT, '!');
        return;
    }

    // Identifier or command
    if (/[a-zA-Z_]/.test(char)) {
      this.scanIdentifier();
      return;
    }

    // Unknown character - skip
    this.advance();
  }

  private scanComment(): void {
    let value = '';
    this.advance(); // #
    while (this.pos < this.input.length && this.peek() !== '\n') {
      value += this.advance();
    }
    this.addToken(TokenType.COMMENT, value);
  }

  private scanBlockComment(): void {
    let value = '';
    this.advance(); // <
    this.advance(); // #

    while (this.pos < this.input.length) {
      if (this.peek() === '#' && this.peek(1) === '>') {
        this.advance(); // #
        this.advance(); // >
        break;
      }
      value += this.advance();
    }

    this.addToken(TokenType.COMMENT, value);
  }

  private scanVariable(): void {
    let value = '';
    this.advance(); // $

    // Handle special variables
    if (this.peek() === '(') {
      // Subexpression $()
      this.advance();
      let depth = 1;
      while (this.pos < this.input.length && depth > 0) {
        if (this.peek() === '(') depth++;
        if (this.peek() === ')') depth--;
        if (depth > 0) value += this.advance();
        else this.advance();
      }
      this.addToken(TokenType.SUBEXPRESSION, value);
      return;
    }

    if (this.peek() === '{') {
      // Variable with braces ${variable}
      this.advance();
      while (this.pos < this.input.length && this.peek() !== '}') {
        value += this.advance();
      }
      this.advance(); // }
      this.addToken(TokenType.VARIABLE, value);
      return;
    }

    // Regular variable
    while (this.pos < this.input.length && /[a-zA-Z0-9_:]/.test(this.peek())) {
      value += this.advance();
    }

    this.addToken(TokenType.VARIABLE, value);
  }

  private scanParameter(): void {
    let value = '';
    this.advance(); // -

    while (this.pos < this.input.length && /[a-zA-Z0-9_]/.test(this.peek())) {
      value += this.advance();
    }

    const operator = '-' + value.toLowerCase();
    if (COMPARISON_OPERATORS[operator]) {
      this.addToken(COMPARISON_OPERATORS[operator], operator);
    } else {
      this.addToken(TokenType.PARAMETER, value);
    }
  }

  private scanExpandableString(): void {
    let value = '';
    this.advance(); // "

    while (this.pos < this.input.length && this.peek() !== '"') {
      if (this.peek() === '`') {
        this.advance(); // escape char
        const escaped = this.advance();
        switch (escaped) {
          case 'n': value += '\n'; break;
          case 'r': value += '\r'; break;
          case 't': value += '\t'; break;
          case '`': value += '`'; break;
          case '"': value += '"'; break;
          case '$': value += '$'; break;
          default: value += escaped;
        }
      } else {
        value += this.advance();
      }
    }

    this.advance(); // closing "
    this.addToken(TokenType.EXPANDABLE_STRING, value);
  }

  private scanLiteralString(): void {
    let value = '';
    this.advance(); // '

    while (this.pos < this.input.length) {
      if (this.peek() === "'") {
        if (this.peek(1) === "'") {
          // Escaped quote
          this.advance();
          this.advance();
          value += "'";
        } else {
          break;
        }
      } else {
        value += this.advance();
      }
    }

    this.advance(); // closing '
    this.addToken(TokenType.STRING, value);
  }

  private scanHereString(): void {
    let value = '';
    this.advance(); // @
    const quoteChar = this.advance(); // " or '

    // Skip to newline
    while (this.pos < this.input.length && this.peek() !== '\n') {
      this.advance();
    }
    this.advance(); // newline

    // Read until closing marker
    const closeMarker = quoteChar + '@';
    while (this.pos < this.input.length) {
      if (this.peek() === quoteChar && this.peek(1) === '@') {
        this.advance();
        this.advance();
        break;
      }
      value += this.advance();
    }

    // Remove trailing newline if present
    if (value.endsWith('\n')) {
      value = value.slice(0, -1);
    }
    if (value.endsWith('\r')) {
      value = value.slice(0, -1);
    }

    this.addToken(TokenType.HERE_STRING, value);
  }

  private scanNumber(): void {
    let value = '';
    let isFloat = false;

    // Handle hex numbers
    if (this.peek() === '0' && (this.peek(1) === 'x' || this.peek(1) === 'X')) {
      value += this.advance();
      value += this.advance();
      while (/[0-9a-fA-F]/.test(this.peek())) {
        value += this.advance();
      }
      this.addToken(TokenType.NUMBER, value);
      return;
    }

    while (/[0-9]/.test(this.peek())) {
      value += this.advance();
    }

    if (this.peek() === '.' && /[0-9]/.test(this.peek(1))) {
      isFloat = true;
      value += this.advance();
      while (/[0-9]/.test(this.peek())) {
        value += this.advance();
      }
    }

    // Scientific notation
    if (this.peek() === 'e' || this.peek() === 'E') {
      value += this.advance();
      if (this.peek() === '+' || this.peek() === '-') {
        value += this.advance();
      }
      while (/[0-9]/.test(this.peek())) {
        value += this.advance();
      }
    }

    // Suffixes (KB, MB, GB, TB)
    const suffix = this.peek().toUpperCase() + (this.peek(1) || '').toUpperCase();
    if (['KB', 'MB', 'GB', 'TB', 'PB'].includes(suffix)) {
      value += this.advance();
      value += this.advance();
    }

    this.addToken(TokenType.NUMBER, value);
  }

  private scanIdentifier(): void {
    let value = '';

    while (this.pos < this.input.length && /[a-zA-Z0-9_\-]/.test(this.peek())) {
      value += this.advance();
    }

    const lower = value.toLowerCase();
    if (KEYWORDS[lower]) {
      this.addToken(KEYWORDS[lower], value);
    } else if (value.includes('-')) {
      // Command with verb-noun format
      this.addToken(TokenType.COMMAND, value);
    } else {
      this.addToken(TokenType.IDENTIFIER, value);
    }
  }
}
