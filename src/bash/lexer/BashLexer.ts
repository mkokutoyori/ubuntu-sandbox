/**
 * BashLexer — Single-pass tokenizer for bash scripts.
 *
 * Scans input character-by-character, producing a flat Token[] array.
 * Handles:
 *   - Single/double quoted strings
 *   - Variable references ($VAR, ${VAR}, $?, $$, etc.)
 *   - Command substitution $(cmd) and `cmd`
 *   - Arithmetic substitution $((expr))
 *   - Operators (|, &&, ||, ;, ;;, &)
 *   - Redirections (>, >>, <, 2>, 2>>, >&, <&, <<<, <<)
 *   - Grouping ( ), { }, [ ], [[ ]]
 *   - Assignment detection (WORD=value)
 *   - Comments (# to end of line)
 *   - Newlines (significant in bash)
 */

import { TokenType, BASH_KEYWORDS, type Token, type SourcePosition } from './Token';
import { LexerError } from './LexerError';

export class BashLexer {
  private input: string = '';
  private pos: number = 0;
  private line: number = 1;
  private column: number = 1;

  /**
   * Tokenize the full input string.
   * @param input   Bash source code.
   * @param strip   If true, filter out comments (default: true).
   */
  tokenize(input: string, strip: boolean = true): Token[] {
    this.input = input;
    this.pos = 0;
    this.line = 1;
    this.column = 1;

    const tokens: Token[] = [];

    while (!this.isAtEnd()) {
      this.skipSpacesAndTabs();
      if (this.isAtEnd()) break;

      const tok = this.scanToken();
      if (tok) {
        if (strip && tok.type === TokenType.WORD && tok.value.startsWith('#')) continue;
        tokens.push(tok);
      }
    }

    tokens.push(this.makeToken(TokenType.EOF, ''));
    return tokens;
  }

  // ─── Main Scanner ──────────────────────────────────────────────

  private scanToken(): Token | null {
    const ch = this.peek();

    // Comment
    if (ch === '#') return this.scanComment();

    // Newline
    if (ch === '\n') return this.scanNewline();

    // Single-quoted string
    if (ch === "'") return this.scanSingleQuoted();

    // Double-quoted string
    if (ch === '"') return this.scanDoubleQuoted();

    // Backtick command substitution
    if (ch === '`') return this.scanBacktickSub();

    // Dollar: variable, command sub, arithmetic sub
    if (ch === '$') return this.scanDollar();

    // Operators and redirections
    if (ch === '|') return this.scanPipe();
    if (ch === '&') return this.scanAmpersand();
    if (ch === ';') return this.scanSemicolon();
    if (ch === '(') return this.advance1(TokenType.LPAREN);
    if (ch === ')') return this.advance1(TokenType.RPAREN);
    if (ch === '{') return this.advance1(TokenType.LBRACE);
    if (ch === '}') return this.advance1(TokenType.RBRACE);

    // Brackets [ ] [[ ]]
    if (ch === '[') return this.scanLeftBracket();
    if (ch === ']') return this.scanRightBracket();

    // Redirections
    if (ch === '>') return this.scanGreat();
    if (ch === '<') return this.scanLess();

    // Digit — could be FD redirect (2>) or part of a word
    if (this.isDigit(ch) && this.isFdRedirect()) return this.scanFdRedirect();

    // Word (identifier, command, argument, glob, path)
    return this.scanWord();
  }

  // ─── String Scanners ───────────────────────────────────────────

  private scanSingleQuoted(): Token {
    const start = this.position();
    this.advance(); // skip opening '
    let value = '';
    while (!this.isAtEnd() && this.peek() !== "'") {
      value += this.peek();
      this.advance();
    }
    if (this.isAtEnd()) throw new LexerError("Unterminated single-quoted string", start);
    this.advance(); // skip closing '
    return { type: TokenType.SINGLE_QUOTED, value, position: start };
  }

  private scanDoubleQuoted(): Token {
    const start = this.position();
    this.advance(); // skip opening "
    let value = '';
    while (!this.isAtEnd() && this.peek() !== '"') {
      if (this.peek() === '\\') {
        this.advance();
        if (!this.isAtEnd()) {
          value += '\\' + this.peek();
          this.advance();
        }
      } else {
        value += this.peek();
        this.advance();
      }
    }
    if (this.isAtEnd()) throw new LexerError("Unterminated double-quoted string", start);
    this.advance(); // skip closing "
    return { type: TokenType.DOUBLE_QUOTED, value, position: start };
  }

  private scanBacktickSub(): Token {
    const start = this.position();
    this.advance(); // skip `
    let value = '';
    while (!this.isAtEnd() && this.peek() !== '`') {
      value += this.peek();
      this.advance();
    }
    if (this.isAtEnd()) throw new LexerError("Unterminated backtick substitution", start);
    this.advance(); // skip closing `
    return { type: TokenType.CMD_SUB_BACKTICK, value, position: start };
  }

  // ─── Dollar Scanners ──────────────────────────────────────────

  private scanDollar(): Token {
    const start = this.position();
    this.advance(); // skip $

    if (this.isAtEnd()) return { type: TokenType.WORD, value: '$', position: start };

    const next = this.peek();

    // $((expr)) — arithmetic substitution
    if (next === '(' && this.peekAt(1) === '(') { // pos is at '(', peekAt(1) checks pos+1
      return this.scanArithSub(start);
    }

    // $(cmd) — command substitution
    if (next === '(') {
      return this.scanCmdSub(start);
    }

    // ${VAR...} — braced variable
    if (next === '{') {
      return this.scanVarBraced(start);
    }

    // $? $$ $! $# $@ $* $0..$9
    if ('?$!#@*'.includes(next) || this.isDigit(next)) {
      this.advance();
      return { type: TokenType.VAR_SPECIAL, value: next, position: start };
    }

    // $WORD — simple variable
    if (this.isNameStart(next)) {
      let name = '';
      while (!this.isAtEnd() && this.isNameChar(this.peek())) {
        name += this.peek();
        this.advance();
      }
      return { type: TokenType.VAR_SIMPLE, value: name, position: start };
    }

    // Bare $
    return { type: TokenType.WORD, value: '$', position: start };
  }

  private scanArithSub(start: SourcePosition): Token {
    this.advance(); // skip first (
    this.advance(); // skip second (
    let depth = 1;
    let expr = '';
    while (!this.isAtEnd() && depth > 0) {
      if (this.peek() === '(' && this.peekAt(1) === '(') {
        depth++;
        expr += '((';
        this.advance();
        this.advance();
      } else if (this.peek() === ')' && this.peekAt(1) === ')') {
        depth--;
        if (depth > 0) {
          expr += '))';
          this.advance();
          this.advance();
        }
      } else {
        expr += this.peek();
        this.advance();
      }
    }
    if (depth > 0) throw new LexerError("Unterminated arithmetic substitution", start);
    this.advance(); // skip first )
    this.advance(); // skip second )
    return { type: TokenType.ARITH_SUB, value: expr, position: start };
  }

  private scanCmdSub(start: SourcePosition): Token {
    this.advance(); // skip (
    let depth = 1;
    let cmd = '';
    while (!this.isAtEnd() && depth > 0) {
      if (this.peek() === '(') depth++;
      else if (this.peek() === ')') {
        depth--;
        if (depth === 0) break;
      }
      cmd += this.peek();
      this.advance();
    }
    if (this.isAtEnd() && depth > 0) throw new LexerError("Unterminated command substitution", start);
    this.advance(); // skip )
    return { type: TokenType.CMD_SUB, value: cmd, position: start };
  }

  private scanVarBraced(start: SourcePosition): Token {
    this.advance(); // skip {
    let content = '';
    while (!this.isAtEnd() && this.peek() !== '}') {
      content += this.peek();
      this.advance();
    }
    if (this.isAtEnd()) throw new LexerError("Unterminated variable expansion ${...}", start);
    this.advance(); // skip }
    return { type: TokenType.VAR_BRACED, value: content, position: start };
  }

  // ─── Operator Scanners ─────────────────────────────────────────

  private scanPipe(): Token {
    const start = this.position();
    this.advance();
    if (!this.isAtEnd() && this.peek() === '|') {
      this.advance();
      return { type: TokenType.OR_IF, value: '||', position: start };
    }
    return { type: TokenType.PIPE, value: '|', position: start };
  }

  private scanAmpersand(): Token {
    const start = this.position();
    this.advance();
    if (!this.isAtEnd() && this.peek() === '&') {
      this.advance();
      return { type: TokenType.AND_IF, value: '&&', position: start };
    }
    if (!this.isAtEnd() && this.peek() === '>') {
      this.advance();
      return { type: TokenType.GREATAND, value: '>&', position: start };
    }
    return { type: TokenType.AMP, value: '&', position: start };
  }

  private scanSemicolon(): Token {
    const start = this.position();
    this.advance();
    if (!this.isAtEnd() && this.peek() === ';') {
      this.advance();
      return { type: TokenType.DSEMI, value: ';;', position: start };
    }
    return { type: TokenType.SEMI, value: ';', position: start };
  }

  private scanLeftBracket(): Token {
    const start = this.position();
    this.advance();
    if (!this.isAtEnd() && this.peek() === '[') {
      this.advance();
      return { type: TokenType.DLBRACKET, value: '[[', position: start };
    }
    return { type: TokenType.LBRACKET, value: '[', position: start };
  }

  private scanRightBracket(): Token {
    const start = this.position();
    this.advance();
    if (!this.isAtEnd() && this.peek() === ']') {
      this.advance();
      return { type: TokenType.DRBRACKET, value: ']]', position: start };
    }
    return { type: TokenType.RBRACKET, value: ']', position: start };
  }

  // ─── Redirection Scanners ──────────────────────────────────────

  private scanGreat(): Token {
    const start = this.position();
    this.advance();
    if (!this.isAtEnd() && this.peek() === '>') {
      this.advance();
      return { type: TokenType.DGREAT, value: '>>', position: start };
    }
    if (!this.isAtEnd() && this.peek() === '&') {
      this.advance();
      return { type: TokenType.GREATAND, value: '>&', position: start };
    }
    return { type: TokenType.GREAT, value: '>', position: start };
  }

  private scanLess(): Token {
    const start = this.position();
    this.advance();
    if (!this.isAtEnd() && this.peek() === '<') {
      this.advance();
      if (!this.isAtEnd() && this.peek() === '<') {
        this.advance();
        return { type: TokenType.HERESTRING, value: '<<<', position: start };
      }
      return { type: TokenType.HEREDOC, value: '<<', position: start };
    }
    if (!this.isAtEnd() && this.peek() === '&') {
      this.advance();
      return { type: TokenType.LESSAND, value: '<&', position: start };
    }
    return { type: TokenType.LESS, value: '<', position: start };
  }

  /** Check if current position is a file-descriptor redirect (e.g. 2> or 2>>) */
  private isFdRedirect(): boolean {
    let look = this.pos;
    while (look < this.input.length && this.isDigit(this.input[look])) look++;
    return look < this.input.length && this.input[look] === '>';
  }

  private scanFdRedirect(): Token {
    const start = this.position();
    let fd = '';
    while (!this.isAtEnd() && this.isDigit(this.peek())) {
      fd += this.peek();
      this.advance();
    }
    // Now at '>'
    this.advance();
    if (!this.isAtEnd() && this.peek() === '>') {
      this.advance();
      return { type: TokenType.FD_DGREAT, value: `${fd}>>`, position: start };
    }
    if (!this.isAtEnd() && this.peek() === '&') {
      this.advance();
      // e.g., 2>&1
      let target = '';
      while (!this.isAtEnd() && this.isDigit(this.peek())) {
        target += this.peek();
        this.advance();
      }
      return { type: TokenType.GREATAND, value: `${fd}>&${target}`, position: start };
    }
    return { type: TokenType.FD_GREAT, value: `${fd}>`, position: start };
  }

  // ─── Word Scanner ─────────────────────────────────────────────

  private scanWord(): Token {
    const start = this.position();
    let value = '';

    while (!this.isAtEnd()) {
      const ch = this.peek();

      // Stop at whitespace, operators, and special chars
      if (this.isWhitespace(ch) || this.isOperatorStart(ch)) break;
      // Stop at ( ) but allow it inside word if preceded by alphanumeric (for func())
      if (ch === '(' || ch === ')') break;
      if (ch === '{' || ch === '}') break;

      // Escape
      if (ch === '\\' && !this.isAtEnd()) {
        this.advance();
        if (!this.isAtEnd()) {
          value += this.peek();
          this.advance();
        }
        continue;
      }

      value += ch;
      this.advance();
    }

    if (!value) {
      // Unexpected character — skip and retry
      const ch = this.peek();
      this.advance();
      return { type: TokenType.WORD, value: ch, position: start };
    }

    // Detect assignment: VAR=value
    const eqIdx = value.indexOf('=');
    if (eqIdx > 0 && this.isValidName(value.substring(0, eqIdx))) {
      return { type: TokenType.ASSIGNMENT_WORD, value, position: start };
    }

    return { type: TokenType.WORD, value, position: start };
  }

  // ─── Other Scanners ───────────────────────────────────────────

  private scanComment(): Token | null {
    const start = this.position();
    let value = '';
    while (!this.isAtEnd() && this.peek() !== '\n') {
      value += this.peek();
      this.advance();
    }
    // Return null to indicate filtered-out token (handled by caller)
    return { type: TokenType.WORD, value, position: start };
  }

  private scanNewline(): Token {
    const start = this.position();
    this.advance();
    return { type: TokenType.NEWLINE, value: '\n', position: start };
  }

  // ─── Helpers ───────────────────────────────────────────────────

  private isAtEnd(): boolean { return this.pos >= this.input.length; }
  private peek(): string { return this.input[this.pos]; }
  private peekAt(offset: number): string | undefined { return this.input[this.pos + offset]; }

  private position(): SourcePosition {
    return { offset: this.pos, line: this.line, column: this.column };
  }

  private advance(): void {
    if (this.input[this.pos] === '\n') {
      this.line++;
      this.column = 1;
    } else {
      this.column++;
    }
    this.pos++;
  }

  private advance1(type: TokenType): Token {
    const start = this.position();
    const value = this.peek();
    this.advance();
    return { type, value, position: start };
  }

  private makeToken(type: TokenType, value: string): Token {
    return { type, value, position: this.position() };
  }

  private skipSpacesAndTabs(): void {
    while (!this.isAtEnd() && (this.peek() === ' ' || this.peek() === '\t')) {
      this.advance();
    }
  }

  private isWhitespace(ch: string): boolean { return ch === ' ' || ch === '\t' || ch === '\n'; }
  private isDigit(ch: string): boolean { return ch >= '0' && ch <= '9'; }
  private isNameStart(ch: string): boolean { return /[A-Za-z_]/.test(ch); }
  private isNameChar(ch: string): boolean { return /[A-Za-z_0-9]/.test(ch); }

  private isValidName(s: string): boolean {
    return /^[A-Za-z_][A-Za-z_0-9]*$/.test(s);
  }

  private isOperatorStart(ch: string): boolean {
    return '|&;<>#\n`$"\'[]'.includes(ch);
  }
}
