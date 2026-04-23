/**
 * PSLexer — Single-pass tokenizer for PowerShell 5.1.
 *
 * Scans input character-by-character and produces a flat PSToken[] array.
 * Handles:
 *   - Single/double quoted strings + here-strings (@'...'@ / @"..."@)
 *   - Variable references ($var, $env:VAR, ${var with spaces}, $?, $$)
 *   - Subexpression operator $(...)
 *   - Type literals [TypeName] vs index-access [
 *   - Parameters / operators -word (PARAMETER token)
 *   - Arithmetic, assignment, member-access, range operators
 *   - Pipeline |, semicolons ;, newlines
 *   - Redirections >, >>, 2>, 2>>, *>, *>>
 *   - Line comments (#) and block comments (<# ... #>)
 *   - Array/splatting @ prefix
 *   - Keywords lowercased; identifiers case-preserved
 */

import { PSTokenType, PS_KEYWORDS, psToken } from './PSToken';
import type { PSToken, SourcePosition } from './PSToken';
import { PSLexerError } from './PSLexerError';

export class PSLexer {
  private input: string = '';
  private pos: number = 0;
  private line: number = 1;
  private column: number = 1;

  // ─── Public API ──────────────────────────────────────────────────────────────

  /**
   * Tokenize a full PowerShell input string.
   * Comments are stripped. Returns a token array always ending with EOF.
   */
  tokenize(input: string): PSToken[] {
    this.input = input;
    this.pos = 0;
    this.line = 1;
    this.column = 1;

    const tokens: PSToken[] = [];

    while (!this.eof()) {
      this.skipSpacesAndTabs();
      if (this.eof()) break;

      const tok = this.scanToken();
      if (tok !== null) tokens.push(tok);
    }

    tokens.push(psToken(PSTokenType.EOF, '', this.pos_()));
    return tokens;
  }

  // ─── Main dispatcher ─────────────────────────────────────────────────────────

  private scanToken(): PSToken | null {
    const ch = this.ch();

    // ── Newline ──
    if (ch === '\n') return this.advance1(PSTokenType.NEWLINE);

    // ── Line comment ──
    if (ch === '#') { this.skipLineComment(); return null; }

    // ── Block comment <# ... #> ──
    if (ch === '<' && this.peek1() === '#') { this.skipBlockComment(); return null; }

    // ── Strings ──
    if (ch === "'") return this.scanStringSingle();
    if (ch === '"') return this.scanStringDouble();

    // ── @ prefix: here-strings, array-expr, hashtable, splatting ──
    if (ch === '@') return this.scanAt();

    // ── $ prefix: variable, subexpression ──
    if (ch === '$') return this.scanDollar();

    // ── [ prefix: type literal or LBRACKET ──
    if (ch === '[') return this.scanLBracket();

    // ── Parameter / operator: -word ──
    if (ch === '-') return this.scanDash();

    // ── ! (logical NOT) ──
    if (ch === '!') return this.advance1(PSTokenType.NOT);

    // ── Arithmetic & assignment ──
    if (ch === '+') return this.scanPlus();
    if (ch === '*') return this.scanStar();
    if (ch === '/') return this.scanDivide();
    if (ch === '%') return this.scanPercent();
    if (ch === '=') return this.advance1(PSTokenType.ASSIGN);

    // ── Redirections & member access ──
    if (ch === '>') return this.scanGreat();
    if (ch === ':') return this.scanColon();
    if (ch === '.') return this.scanDot();

    // ── Pipeline & grouping ──
    if (ch === '|') return this.advance1(PSTokenType.PIPE);
    if (ch === ';') return this.advance1(PSTokenType.SEMICOLON);
    if (ch === '(') return this.advance1(PSTokenType.LPAREN);
    if (ch === ')') return this.advance1(PSTokenType.RPAREN);
    if (ch === '{') return this.advance1(PSTokenType.LBRACE);
    if (ch === '}') return this.advance1(PSTokenType.RBRACE);
    if (ch === ']') return this.advance1(PSTokenType.RBRACKET);
    if (ch === ',') return this.advance1(PSTokenType.COMMA);
    if (ch === '&') return this.advance1(PSTokenType.AMPERSAND);

    // ── Number ──
    if (this.isDigit(ch)) return this.scanNumber();

    // ── Redirect 2> / 2>> ──
    // (already handled in scanNumber when digit is '2')

    // ── Word / identifier / keyword ──
    return this.scanWord();
  }

  // ─── Position helpers ─────────────────────────────────────────────────────────

  private pos_(): SourcePosition {
    return { offset: this.pos, line: this.line, column: this.column };
  }

  private eof(): boolean { return this.pos >= this.input.length; }
  private ch(): string { return this.input[this.pos]; }
  private peek1(): string | undefined { return this.input[this.pos + 1]; }
  private peek2(): string | undefined { return this.input[this.pos + 2]; }

  private advance(): void {
    if (this.input[this.pos] === '\n') { this.line++; this.column = 1; }
    else { this.column++; }
    this.pos++;
  }

  private advance1(type: PSTokenType): PSToken {
    const start = this.pos_();
    const value = this.ch();
    this.advance();
    return psToken(type, value, start);
  }

  private skipSpacesAndTabs(): void {
    while (!this.eof() && (this.ch() === ' ' || this.ch() === '\t')) this.advance();
  }

  private isDigit(ch: string): boolean { return ch >= '0' && ch <= '9'; }
  private isHexDigit(ch: string): boolean { return /[0-9A-Fa-f]/.test(ch); }
  private isAlpha(ch: string): boolean { return /[A-Za-z_]/.test(ch); }
  private isAlNum(ch: string): boolean { return /[A-Za-z0-9_]/.test(ch); }
  private isWordChar(ch: string): boolean {
    // PowerShell word chars: letters, digits, _, -, ., \ (for paths), :, /
    return /[A-Za-z0-9_.\\\/:-]/.test(ch);
  }

  // ─── Comments ──────────────────────────────────────────────────────────────

  private skipLineComment(): void {
    while (!this.eof() && this.ch() !== '\n') this.advance();
  }

  private skipBlockComment(): void {
    const start = this.pos_();
    this.advance(); // <
    this.advance(); // #
    while (!this.eof()) {
      if (this.ch() === '#' && this.peek1() === '>') {
        this.advance(); // #
        this.advance(); // >
        return;
      }
      this.advance();
    }
    throw new PSLexerError('Unterminated block comment <# ... #>', start);
  }

  // ─── String Scanners ───────────────────────────────────────────────────────

  private scanStringSingle(): PSToken {
    const start = this.pos_();
    this.advance(); // skip opening '
    let value = '';
    while (!this.eof()) {
      const c = this.ch();
      if (c === "'" && this.peek1() === "'") {
        // Escaped literal quote ''
        value += "''";
        this.advance();
        this.advance();
        continue;
      }
      if (c === "'") break; // closing quote
      value += c;
      this.advance();
    }
    if (this.eof()) throw new PSLexerError('Unterminated single-quoted string', start);
    this.advance(); // skip closing '
    return psToken(PSTokenType.STRING_SINGLE, value, start);
  }

  private scanStringDouble(): PSToken {
    const start = this.pos_();
    this.advance(); // skip opening "
    let value = '';
    while (!this.eof()) {
      const c = this.ch();
      if (c === '"') break; // closing quote
      if (c === '`' && !this.eof()) {
        // Backtick escape — preserve raw sequence for the evaluator
        value += '`';
        this.advance();
        if (!this.eof()) { value += this.ch(); this.advance(); }
        continue;
      }
      value += c;
      this.advance();
    }
    if (this.eof()) throw new PSLexerError('Unterminated double-quoted string', start);
    this.advance(); // skip closing "
    return psToken(PSTokenType.STRING_DOUBLE, value, start);
  }

  // ─── Here-strings ──────────────────────────────────────────────────────────

  private scanHeredocSingle(): PSToken {
    // @'\n...content...\n'@
    const start = this.pos_();
    // Consume the newline that must immediately follow @'
    if (!this.eof() && this.ch() === '\n') { this.line++; this.column = 1; this.pos++; }
    let value = '';
    while (!this.eof()) {
      // Terminator is '@' at the start of a line preceded by newline
      if (this.ch() === "'" && this.peek1() === '@') {
        this.advance(); // '
        this.advance(); // @
        // Strip trailing newline from content
        if (value.endsWith('\n')) value = value.slice(0, -1);
        return psToken(PSTokenType.HEREDOC_SINGLE, value, start);
      }
      if (this.ch() === '\n') { value += '\n'; this.line++; this.column = 1; this.pos++; }
      else { value += this.ch(); this.advance(); }
    }
    throw new PSLexerError("Unterminated here-string @'...'@", start);
  }

  private scanHeredocDouble(): PSToken {
    // @"\n...content...\n"@
    const start = this.pos_();
    if (!this.eof() && this.ch() === '\n') { this.line++; this.column = 1; this.pos++; }
    let value = '';
    while (!this.eof()) {
      if (this.ch() === '"' && this.peek1() === '@') {
        this.advance(); // "
        this.advance(); // @
        if (value.endsWith('\n')) value = value.slice(0, -1);
        return psToken(PSTokenType.HEREDOC_DOUBLE, value, start);
      }
      if (this.ch() === '\n') { value += '\n'; this.line++; this.column = 1; this.pos++; }
      else { value += this.ch(); this.advance(); }
    }
    throw new PSLexerError('Unterminated here-string @"..."@', start);
  }

  // ─── $ — Variable / Subexpression ─────────────────────────────────────────

  private scanDollar(): PSToken {
    const start = this.pos_();
    this.advance(); // skip $

    if (this.eof()) return psToken(PSTokenType.WORD, '$', start);

    const next = this.ch();

    // $( ... ) — subexpression
    if (next === '(') {
      this.advance(); // skip (
      const content = this.scanBalancedParens();
      return psToken(PSTokenType.SUBEXPR, content, start);
    }

    // ${ var with spaces } — braced variable name
    if (next === '{') {
      this.advance(); // skip {
      let name = '';
      while (!this.eof() && this.ch() !== '}') { name += this.ch(); this.advance(); }
      if (this.eof()) throw new PSLexerError('Unterminated braced variable ${...}', start);
      this.advance(); // skip }
      return psToken(PSTokenType.VARIABLE, name, start);
    }

    // $? $$ $^ — special single-character variables
    if (next === '?' || next === '^') {
      this.advance();
      return psToken(PSTokenType.VARIABLE, next, start);
    }
    if (next === '$') {
      this.advance();
      return psToken(PSTokenType.VARIABLE, '$', start);
    }

    // $name or $scope:name
    if (this.isAlpha(next) || next === '_') {
      let name = '';
      while (!this.eof() && (this.isAlNum(this.ch()) || this.ch() === ':')) {
        // Allow one colon for scope qualifier (env:, script:, global:, local:)
        if (this.ch() === ':') {
          // Only consume if this looks like a scope qualifier (letters follow the colon)
          const afterColon = this.input[this.pos + 1];
          if (afterColon && this.isAlpha(afterColon)) {
            name += ':';
            this.advance();
            // consume rest of name after colon
            while (!this.eof() && (this.isAlNum(this.ch()) || this.ch() === '_')) {
              name += this.ch(); this.advance();
            }
            break;
          } else {
            break; // colon not part of var name
          }
        }
        name += this.ch();
        this.advance();
      }
      return psToken(PSTokenType.VARIABLE, name, start);
    }

    // Bare $
    return psToken(PSTokenType.WORD, '$', start);
  }

  /** Scan content of $(...)  — tracking balanced parentheses. */
  private scanBalancedParens(): string {
    const start = this.pos_();
    let depth = 1;
    let content = '';
    while (!this.eof() && depth > 0) {
      const c = this.ch();
      if (c === '(') { depth++; content += c; this.advance(); }
      else if (c === ')') {
        depth--;
        if (depth > 0) { content += c; this.advance(); }
      } else {
        content += c;
        this.advance();
      }
    }
    if (depth > 0) throw new PSLexerError('Unterminated subexpression $(...)', start);
    this.advance(); // skip closing )
    return content;
  }

  // ─── @ — Here-string / Array / Hashtable / Splatting ─────────────────────

  private scanAt(): PSToken {
    const start = this.pos_();
    this.advance(); // skip @

    if (this.eof()) return psToken(PSTokenType.AT, '@', start);

    const next = this.ch();

    if (next === "'") { this.advance(); return this.scanHeredocSingle(); }
    if (next === '"') { this.advance(); return this.scanHeredocDouble(); }

    // @( → AT token; caller sees LPAREN next
    if (next === '(') return psToken(PSTokenType.AT, '@', start);

    // @{ → AT token; caller sees LBRACE next
    if (next === '{') return psToken(PSTokenType.AT, '@', start);

    // @varname — splatting
    if (this.isAlpha(next) || next === '_') {
      let name = '';
      while (!this.eof() && (this.isAlNum(this.ch()) || this.ch() === '_')) {
        name += this.ch(); this.advance();
      }
      return psToken(PSTokenType.SPLATTED, name, start);
    }

    return psToken(PSTokenType.AT, '@', start);
  }

  // ─── [ — Type literal or LBRACKET ────────────────────────────────────────

  private scanLBracket(): PSToken {
    const start = this.pos_();
    // Try to match a type literal: [Identifier(.Identifier)*(\[\])?]
    const saved = this.pos;
    const savedLine = this.line;
    const savedCol = this.column;

    this.advance(); // skip [

    // Check if what follows looks like a type name
    const typeName = this.tryReadTypeName();
    if (typeName !== null && !this.eof() && this.ch() === ']') {
      this.advance(); // skip ]
      return psToken(PSTokenType.TYPE, typeName, start);
    }

    // Not a type literal — restore position and emit LBRACKET
    this.pos = saved;
    this.line = savedLine;
    this.column = savedCol;
    this.advance(); // skip [
    return psToken(PSTokenType.LBRACKET, '[', start);
  }

  /**
   * After the opening `[` has been consumed, try to read a type name like:
   *   string, int, System.String, System.Collections.Generic.List[int], string[]
   * Returns the type name string if successful, or null if it doesn't look like a type.
   */
  private tryReadTypeName(): string | null {
    const savedPos = this.pos;
    const savedLine = this.line;
    const savedCol = this.column;

    // Skip optional whitespace
    while (!this.eof() && (this.ch() === ' ' || this.ch() === '\t')) this.advance();

    if (this.eof() || (!this.isAlpha(this.ch()) && this.ch() !== '_')) {
      this.pos = savedPos; this.line = savedLine; this.column = savedCol;
      return null;
    }

    let name = '';
    while (!this.eof()) {
      const c = this.ch();
      if (this.isAlNum(c) || c === '_' || c === '.') {
        name += c; this.advance();
      } else if (c === '[') {
        // Generic argument or array suffix: [int] or []
        name += '['; this.advance();
        let inner = '';
        while (!this.eof() && this.ch() !== ']') {
          inner += this.ch(); this.advance();
        }
        if (!this.eof()) { name += inner + ']'; this.advance(); }
      } else {
        break;
      }
    }

    if (!name) {
      this.pos = savedPos; this.line = savedLine; this.column = savedCol;
      return null;
    }

    // Skip trailing whitespace before expected ]
    while (!this.eof() && (this.ch() === ' ' || this.ch() === '\t')) this.advance();

    return name;
  }

  // ─── - — Parameter / operator / minus / assignment ────────────────────────

  private scanDash(): PSToken {
    const start = this.pos_();
    this.advance(); // skip -

    if (this.eof()) return psToken(PSTokenType.MINUS, '-', start);

    const next = this.ch();

    // -= assignment
    if (next === '=') { this.advance(); return psToken(PSTokenType.MINUS_ASSIGN, '-=', start); }

    // -- decrement or end-of-params marker
    if (next === '-') {
      this.advance();
      // If followed by another char (not word), it's DECREMENT
      if (!this.eof() && (this.ch() === ' ' || this.ch() === '\t' || this.ch() === '\n' || this.ch() === ';')) {
        return psToken(PSTokenType.PARAMETER, '-', start); // end-of-params
      }
      return psToken(PSTokenType.DECREMENT, '--', start);
    }

    // -word → PARAMETER (cmdlet switch or operator like -eq, -and)
    if (this.isAlpha(next) || next === '_') {
      let word = '';
      while (!this.eof() && (this.isAlNum(this.ch()) || this.ch() === '_' || this.ch() === '-')) {
        // Allow single embedded hyphens (e.g. -WhatIf, -ErrorAction, -notmatch)
        if (this.ch() === '-') {
          // Check next char: if alphanumeric, it's part of the param name
          const after = this.input[this.pos + 1];
          if (after && this.isAlNum(after)) { word += '-'; this.advance(); continue; }
          break;
        }
        word += this.ch(); this.advance();
      }
      return psToken(PSTokenType.PARAMETER, word.toLowerCase(), start);
    }

    // plain minus (binary/unary arithmetic)
    return psToken(PSTokenType.MINUS, '-', start);
  }

  // ─── + ────────────────────────────────────────────────────────────────────

  private scanPlus(): PSToken {
    const start = this.pos_();
    this.advance(); // skip +
    if (!this.eof() && this.ch() === '=') { this.advance(); return psToken(PSTokenType.PLUS_ASSIGN, '+=', start); }
    if (!this.eof() && this.ch() === '+') { this.advance(); return psToken(PSTokenType.INCREMENT, '++', start); }
    return psToken(PSTokenType.PLUS, '+', start);
  }

  // ─── * ────────────────────────────────────────────────────────────────────

  private scanStar(): PSToken {
    const start = this.pos_();
    this.advance(); // skip *

    // *= assignment
    if (!this.eof() && this.ch() === '=') {
      this.advance();
      return psToken(PSTokenType.MULTIPLY_ASSIGN, '*=', start);
    }

    // *> redirect all streams to file
    if (!this.eof() && this.ch() === '>') {
      this.advance(); // skip >
      if (!this.eof() && this.ch() === '>') {
        this.advance();
        return psToken(PSTokenType.REDIRECT_ALL_APPEND, '*>>', start);
      }
      return psToken(PSTokenType.REDIRECT_ALL_OUT, '*>', start);
    }

    return psToken(PSTokenType.MULTIPLY, '*', start);
  }

  // ─── / ────────────────────────────────────────────────────────────────────

  private scanDivide(): PSToken {
    const start = this.pos_();
    this.advance(); // skip /
    if (!this.eof() && this.ch() === '=') {
      this.advance();
      return psToken(PSTokenType.DIVIDE_ASSIGN, '/=', start);
    }
    return psToken(PSTokenType.DIVIDE, '/', start);
  }

  // ─── % ────────────────────────────────────────────────────────────────────

  private scanPercent(): PSToken {
    const start = this.pos_();
    this.advance(); // skip %
    if (!this.eof() && this.ch() === '=') {
      this.advance();
      return psToken(PSTokenType.MODULO_ASSIGN, '%=', start);
    }
    return psToken(PSTokenType.MODULO, '%', start);
  }

  // ─── > ────────────────────────────────────────────────────────────────────

  private scanGreat(): PSToken {
    const start = this.pos_();
    this.advance(); // skip >
    if (!this.eof() && this.ch() === '>') {
      this.advance();
      return psToken(PSTokenType.REDIRECT_APPEND, '>>', start);
    }
    return psToken(PSTokenType.REDIRECT_OUT, '>', start);
  }

  // ─── : ────────────────────────────────────────────────────────────────────

  private scanColon(): PSToken {
    const start = this.pos_();
    this.advance(); // skip first :
    if (!this.eof() && this.ch() === ':') {
      this.advance();
      return psToken(PSTokenType.STATIC_MEMBER, '::', start);
    }
    // Single colon — treat as WORD (rare standalone)
    return psToken(PSTokenType.WORD, ':', start);
  }

  // ─── . ────────────────────────────────────────────────────────────────────

  private scanDot(): PSToken {
    const start = this.pos_();
    this.advance(); // skip first .

    // .. range operator
    if (!this.eof() && this.ch() === '.') {
      this.advance();
      return psToken(PSTokenType.RANGE, '..', start);
    }

    // If followed by a digit, this is a decimal start without leading zero (.5)
    if (!this.eof() && this.isDigit(this.ch())) {
      let num = '.';
      while (!this.eof() && this.isDigit(this.ch())) { num += this.ch(); this.advance(); }
      return psToken(PSTokenType.NUMBER, num, start);
    }

    return psToken(PSTokenType.DOT, '.', start);
  }

  // ─── Numbers ──────────────────────────────────────────────────────────────

  private scanNumber(): PSToken {
    const start = this.pos_();
    let value = '';
    const first_ = this.ch();

    // Hex: 0x...
    if (first_ === '0' && (this.peek1() === 'x' || this.peek1() === 'X')) {
      value += '0'; this.advance();
      value += this.ch(); this.advance(); // x
      while (!this.eof() && this.isHexDigit(this.ch())) { value += this.ch(); this.advance(); }
      return psToken(PSTokenType.NUMBER, value, start);
    }

    // Check if digit is '2' and followed by '>' → redirect 2> / 2>>
    if (first_ === '2' && this.peek1() === '>') {
      this.advance(); // skip 2
      this.advance(); // skip >
      if (!this.eof() && this.ch() === '>') {
        this.advance();
        return psToken(PSTokenType.REDIRECT_ERR_APPEND, '2>>', start);
      }
      // 2>&1 — merge stderr to stdout
      return psToken(PSTokenType.REDIRECT_ERR_OUT, '2>', start);
    }

    // Integer or float
    while (!this.eof() && this.isDigit(this.ch())) { value += this.ch(); this.advance(); }

    // Decimal part
    if (!this.eof() && this.ch() === '.' && this.peek1() !== '.') {
      value += '.'; this.advance();
      while (!this.eof() && this.isDigit(this.ch())) { value += this.ch(); this.advance(); }
    }

    // Exponent
    if (!this.eof() && (this.ch() === 'e' || this.ch() === 'E')) {
      value += this.ch(); this.advance();
      if (!this.eof() && (this.ch() === '+' || this.ch() === '-')) { value += this.ch(); this.advance(); }
      while (!this.eof() && this.isDigit(this.ch())) { value += this.ch(); this.advance(); }
    }

    // Type suffixes: KB, MB, GB, TB, PB, L
    if (!this.eof()) {
      const up2 = (this.ch() + (this.peek1() ?? '')).toUpperCase();
      if (['KB', 'MB', 'GB', 'TB', 'PB'].includes(up2)) {
        value += this.ch(); this.advance();
        value += this.ch(); this.advance();
      } else if (this.ch() === 'L' || this.ch() === 'l') {
        value += this.ch(); this.advance();
      }
    }

    return psToken(PSTokenType.NUMBER, value, start);
  }

  // ─── Word / Keyword / Path ────────────────────────────────────────────────

  private scanWord(): PSToken {
    const start = this.pos_();
    let value = '';

    while (!this.eof()) {
      const c = this.ch();

      // Stop at whitespace
      if (c === ' ' || c === '\t' || c === '\n') break;

      // Stop at operator starts (but allow inside word chars)
      if (this.isWordStopChar(c)) break;

      // Allow backtick-escaping of the next char (line continuation / escape)
      if (c === '`' && !this.eof()) {
        this.advance();
        if (!this.eof()) { value += this.ch(); this.advance(); }
        continue;
      }

      value += c;
      this.advance();
    }

    if (!value) {
      // Unexpected character — consume and skip
      const c = this.ch();
      this.advance();
      return psToken(PSTokenType.WORD, c, start);
    }

    // Keywords are normalized to lowercase
    const lower = value.toLowerCase();
    if (PS_KEYWORDS.has(lower)) {
      return psToken(PSTokenType.WORD, lower, start);
    }

    return psToken(PSTokenType.WORD, value, start);
  }

  /**
   * Characters that terminate a word token.
   * In PowerShell, many symbols are not valid in bareword identifiers.
   */
  private isWordStopChar(c: string): boolean {
    return '|;(){}[]$"\'`#&,!@=+*/%><'.includes(c);
  }
}
