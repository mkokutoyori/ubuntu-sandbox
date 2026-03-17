/**
 * BaseLexer — Abstract tokeniser for SQL text.
 *
 * Handles the universal parts of SQL lexing (whitespace, strings, numbers,
 * comments, operators, identifiers). Subclasses override `isKeyword()` and
 * `scanDialectToken()` for vendor-specific extensions.
 *
 * Design:
 *   - Single-pass, character-by-character scan.
 *   - Produces a flat Token[] array; whitespace/comments can be optionally kept.
 *   - Position tracking (line, column, offset) for error messages.
 */

import { Token, TokenType, SQL_KEYWORDS, type SourcePosition } from './Token';

export abstract class BaseLexer {
  protected input: string = '';
  protected pos: number = 0;
  protected line: number = 1;
  protected column: number = 1;
  protected tokens: Token[] = [];

  /** Dialect-specific keyword set, merged with SQL_KEYWORDS. */
  protected abstract readonly dialectKeywords: Set<string>;

  /**
   * Tokenise the given SQL text.
   * @param skipWhitespace If true, WHITESPACE and NEWLINE tokens are omitted (default: true).
   * @param skipComments   If true, LINE_COMMENT and BLOCK_COMMENT tokens are omitted (default: true).
   */
  tokenize(input: string, skipWhitespace: boolean = true, skipComments: boolean = true): Token[] {
    this.input = input;
    this.pos = 0;
    this.line = 1;
    this.column = 1;
    this.tokens = [];

    while (this.pos < this.input.length) {
      const token = this.scanToken();
      if (!token) {
        // Consume unknown character
        const pos = this.currentPosition();
        const ch = this.advance();
        this.tokens.push({ type: TokenType.UNKNOWN, value: ch, position: pos });
        continue;
      }
      if (skipWhitespace && (token.type === TokenType.WHITESPACE || token.type === TokenType.NEWLINE)) continue;
      if (skipComments && (token.type === TokenType.LINE_COMMENT || token.type === TokenType.BLOCK_COMMENT)) continue;
      this.tokens.push(token);
    }

    this.tokens.push({ type: TokenType.EOF, value: '', position: this.currentPosition() });
    return this.tokens;
  }

  // ── Main scanner ──────────────────────────────────────────────────

  protected scanToken(): Token | null {
    const ch = this.peek();

    // Whitespace
    if (ch === ' ' || ch === '\t' || ch === '\r') return this.scanWhitespace();
    if (ch === '\n') return this.scanNewline();

    // Comments
    if (ch === '-' && this.peekAt(1) === '-') return this.scanLineComment();
    if (ch === '/' && this.peekAt(1) === '*') return this.scanBlockComment();

    // String literals
    if (ch === "'") return this.scanString();
    // Oracle q-quote: q'[...]', q'{...}', etc.
    if ((ch === 'q' || ch === 'Q') && this.peekAt(1) === "'") return this.scanQString();
    // National string literal
    if ((ch === 'N' || ch === 'n') && this.peekAt(1) === "'") return this.scanNString();

    // Numbers
    if (this.isDigit(ch) || (ch === '.' && this.isDigit(this.peekAt(1)))) return this.scanNumber();

    // Double-quoted identifier
    if (ch === '"') return this.scanQuotedIdentifier();

    // Bind variable
    if (ch === ':' && (this.isAlpha(this.peekAt(1)) || this.isDigit(this.peekAt(1)))) return this.scanBindVariable();

    // Multi-character operators
    const multiOp = this.scanMultiCharOperator();
    if (multiOp) return multiOp;

    // Single-character punctuation / operators
    const singleOp = this.scanSingleChar();
    if (singleOp) return singleOp;

    // Identifiers and keywords
    if (this.isIdentStart(ch)) return this.scanIdentifierOrKeyword();

    // Let subclass try dialect-specific tokens
    return this.scanDialectToken();
  }

  /**
   * Override in subclasses to handle dialect-specific tokens
   * that don't fit the standard patterns.
   */
  protected scanDialectToken(): Token | null {
    return null;
  }

  // ── Whitespace & Newlines ─────────────────────────────────────────

  protected scanWhitespace(): Token {
    const pos = this.currentPosition();
    let value = '';
    while (this.pos < this.input.length && (this.peek() === ' ' || this.peek() === '\t' || this.peek() === '\r')) {
      value += this.advance();
    }
    return { type: TokenType.WHITESPACE, value, position: pos };
  }

  protected scanNewline(): Token {
    const pos = this.currentPosition();
    const ch = this.advance(); // consume \n
    return { type: TokenType.NEWLINE, value: ch, position: pos };
  }

  // ── Comments ──────────────────────────────────────────────────────

  protected scanLineComment(): Token {
    const pos = this.currentPosition();
    let value = this.advance() + this.advance(); // consume --
    while (this.pos < this.input.length && this.peek() !== '\n') {
      value += this.advance();
    }
    return { type: TokenType.LINE_COMMENT, value, position: pos };
  }

  protected scanBlockComment(): Token {
    const pos = this.currentPosition();
    let value = this.advance() + this.advance(); // consume /*

    // Check for hint: /*+ ... */
    const isHint = this.pos < this.input.length && this.peek() === '+';

    while (this.pos < this.input.length) {
      if (this.peek() === '*' && this.peekAt(1) === '/') {
        value += this.advance() + this.advance(); // consume */
        return { type: isHint ? TokenType.HINT : TokenType.BLOCK_COMMENT, value, position: pos };
      }
      value += this.advance();
    }
    // Unterminated block comment — return what we have
    return { type: TokenType.BLOCK_COMMENT, value, position: pos };
  }

  // ── String Literals ───────────────────────────────────────────────

  protected scanString(): Token {
    const pos = this.currentPosition();
    let value = this.advance(); // consume opening '
    while (this.pos < this.input.length) {
      const ch = this.advance();
      value += ch;
      if (ch === "'") {
        // Escaped quote ''
        if (this.pos < this.input.length && this.peek() === "'") {
          value += this.advance();
        } else {
          break;
        }
      }
    }
    return { type: TokenType.STRING_LITERAL, value, position: pos };
  }

  /** Oracle q-quote syntax: q'[text]', q'{text}', q'<text>', q'(text)' */
  protected scanQString(): Token {
    const pos = this.currentPosition();
    let value = this.advance(); // q
    value += this.advance(); // '
    if (this.pos >= this.input.length) {
      return { type: TokenType.STRING_LITERAL, value, position: pos };
    }
    const delim = this.advance();
    value += delim;
    const closeDelim = delim === '[' ? ']' : delim === '{' ? '}' : delim === '<' ? '>' : delim === '(' ? ')' : delim;
    while (this.pos < this.input.length) {
      const ch = this.advance();
      value += ch;
      if (ch === closeDelim && this.pos < this.input.length && this.peek() === "'") {
        value += this.advance(); // consume closing '
        break;
      }
    }
    return { type: TokenType.STRING_LITERAL, value, position: pos };
  }

  /** National string literal: N'text' */
  protected scanNString(): Token {
    const pos = this.currentPosition();
    let value = this.advance(); // N
    const strToken = this.scanString();
    return { type: TokenType.STRING_LITERAL, value: value + strToken.value, position: pos };
  }

  // ── Numeric Literals ──────────────────────────────────────────────

  protected scanNumber(): Token {
    const pos = this.currentPosition();
    let value = '';
    // Integer part
    while (this.pos < this.input.length && this.isDigit(this.peek())) {
      value += this.advance();
    }
    // Decimal part
    if (this.pos < this.input.length && this.peek() === '.' && this.isDigit(this.peekAt(1))) {
      value += this.advance(); // .
      while (this.pos < this.input.length && this.isDigit(this.peek())) {
        value += this.advance();
      }
    } else if (this.pos < this.input.length && this.peek() === '.' && value.length === 0) {
      // Leading dot: .5
      value += this.advance();
      while (this.pos < this.input.length && this.isDigit(this.peek())) {
        value += this.advance();
      }
    }
    // Exponent
    if (this.pos < this.input.length && (this.peek() === 'e' || this.peek() === 'E')) {
      value += this.advance();
      if (this.pos < this.input.length && (this.peek() === '+' || this.peek() === '-')) {
        value += this.advance();
      }
      while (this.pos < this.input.length && this.isDigit(this.peek())) {
        value += this.advance();
      }
    }
    return { type: TokenType.NUMBER_LITERAL, value, position: pos };
  }

  // ── Quoted Identifier ─────────────────────────────────────────────

  protected scanQuotedIdentifier(): Token {
    const pos = this.currentPosition();
    let value = this.advance(); // opening "
    while (this.pos < this.input.length && this.peek() !== '"') {
      value += this.advance();
    }
    if (this.pos < this.input.length) value += this.advance(); // closing "
    return { type: TokenType.QUOTED_IDENTIFIER, value, position: pos };
  }

  // ── Bind Variable ─────────────────────────────────────────────────

  protected scanBindVariable(): Token {
    const pos = this.currentPosition();
    let value = this.advance(); // :
    while (this.pos < this.input.length && (this.isAlphaNumeric(this.peek()) || this.peek() === '_')) {
      value += this.advance();
    }
    return { type: TokenType.BIND_VARIABLE, value, position: pos };
  }

  // ── Multi-character Operators ─────────────────────────────────────

  protected scanMultiCharOperator(): Token | null {
    const pos = this.currentPosition();
    const ch = this.peek();
    const next = this.peekAt(1);

    // ||
    if (ch === '|' && next === '|') {
      this.advance(); this.advance();
      return { type: TokenType.CONCAT_OP, value: '||', position: pos };
    }
    // :=
    if (ch === ':' && next === '=') {
      this.advance(); this.advance();
      return { type: TokenType.ASSIGN_OP, value: ':=', position: pos };
    }
    // =>
    if (ch === '=' && next === '>') {
      this.advance(); this.advance();
      return { type: TokenType.ASSOC_OP, value: '=>', position: pos };
    }
    // ..
    if (ch === '.' && next === '.') {
      this.advance(); this.advance();
      return { type: TokenType.RANGE_OP, value: '..', position: pos };
    }
    // <> or !=
    if (ch === '<' && next === '>') {
      this.advance(); this.advance();
      return { type: TokenType.COMPARISON_OP, value: '<>', position: pos };
    }
    if (ch === '!' && next === '=') {
      this.advance(); this.advance();
      return { type: TokenType.COMPARISON_OP, value: '!=', position: pos };
    }
    // <=
    if (ch === '<' && next === '=') {
      this.advance(); this.advance();
      return { type: TokenType.COMPARISON_OP, value: '<=', position: pos };
    }
    // >=
    if (ch === '>' && next === '=') {
      this.advance(); this.advance();
      return { type: TokenType.COMPARISON_OP, value: '>=', position: pos };
    }

    return null;
  }

  // ── Single-character Tokens ───────────────────────────────────────

  protected scanSingleChar(): Token | null {
    const pos = this.currentPosition();
    const ch = this.peek();

    let type: TokenType | null = null;
    switch (ch) {
      case '(': type = TokenType.LPAREN; break;
      case ')': type = TokenType.RPAREN; break;
      case ',': type = TokenType.COMMA; break;
      case ';': type = TokenType.SEMICOLON; break;
      case '.': type = TokenType.DOT; break;
      case '*': type = TokenType.STAR; break;
      case '@': type = TokenType.AT; break;
      case '%': type = TokenType.PERCENT; break;
      case '=': type = TokenType.COMPARISON_OP; break;
      case '<': type = TokenType.COMPARISON_OP; break;
      case '>': type = TokenType.COMPARISON_OP; break;
      case '+': type = TokenType.ARITHMETIC_OP; break;
      case '-': type = TokenType.ARITHMETIC_OP; break;
      case '/': type = TokenType.SLASH; break;
      default: return null;
    }

    this.advance();
    return { type, value: ch, position: pos };
  }

  // ── Identifiers & Keywords ────────────────────────────────────────

  protected scanIdentifierOrKeyword(): Token {
    const pos = this.currentPosition();
    let value = '';
    while (this.pos < this.input.length && this.isIdentChar(this.peek())) {
      value += this.advance();
    }
    // Check for dollar sign identifiers (Oracle)
    while (this.pos < this.input.length && (this.peek() === '$' || this.isIdentChar(this.peek()))) {
      value += this.advance();
    }

    const upper = value.toUpperCase();
    if (this.isKeyword(upper)) {
      return { type: TokenType.KEYWORD, value: upper, position: pos };
    }
    return { type: TokenType.IDENTIFIER, value, position: pos };
  }

  /**
   * Check if a word is a keyword (SQL standard + dialect).
   * Override to add dialect-specific keywords.
   */
  protected isKeyword(word: string): boolean {
    return SQL_KEYWORDS.has(word) || this.dialectKeywords.has(word);
  }

  // ── Character helpers ─────────────────────────────────────────────

  protected peek(): string {
    return this.input[this.pos] ?? '';
  }

  protected peekAt(offset: number): string {
    return this.input[this.pos + offset] ?? '';
  }

  protected advance(): string {
    const ch = this.input[this.pos];
    this.pos++;
    if (ch === '\n') {
      this.line++;
      this.column = 1;
    } else {
      this.column++;
    }
    return ch;
  }

  protected currentPosition(): SourcePosition {
    return { offset: this.pos, line: this.line, column: this.column };
  }

  protected isDigit(ch: string): boolean {
    return ch >= '0' && ch <= '9';
  }

  protected isAlpha(ch: string): boolean {
    return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
  }

  protected isAlphaNumeric(ch: string): boolean {
    return this.isAlpha(ch) || this.isDigit(ch);
  }

  protected isIdentStart(ch: string): boolean {
    return this.isAlpha(ch) || ch === '_';
  }

  protected isIdentChar(ch: string): boolean {
    return this.isAlphaNumeric(ch) || ch === '_' || ch === '#';
  }
}
