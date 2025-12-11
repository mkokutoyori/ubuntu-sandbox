/**
 * Python Lexer - Tokenisation du code Python
 */

import { SyntaxError } from './errors';

// Token types
export enum TokenType {
  // Literals
  NUMBER = 'NUMBER',
  STRING = 'STRING',
  FSTRING = 'FSTRING',

  // Identifiers and Keywords
  IDENTIFIER = 'IDENTIFIER',
  KEYWORD = 'KEYWORD',

  // Operators
  PLUS = 'PLUS',           // +
  MINUS = 'MINUS',         // -
  STAR = 'STAR',           // *
  SLASH = 'SLASH',         // /
  DOUBLESLASH = 'DOUBLESLASH', // //
  PERCENT = 'PERCENT',     // %
  DOUBLESTAR = 'DOUBLESTAR', // **
  AT = 'AT',               // @

  // Comparison
  EQ = 'EQ',               // ==
  NE = 'NE',               // !=
  LT = 'LT',               // <
  GT = 'GT',               // >
  LE = 'LE',               // <=
  GE = 'GE',               // >=

  // Assignment
  ASSIGN = 'ASSIGN',       // =
  PLUSEQ = 'PLUSEQ',       // +=
  MINUSEQ = 'MINUSEQ',     // -=
  STAREQ = 'STAREQ',       // *=
  SLASHEQ = 'SLASHEQ',     // /=
  DOUBLESLASHEQ = 'DOUBLESLASHEQ', // //=
  PERCENTEQ = 'PERCENTEQ', // %=
  DOUBLESTAREQ = 'DOUBLESTAREQ', // **=
  AMPEQ = 'AMPEQ',         // &=
  PIPEEQ = 'PIPEEQ',       // |=
  CARETEQ = 'CARETEQ',     // ^=
  RSHIFTEQ = 'RSHIFTEQ',   // >>=
  LSHIFTEQ = 'LSHIFTEQ',   // <<=
  WALRUS = 'WALRUS',       // :=

  // Bitwise
  AMP = 'AMP',             // &
  PIPE = 'PIPE',           // |
  CARET = 'CARET',         // ^
  TILDE = 'TILDE',         // ~
  LSHIFT = 'LSHIFT',       // <<
  RSHIFT = 'RSHIFT',       // >>

  // Delimiters
  LPAREN = 'LPAREN',       // (
  RPAREN = 'RPAREN',       // )
  LBRACKET = 'LBRACKET',   // [
  RBRACKET = 'RBRACKET',   // ]
  LBRACE = 'LBRACE',       // {
  RBRACE = 'RBRACE',       // }
  COMMA = 'COMMA',         // ,
  COLON = 'COLON',         // :
  SEMICOLON = 'SEMICOLON', // ;
  DOT = 'DOT',             // .
  ARROW = 'ARROW',         // ->
  ELLIPSIS = 'ELLIPSIS',   // ...

  // Indentation
  INDENT = 'INDENT',
  DEDENT = 'DEDENT',
  NEWLINE = 'NEWLINE',

  // Special
  EOF = 'EOF',
  COMMENT = 'COMMENT',
}

// Python keywords
export const KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await',
  'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except',
  'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is',
  'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try',
  'while', 'with', 'yield'
]);

// Token interface
export interface Token {
  type: TokenType;
  value: string | number;
  line: number;
  column: number;
}

// Lexer class
export class Lexer {
  private source: string;
  private pos: number = 0;
  private line: number = 1;
  private column: number = 1;
  private tokens: Token[] = [];
  private indentStack: number[] = [0];
  private atLineStart: boolean = true;
  private parenDepth: number = 0;

  constructor(source: string) {
    this.source = source;
  }

  tokenize(): Token[] {
    while (!this.isAtEnd()) {
      this.scanToken();
    }

    // Handle remaining dedents
    while (this.indentStack.length > 1) {
      this.indentStack.pop();
      this.tokens.push(this.makeToken(TokenType.DEDENT, ''));
    }

    // Add final newline if needed
    if (this.tokens.length > 0 && this.tokens[this.tokens.length - 1].type !== TokenType.NEWLINE) {
      this.tokens.push(this.makeToken(TokenType.NEWLINE, '\n'));
    }

    this.tokens.push(this.makeToken(TokenType.EOF, ''));
    return this.tokens;
  }

  private scanToken(): void {
    // Handle indentation at line start
    if (this.atLineStart && this.parenDepth === 0) {
      this.handleIndentation();
      this.atLineStart = false;
    }

    this.skipWhitespace();

    if (this.isAtEnd()) return;

    const char = this.peek();

    // Skip comments
    if (char === '#') {
      this.skipComment();
      return;
    }

    // Handle newlines
    if (char === '\n') {
      if (this.parenDepth === 0) {
        this.tokens.push(this.makeToken(TokenType.NEWLINE, '\n'));
      }
      this.advance();
      this.line++;
      this.column = 1;
      this.atLineStart = true;
      return;
    }

    // Handle carriage return
    if (char === '\r') {
      this.advance();
      if (this.peek() === '\n') {
        this.advance();
      }
      if (this.parenDepth === 0) {
        this.tokens.push(this.makeToken(TokenType.NEWLINE, '\n'));
      }
      this.line++;
      this.column = 1;
      this.atLineStart = true;
      return;
    }

    // Numbers
    if (this.isDigit(char) || (char === '.' && this.isDigit(this.peekNext()))) {
      this.scanNumber();
      return;
    }

    // Strings
    if (char === '"' || char === "'") {
      this.scanString();
      return;
    }

    // f-strings
    if ((char === 'f' || char === 'F' || char === 'r' || char === 'R' || char === 'b' || char === 'B') &&
        (this.peekNext() === '"' || this.peekNext() === "'")) {
      this.scanString();
      return;
    }

    // Identifiers and keywords
    if (this.isAlpha(char) || char === '_') {
      this.scanIdentifier();
      return;
    }

    // Operators and delimiters
    this.scanOperator();
  }

  private handleIndentation(): void {
    let indent = 0;
    while (!this.isAtEnd() && (this.peek() === ' ' || this.peek() === '\t')) {
      if (this.peek() === ' ') {
        indent++;
      } else {
        indent += 8 - (indent % 8);  // Tab is 8 spaces
      }
      this.advance();
    }

    // Skip blank lines and comment-only lines
    if (this.isAtEnd() || this.peek() === '\n' || this.peek() === '\r' || this.peek() === '#') {
      return;
    }

    const currentIndent = this.indentStack[this.indentStack.length - 1];

    if (indent > currentIndent) {
      this.indentStack.push(indent);
      this.tokens.push(this.makeToken(TokenType.INDENT, ''));
    } else if (indent < currentIndent) {
      while (this.indentStack.length > 1 && this.indentStack[this.indentStack.length - 1] > indent) {
        this.indentStack.pop();
        this.tokens.push(this.makeToken(TokenType.DEDENT, ''));
      }
      if (this.indentStack[this.indentStack.length - 1] !== indent) {
        throw new SyntaxError('unindent does not match any outer indentation level', this.line, this.column);
      }
    }
  }

  private skipWhitespace(): void {
    while (!this.isAtEnd()) {
      const char = this.peek();
      if (char === ' ' || char === '\t') {
        this.advance();
      } else if (char === '\\' && this.peekNext() === '\n') {
        // Line continuation
        this.advance();
        this.advance();
        this.line++;
        this.column = 1;
      } else {
        break;
      }
    }
  }

  private skipComment(): void {
    while (!this.isAtEnd() && this.peek() !== '\n') {
      this.advance();
    }
  }

  private scanNumber(): void {
    const startColumn = this.column;
    let value = '';
    let isFloat = false;

    // Handle hex, octal, binary
    if (this.peek() === '0') {
      value += this.advance();
      if (this.peek() === 'x' || this.peek() === 'X') {
        value += this.advance();
        while (this.isHexDigit(this.peek())) {
          value += this.advance();
        }
        this.tokens.push({
          type: TokenType.NUMBER,
          value: parseInt(value, 16),
          line: this.line,
          column: startColumn
        });
        return;
      } else if (this.peek() === 'o' || this.peek() === 'O') {
        value += this.advance();
        while (this.isOctDigit(this.peek())) {
          value += this.advance();
        }
        this.tokens.push({
          type: TokenType.NUMBER,
          value: parseInt(value.slice(2), 8),
          line: this.line,
          column: startColumn
        });
        return;
      } else if (this.peek() === 'b' || this.peek() === 'B') {
        value += this.advance();
        while (this.peek() === '0' || this.peek() === '1') {
          value += this.advance();
        }
        this.tokens.push({
          type: TokenType.NUMBER,
          value: parseInt(value.slice(2), 2),
          line: this.line,
          column: startColumn
        });
        return;
      }
    }

    // Regular number
    while (this.isDigit(this.peek()) || this.peek() === '_') {
      if (this.peek() !== '_') {
        value += this.advance();
      } else {
        this.advance();
      }
    }

    // Decimal part
    if (this.peek() === '.' && this.isDigit(this.peekNext())) {
      isFloat = true;
      value += this.advance();
      while (this.isDigit(this.peek()) || this.peek() === '_') {
        if (this.peek() !== '_') {
          value += this.advance();
        } else {
          this.advance();
        }
      }
    }

    // Exponent
    if (this.peek() === 'e' || this.peek() === 'E') {
      isFloat = true;
      value += this.advance();
      if (this.peek() === '+' || this.peek() === '-') {
        value += this.advance();
      }
      while (this.isDigit(this.peek())) {
        value += this.advance();
      }
    }

    // Complex numbers (j suffix)
    if (this.peek() === 'j' || this.peek() === 'J') {
      value += this.advance();
      // For now, treat complex as float
      isFloat = true;
    }

    this.tokens.push({
      type: TokenType.NUMBER,
      value: isFloat ? parseFloat(value) : parseInt(value, 10),
      line: this.line,
      column: startColumn
    });
  }

  private scanString(): void {
    const startColumn = this.column;
    let prefix = '';
    let isFString = false;

    // Check for prefix
    if (this.peek() === 'f' || this.peek() === 'F') {
      prefix = this.advance();
      isFString = true;
    } else if (this.peek() === 'r' || this.peek() === 'R') {
      prefix = this.advance();
    } else if (this.peek() === 'b' || this.peek() === 'B') {
      prefix = this.advance();
    }

    // Additional prefix
    if ((this.peek() === 'r' || this.peek() === 'R') && !prefix.toLowerCase().includes('r')) {
      prefix += this.advance();
    } else if ((this.peek() === 'f' || this.peek() === 'F') && !prefix.toLowerCase().includes('f')) {
      prefix += this.advance();
      isFString = true;
    }

    const quote = this.advance();
    let isTriple = false;

    // Check for triple quotes
    if (this.peek() === quote && this.peekNext() === quote) {
      this.advance();
      this.advance();
      isTriple = true;
    }

    let value = '';
    const isRaw = prefix.toLowerCase().includes('r');

    while (!this.isAtEnd()) {
      const char = this.peek();

      if (isTriple) {
        if (char === quote && this.peekNext() === quote && this.peekAt(2) === quote) {
          this.advance();
          this.advance();
          this.advance();
          break;
        }
      } else {
        if (char === quote) {
          this.advance();
          break;
        }
        if (char === '\n') {
          throw new SyntaxError('EOL while scanning string literal', this.line, this.column);
        }
      }

      if (char === '\\' && !isRaw) {
        this.advance();
        const escaped = this.advance();
        switch (escaped) {
          case 'n': value += '\n'; break;
          case 't': value += '\t'; break;
          case 'r': value += '\r'; break;
          case '\\': value += '\\'; break;
          case "'": value += "'"; break;
          case '"': value += '"'; break;
          case '0': value += '\0'; break;
          case 'x': {
            const hex = this.advance() + this.advance();
            value += String.fromCharCode(parseInt(hex, 16));
            break;
          }
          case 'u': {
            const hex = this.advance() + this.advance() + this.advance() + this.advance();
            value += String.fromCharCode(parseInt(hex, 16));
            break;
          }
          default:
            value += '\\' + escaped;
        }
      } else {
        if (char === '\n') {
          this.line++;
          this.column = 0;
        }
        value += this.advance();
      }
    }

    this.tokens.push({
      type: isFString ? TokenType.FSTRING : TokenType.STRING,
      value,
      line: this.line,
      column: startColumn
    });
  }

  private scanIdentifier(): void {
    const startColumn = this.column;
    let value = '';

    while (this.isAlphaNumeric(this.peek()) || this.peek() === '_') {
      value += this.advance();
    }

    const type = KEYWORDS.has(value) ? TokenType.KEYWORD : TokenType.IDENTIFIER;
    this.tokens.push({
      type,
      value,
      line: this.line,
      column: startColumn
    });
  }

  private scanOperator(): void {
    const startColumn = this.column;
    const char = this.advance();

    let type: TokenType;
    let value = char;

    switch (char) {
      case '+':
        if (this.peek() === '=') {
          value += this.advance();
          type = TokenType.PLUSEQ;
        } else {
          type = TokenType.PLUS;
        }
        break;

      case '-':
        if (this.peek() === '=') {
          value += this.advance();
          type = TokenType.MINUSEQ;
        } else if (this.peek() === '>') {
          value += this.advance();
          type = TokenType.ARROW;
        } else {
          type = TokenType.MINUS;
        }
        break;

      case '*':
        if (this.peek() === '*') {
          value += this.advance();
          if (this.peek() === '=') {
            value += this.advance();
            type = TokenType.DOUBLESTAREQ;
          } else {
            type = TokenType.DOUBLESTAR;
          }
        } else if (this.peek() === '=') {
          value += this.advance();
          type = TokenType.STAREQ;
        } else {
          type = TokenType.STAR;
        }
        break;

      case '/':
        if (this.peek() === '/') {
          value += this.advance();
          if (this.peek() === '=') {
            value += this.advance();
            type = TokenType.DOUBLESLASHEQ;
          } else {
            type = TokenType.DOUBLESLASH;
          }
        } else if (this.peek() === '=') {
          value += this.advance();
          type = TokenType.SLASHEQ;
        } else {
          type = TokenType.SLASH;
        }
        break;

      case '%':
        if (this.peek() === '=') {
          value += this.advance();
          type = TokenType.PERCENTEQ;
        } else {
          type = TokenType.PERCENT;
        }
        break;

      case '@':
        type = TokenType.AT;
        break;

      case '=':
        if (this.peek() === '=') {
          value += this.advance();
          type = TokenType.EQ;
        } else {
          type = TokenType.ASSIGN;
        }
        break;

      case '!':
        if (this.peek() === '=') {
          value += this.advance();
          type = TokenType.NE;
        } else {
          throw new SyntaxError(`invalid character '${char}'`, this.line, startColumn);
        }
        break;

      case '<':
        if (this.peek() === '=') {
          value += this.advance();
          type = TokenType.LE;
        } else if (this.peek() === '<') {
          value += this.advance();
          if (this.peek() === '=') {
            value += this.advance();
            type = TokenType.LSHIFTEQ;
          } else {
            type = TokenType.LSHIFT;
          }
        } else {
          type = TokenType.LT;
        }
        break;

      case '>':
        if (this.peek() === '=') {
          value += this.advance();
          type = TokenType.GE;
        } else if (this.peek() === '>') {
          value += this.advance();
          if (this.peek() === '=') {
            value += this.advance();
            type = TokenType.RSHIFTEQ;
          } else {
            type = TokenType.RSHIFT;
          }
        } else {
          type = TokenType.GT;
        }
        break;

      case '&':
        if (this.peek() === '=') {
          value += this.advance();
          type = TokenType.AMPEQ;
        } else {
          type = TokenType.AMP;
        }
        break;

      case '|':
        if (this.peek() === '=') {
          value += this.advance();
          type = TokenType.PIPEEQ;
        } else {
          type = TokenType.PIPE;
        }
        break;

      case '^':
        if (this.peek() === '=') {
          value += this.advance();
          type = TokenType.CARETEQ;
        } else {
          type = TokenType.CARET;
        }
        break;

      case '~':
        type = TokenType.TILDE;
        break;

      case ':':
        if (this.peek() === '=') {
          value += this.advance();
          type = TokenType.WALRUS;
        } else {
          type = TokenType.COLON;
        }
        break;

      case '(':
        this.parenDepth++;
        type = TokenType.LPAREN;
        break;

      case ')':
        this.parenDepth = Math.max(0, this.parenDepth - 1);
        type = TokenType.RPAREN;
        break;

      case '[':
        this.parenDepth++;
        type = TokenType.LBRACKET;
        break;

      case ']':
        this.parenDepth = Math.max(0, this.parenDepth - 1);
        type = TokenType.RBRACKET;
        break;

      case '{':
        this.parenDepth++;
        type = TokenType.LBRACE;
        break;

      case '}':
        this.parenDepth = Math.max(0, this.parenDepth - 1);
        type = TokenType.RBRACE;
        break;

      case ',':
        type = TokenType.COMMA;
        break;

      case ';':
        type = TokenType.SEMICOLON;
        break;

      case '.':
        if (this.peek() === '.' && this.peekNext() === '.') {
          value += this.advance() + this.advance();
          type = TokenType.ELLIPSIS;
        } else {
          type = TokenType.DOT;
        }
        break;

      default:
        throw new SyntaxError(`invalid character '${char}'`, this.line, startColumn);
    }

    this.tokens.push({ type, value, line: this.line, column: startColumn });
  }

  private makeToken(type: TokenType, value: string | number): Token {
    return { type, value, line: this.line, column: this.column };
  }

  private isAtEnd(): boolean {
    return this.pos >= this.source.length;
  }

  private peek(): string {
    if (this.isAtEnd()) return '\0';
    return this.source[this.pos];
  }

  private peekNext(): string {
    if (this.pos + 1 >= this.source.length) return '\0';
    return this.source[this.pos + 1];
  }

  private peekAt(offset: number): string {
    if (this.pos + offset >= this.source.length) return '\0';
    return this.source[this.pos + offset];
  }

  private advance(): string {
    const char = this.source[this.pos];
    this.pos++;
    this.column++;
    return char;
  }

  private isDigit(char: string): boolean {
    return char >= '0' && char <= '9';
  }

  private isHexDigit(char: string): boolean {
    return this.isDigit(char) || (char >= 'a' && char <= 'f') || (char >= 'A' && char <= 'F');
  }

  private isOctDigit(char: string): boolean {
    return char >= '0' && char <= '7';
  }

  private isAlpha(char: string): boolean {
    return (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z');
  }

  private isAlphaNumeric(char: string): boolean {
    return this.isAlpha(char) || this.isDigit(char);
  }
}

// Convenience function
export function tokenize(source: string): Token[] {
  const lexer = new Lexer(source);
  return lexer.tokenize();
}
