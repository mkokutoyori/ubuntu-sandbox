/**
 * Shell Lexer - Tokenizes shell input into tokens
 *
 * This is a proper lexer that handles:
 * - Quoted strings (single and double)
 * - Escape sequences
 * - Operators (|, >, >>, <, <<, &&, ||, ;, &)
 * - Variables ($VAR, ${VAR})
 * - Command substitution ($(...), `...`)
 * - Comments (#)
 * - Glob patterns (*, ?, [...])
 */

export enum TokenType {
  // Literals
  WORD = 'WORD',
  STRING_SINGLE = 'STRING_SINGLE',   // 'text'
  STRING_DOUBLE = 'STRING_DOUBLE',   // "text"

  // Operators - Pipeline
  PIPE = 'PIPE',                     // |
  PIPE_STDERR = 'PIPE_STDERR',       // |&

  // Operators - Redirection
  REDIRECT_OUT = 'REDIRECT_OUT',     // >
  REDIRECT_APPEND = 'REDIRECT_APPEND', // >>
  REDIRECT_IN = 'REDIRECT_IN',       // <
  HEREDOC = 'HEREDOC',               // <<
  HERESTRING = 'HERESTRING',         // <<<
  REDIRECT_FD = 'REDIRECT_FD',       // 2>, 1>, 2>&1

  // Operators - Control
  AND = 'AND',                       // &&
  OR = 'OR',                         // ||
  SEMICOLON = 'SEMICOLON',           // ;
  BACKGROUND = 'BACKGROUND',         // &
  NEWLINE = 'NEWLINE',               // \n

  // Grouping
  LPAREN = 'LPAREN',                 // (
  RPAREN = 'RPAREN',                 // )
  LBRACE = 'LBRACE',                 // {
  RBRACE = 'RBRACE',                 // }

  // Special
  VARIABLE = 'VARIABLE',             // $VAR, ${VAR}
  COMMAND_SUB = 'COMMAND_SUB',       // $(...), `...`
  ARITH_EXPAND = 'ARITH_EXPAND',     // $((expr))
  GLOB = 'GLOB',                     // *, ?, [...]
  COMMENT = 'COMMENT',               // # comment

  // End of input
  EOF = 'EOF',
}

export interface Token {
  type: TokenType;
  value: string;
  position: number;
  raw?: string;  // Original text including quotes
}

export interface LexerResult {
  success: boolean;
  tokens: Token[];
  error?: string;
  position?: number;
}

/**
 * Shell Lexer class
 */
export class ShellLexer {
  private input: string;
  private position: number = 0;
  private tokens: Token[] = [];

  constructor(input: string) {
    this.input = input;
  }

  /**
   * Tokenize the input
   */
  tokenize(): LexerResult {
    try {
      while (this.position < this.input.length) {
        this.skipWhitespace();

        if (this.position >= this.input.length) {
          break;
        }

        const char = this.peek();

        // Comment
        if (char === '#' && this.isStartOfWord()) {
          this.readComment();
          continue;
        }

        // Operators (multi-char first)
        if (this.tryOperator()) {
          continue;
        }

        // Single quoted string
        if (char === "'") {
          this.readSingleQuotedString();
          continue;
        }

        // Double quoted string
        if (char === '"') {
          this.readDoubleQuotedString();
          continue;
        }

        // Backtick command substitution
        if (char === '`') {
          this.readBacktickSubstitution();
          continue;
        }

        // Variable or command substitution
        if (char === '$') {
          this.readVariable();
          continue;
        }

        // Word (including globs)
        this.readWord();
      }

      this.tokens.push({
        type: TokenType.EOF,
        value: '',
        position: this.position,
      });

      return {
        success: true,
        tokens: this.tokens,
      };
    } catch (error) {
      return {
        success: false,
        tokens: this.tokens,
        error: error instanceof Error ? error.message : 'Unknown lexer error',
        position: this.position,
      };
    }
  }

  private peek(offset: number = 0): string {
    return this.input[this.position + offset] || '';
  }

  private advance(): string {
    return this.input[this.position++] || '';
  }

  private skipWhitespace(): void {
    while (this.position < this.input.length && /[ \t]/.test(this.peek())) {
      this.position++;
    }
  }

  private isStartOfWord(): boolean {
    if (this.position === 0) return true;
    const prev = this.input[this.position - 1];
    return /[\s;|&<>()]/.test(prev);
  }

  /**
   * Try to match an operator
   */
  private tryOperator(): boolean {
    const startPos = this.position;
    const char = this.peek();
    const next = this.peek(1);
    const third = this.peek(2);

    // Three character operators
    if (char === '<' && next === '<' && third === '<') {
      this.position += 3;
      this.tokens.push({ type: TokenType.HERESTRING, value: '<<<', position: startPos });
      return true;
    }

    // FD redirection: 2>&1, 1>&2, etc.
    if (/[0-2]/.test(char) && next === '>' && third === '&') {
      const fd = char;
      this.position += 3;
      const target = this.advance();
      this.tokens.push({ type: TokenType.REDIRECT_FD, value: `${fd}>&${target}`, position: startPos });
      return true;
    }

    // FD redirection: 2>, 1>
    if (/[0-2]/.test(char) && next === '>') {
      const fd = char;
      this.position += 2;
      const append = this.peek() === '>' ? (this.advance(), true) : false;
      this.tokens.push({ type: TokenType.REDIRECT_FD, value: `${fd}>${append ? '>' : ''}`, position: startPos });
      return true;
    }

    // Two character operators
    if (char === '|' && next === '&') {
      this.position += 2;
      this.tokens.push({ type: TokenType.PIPE_STDERR, value: '|&', position: startPos });
      return true;
    }
    if (char === '|' && next === '|') {
      this.position += 2;
      this.tokens.push({ type: TokenType.OR, value: '||', position: startPos });
      return true;
    }
    if (char === '&' && next === '&') {
      this.position += 2;
      this.tokens.push({ type: TokenType.AND, value: '&&', position: startPos });
      return true;
    }
    if (char === '>' && next === '>') {
      this.position += 2;
      this.tokens.push({ type: TokenType.REDIRECT_APPEND, value: '>>', position: startPos });
      return true;
    }
    if (char === '<' && next === '<') {
      this.position += 2;
      this.tokens.push({ type: TokenType.HEREDOC, value: '<<', position: startPos });
      return true;
    }

    // Single character operators
    switch (char) {
      case '|':
        this.advance();
        this.tokens.push({ type: TokenType.PIPE, value: '|', position: startPos });
        return true;
      case '>':
        this.advance();
        this.tokens.push({ type: TokenType.REDIRECT_OUT, value: '>', position: startPos });
        return true;
      case '<':
        this.advance();
        this.tokens.push({ type: TokenType.REDIRECT_IN, value: '<', position: startPos });
        return true;
      case ';':
        this.advance();
        this.tokens.push({ type: TokenType.SEMICOLON, value: ';', position: startPos });
        return true;
      case '&':
        this.advance();
        this.tokens.push({ type: TokenType.BACKGROUND, value: '&', position: startPos });
        return true;
      case '(':
        this.advance();
        this.tokens.push({ type: TokenType.LPAREN, value: '(', position: startPos });
        return true;
      case ')':
        this.advance();
        this.tokens.push({ type: TokenType.RPAREN, value: ')', position: startPos });
        return true;
      case '{':
        this.advance();
        this.tokens.push({ type: TokenType.LBRACE, value: '{', position: startPos });
        return true;
      case '}':
        this.advance();
        this.tokens.push({ type: TokenType.RBRACE, value: '}', position: startPos });
        return true;
      case '\n':
        this.advance();
        this.tokens.push({ type: TokenType.NEWLINE, value: '\n', position: startPos });
        return true;
    }

    return false;
  }

  /**
   * Read a single-quoted string
   */
  private readSingleQuotedString(): void {
    const startPos = this.position;
    this.advance(); // Skip opening quote

    let value = '';
    while (this.position < this.input.length && this.peek() !== "'") {
      value += this.advance();
    }

    if (this.peek() !== "'") {
      throw new Error(`Unterminated single-quoted string at position ${startPos}`);
    }
    this.advance(); // Skip closing quote

    this.tokens.push({
      type: TokenType.STRING_SINGLE,
      value,
      position: startPos,
      raw: `'${value}'`,
    });
  }

  /**
   * Read a double-quoted string (with variable expansion)
   */
  private readDoubleQuotedString(): void {
    const startPos = this.position;
    this.advance(); // Skip opening quote

    let value = '';
    while (this.position < this.input.length && this.peek() !== '"') {
      const char = this.peek();

      // Escape sequences
      if (char === '\\') {
        this.advance();
        const escaped = this.peek();
        if ('\\$"`\n'.includes(escaped)) {
          value += this.advance();
        } else {
          value += '\\' + this.advance();
        }
        continue;
      }

      value += this.advance();
    }

    if (this.peek() !== '"') {
      throw new Error(`Unterminated double-quoted string at position ${startPos}`);
    }
    this.advance(); // Skip closing quote

    this.tokens.push({
      type: TokenType.STRING_DOUBLE,
      value,
      position: startPos,
      raw: `"${value}"`,
    });
  }

  /**
   * Read backtick command substitution
   */
  private readBacktickSubstitution(): void {
    const startPos = this.position;
    this.advance(); // Skip opening backtick

    let value = '';
    let depth = 1;

    while (this.position < this.input.length && depth > 0) {
      const char = this.peek();

      if (char === '\\') {
        value += this.advance();
        value += this.advance();
        continue;
      }

      if (char === '`') {
        depth--;
        if (depth > 0) {
          value += this.advance();
        } else {
          this.advance();
        }
        continue;
      }

      value += this.advance();
    }

    if (depth > 0) {
      throw new Error(`Unterminated command substitution at position ${startPos}`);
    }

    this.tokens.push({
      type: TokenType.COMMAND_SUB,
      value,
      position: startPos,
      raw: '`' + value + '`',
    });
  }

  /**
   * Read variable or command substitution starting with $
   */
  private readVariable(): void {
    const startPos = this.position;
    this.advance(); // Skip $

    const char = this.peek();
    const next = this.peek(1);

    // $((...)) arithmetic expansion
    if (char === '(' && next === '(') {
      this.advance(); // Skip first (
      this.advance(); // Skip second (
      let value = '';
      let depth = 2; // We're already inside ((

      while (this.position < this.input.length && depth > 0) {
        const c = this.peek();
        const n = this.peek(1);

        if (c === ')' && n === ')' && depth === 2) {
          // End of arithmetic expansion
          this.advance(); // Skip first )
          this.advance(); // Skip second )
          break;
        }

        if (c === '(') depth++;
        else if (c === ')') depth--;

        if (depth >= 2) {
          value += this.advance();
        } else {
          this.advance();
        }
      }

      this.tokens.push({
        type: TokenType.ARITH_EXPAND,
        value,
        position: startPos,
        raw: '$((' + value + '))',
      });
      return;
    }

    // $(...) command substitution
    if (char === '(') {
      this.advance();
      let value = '';
      let depth = 1;

      while (this.position < this.input.length && depth > 0) {
        const c = this.peek();
        if (c === '(') depth++;
        else if (c === ')') depth--;

        if (depth > 0) {
          value += this.advance();
        } else {
          this.advance();
        }
      }

      this.tokens.push({
        type: TokenType.COMMAND_SUB,
        value,
        position: startPos,
        raw: '$(' + value + ')',
      });
      return;
    }

    // ${...} variable
    if (char === '{') {
      this.advance();
      let value = '';
      let depth = 1;

      while (this.position < this.input.length && depth > 0) {
        const c = this.peek();
        if (c === '{') depth++;
        else if (c === '}') depth--;

        if (depth > 0) {
          value += this.advance();
        } else {
          this.advance();
        }
      }

      this.tokens.push({
        type: TokenType.VARIABLE,
        value: '${' + value + '}',
        position: startPos,
      });
      return;
    }

    // Special variables: $?, $$, $!, $#, $*, $@, $0-$9
    if ('?$!#*@0123456789'.includes(char)) {
      const varName = this.advance();
      this.tokens.push({
        type: TokenType.VARIABLE,
        value: '$' + varName,
        position: startPos,
      });
      return;
    }

    // Regular variable: $VAR
    let varName = '';
    while (this.position < this.input.length && /[a-zA-Z0-9_]/.test(this.peek())) {
      varName += this.advance();
    }

    if (varName) {
      this.tokens.push({
        type: TokenType.VARIABLE,
        value: '$' + varName,
        position: startPos,
      });
    } else {
      // Literal $ character
      this.tokens.push({
        type: TokenType.WORD,
        value: '$',
        position: startPos,
      });
    }
  }

  /**
   * Read a word (unquoted text)
   */
  private readWord(): void {
    const startPos = this.position;
    let value = '';
    let hasGlob = false;

    while (this.position < this.input.length) {
      const char = this.peek();

      // Stop at whitespace or operators
      if (/[\s|&;<>(){}]/.test(char)) {
        break;
      }

      // Handle escape sequences
      if (char === '\\') {
        this.advance();
        value += this.advance();
        continue;
      }

      // Stop at quotes - they start new tokens
      if (char === '"' || char === "'" || char === '`') {
        break;
      }

      // Stop at $ - it starts variable/command substitution
      if (char === '$') {
        break;
      }

      // Track glob characters
      if ('*?['.includes(char)) {
        hasGlob = true;
      }

      value += this.advance();
    }

    if (value) {
      this.tokens.push({
        type: hasGlob ? TokenType.GLOB : TokenType.WORD,
        value,
        position: startPos,
      });
    }
  }

  /**
   * Read a comment
   */
  private readComment(): void {
    const startPos = this.position;
    this.advance(); // Skip #

    let value = '';
    while (this.position < this.input.length && this.peek() !== '\n') {
      value += this.advance();
    }

    this.tokens.push({
      type: TokenType.COMMENT,
      value,
      position: startPos,
    });
  }
}

/**
 * Convenience function to tokenize input
 */
export function tokenize(input: string): LexerResult {
  const lexer = new ShellLexer(input);
  return lexer.tokenize();
}
