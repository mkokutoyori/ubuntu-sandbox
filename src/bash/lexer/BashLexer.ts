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
   * Extra tokens produced by a scanner that emits more than one token
   * (the heredoc operator also emits its body token). Drained by
   * tokenize() before scanning further input.
   */
  private queued: Token[] = [];

  /**
   * Heredocs whose operator has been lexed but whose body hasn't been
   * collected yet — bash gathers the bodies, in order, starting on the
   * line AFTER the one holding the `<<` operators.
   */
  private pendingHeredocs: Array<{
    delimiter: string;
    stripTabs: boolean;
    bodyToken: Token;
  }> = [];

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
    this.queued = [];
    this.pendingHeredocs = [];

    const tokens: Token[] = [];

    while (!this.isAtEnd() || this.queued.length > 0) {
      if (this.queued.length > 0) {
        tokens.push(this.queued.shift()!);
        continue;
      }
      const posBeforeSkip = this.pos;
      this.skipSpacesAndTabs();
      if (this.isAtEnd()) break;
      const noWhitespaceBefore = this.pos === posBeforeSkip;

      const tok = this.scanToken();
      if (tok) {
        if (strip && tok.type === TokenType.WORD && tok.value.startsWith('#')) continue;
        // Mark tokens that butt directly against the previous one so the
        // parser can fuse `name='a b'` / `pre"$x"` into one word.
        if (noWhitespaceBefore && tokens.length > 0) tok.adjacent = true;
        tokens.push(tok);
      }
    }

    // A heredoc left open at EOF (no delimiter line, or no trailing
    // newline at all) takes the rest of the input as its body — bash
    // warns but accepts; keeping it lenient matches the interactive use.
    if (this.pendingHeredocs.length > 0) this.collectHeredocBodies();

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
    // { is only a brace group delimiter when followed by whitespace/newline/EOF
    // Otherwise it's part of a word (e.g., {1..3}, {echo)
    if (ch === '{') {
      const next = this.peekAt(1);
      if (next === undefined || next === ' ' || next === '\t' || next === '\n') {
        return this.advance1(TokenType.LBRACE);
      }
      // Fall through to word scanner
      return this.scanWord();
    }
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
      } else if (this.peek() === '$' && this.peekAt(1) === '(') {
        // `$(...)` embedded in a double-quoted string opens its own
        // quoting context — a `"` inside it must not be mistaken for
        // the outer string's terminator (e.g. `"$(cmd "$x")"`).
        value += this.consumeBalancedParenSpan();
      } else if (this.peek() === '`') {
        // Same for a backtick command substitution embedded inside.
        value += this.consumeBalancedBacktickSpan();
      } else {
        value += this.peek();
        this.advance();
      }
    }
    if (this.isAtEnd()) throw new LexerError("Unterminated double-quoted string", start);
    this.advance(); // skip closing "
    return { type: TokenType.DOUBLE_QUOTED, value, position: start };
  }

  /** Consume `$(...)`, honouring nested parens and quotes so an embedded
   *  `"`/`'` is never mistaken for the enclosing double-quote's terminator. */
  private consumeBalancedParenSpan(): string {
    let out = '$(';
    this.advance();
    this.advance();
    let depth = 1;
    while (!this.isAtEnd() && depth > 0) {
      const ch = this.peek();
      if (ch === '\\') {
        out += ch;
        this.advance();
        if (!this.isAtEnd()) { out += this.peek(); this.advance(); }
        continue;
      }
      if (ch === '"' || ch === "'") {
        out += this.consumeQuotedSpan(ch);
        continue;
      }
      if (ch === '(') { depth++; out += ch; this.advance(); continue; }
      if (ch === ')') { depth--; out += ch; this.advance(); continue; }
      out += ch;
      this.advance();
    }
    return out;
  }

  /** Consume a `'...'` or `"..."` span verbatim (including delimiters). */
  private consumeQuotedSpan(quote: string): string {
    let out = quote;
    this.advance();
    while (!this.isAtEnd() && this.peek() !== quote) {
      if (quote === '"' && this.peek() === '\\') {
        out += this.peek();
        this.advance();
        if (!this.isAtEnd()) { out += this.peek(); this.advance(); }
        continue;
      }
      out += this.peek();
      this.advance();
    }
    if (!this.isAtEnd()) { out += this.peek(); this.advance(); }
    return out;
  }

  /** Consume a `` `...` `` span verbatim (including backticks). */
  private consumeBalancedBacktickSpan(): string {
    let out = '`';
    this.advance();
    while (!this.isAtEnd() && this.peek() !== '`') {
      out += this.peek();
      this.advance();
    }
    if (!this.isAtEnd()) { out += this.peek(); this.advance(); }
    return out;
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

    // $'…' — ANSI-C quoting. Standard escape sequences are decoded
    // (\n, \t, \r, \\, \', \", \xNN, \0NN, \uNNNN); $-expansion does
    // NOT happen inside, mirroring real bash.
    if (next === "'") {
      this.advance(); // skip '
      let value = '';
      while (!this.isAtEnd() && this.peek() !== "'") {
        const c = this.peek();
        if (c === '\\' && !this.isAtEnd()) {
          this.advance();
          const esc = this.peek();
          switch (esc) {
            case 'n': value += '\n'; this.advance(); break;
            case 't': value += '\t'; this.advance(); break;
            case 'r': value += '\r'; this.advance(); break;
            case 'a': value += '\x07'; this.advance(); break;
            case 'b': value += '\b'; this.advance(); break;
            case 'f': value += '\f'; this.advance(); break;
            case 'v': value += '\v'; this.advance(); break;
            case 'e': value += '\x1b'; this.advance(); break;
            case '\\': value += '\\'; this.advance(); break;
            case "'": value += "'"; this.advance(); break;
            case '"': value += '"'; this.advance(); break;
            case 'x': {
              this.advance();
              let hex = '';
              for (let i = 0; i < 2 && !this.isAtEnd() && /[0-9a-fA-F]/.test(this.peek()); i++) {
                hex += this.peek(); this.advance();
              }
              if (hex) value += String.fromCharCode(Number.parseInt(hex, 16));
              break;
            }
            case 'u': {
              this.advance();
              let hex = '';
              for (let i = 0; i < 4 && !this.isAtEnd() && /[0-9a-fA-F]/.test(this.peek()); i++) {
                hex += this.peek(); this.advance();
              }
              if (hex) value += String.fromCharCode(Number.parseInt(hex, 16));
              break;
            }
            default:
              value += '\\' + esc; this.advance(); break;
          }
        } else {
          value += c;
          this.advance();
        }
      }
      if (!this.isAtEnd()) this.advance(); // skip closing '
      return { type: TokenType.SINGLE_QUOTED, value, position: start };
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
      if (!this.isAtEnd() && this.peek() === '&') {
        this.advance();
        return { type: TokenType.DSEMI_AMP, value: ';;&', position: start };
      }
      return { type: TokenType.DSEMI, value: ';;', position: start };
    }
    if (!this.isAtEnd() && this.peek() === '&') {
      this.advance();
      return { type: TokenType.SEMI_AMP, value: ';&', position: start };
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
    if (!this.isAtEnd() && this.peek() === '(') {
      return this.scanBalancedParens(start, 'out');
    }
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

  private scanBalancedParens(start: SourcePosition, kind: 'in' | 'out'): Token {
    this.advance();
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
    if (this.isAtEnd() && depth > 0) {
      throw new LexerError('Unterminated process substitution', start);
    }
    this.advance();
    return {
      type: kind === 'in' ? TokenType.PROC_SUB_IN : TokenType.PROC_SUB_OUT,
      value: cmd,
      position: start,
    };
  }

  private scanLess(): Token {
    const start = this.position();
    this.advance();
    if (!this.isAtEnd() && this.peek() === '(') {
      return this.scanBalancedParens(start, 'in');
    }
    if (!this.isAtEnd() && this.peek() === '<') {
      this.advance();
      if (!this.isAtEnd() && this.peek() === '<') {
        this.advance();
        return { type: TokenType.HERESTRING, value: '<<<', position: start };
      }
      // Heredoc — the delimiter word is consumed here (it is lexer
      // syntax, not a shell word), and the body is captured natively
      // once the current line ends. A quoted delimiter suppresses
      // expansion: the body token becomes SINGLE_QUOTED; an unquoted
      // one becomes DOUBLE_QUOTED, whose text goes through the normal
      // inline `$var`/`$(cmd)`/`\$` expansion — exactly bash's rules.
      let stripTabs = false;
      if (!this.isAtEnd() && this.peek() === '-') {
        stripTabs = true;
        this.advance();
      }
      while (!this.isAtEnd() && (this.peek() === ' ' || this.peek() === '\t')) this.advance();
      const delim = this.scanHeredocDelimiter();
      if (delim !== null) {
        const bodyToken: Token = {
          type: delim.quoted ? TokenType.SINGLE_QUOTED : TokenType.DOUBLE_QUOTED,
          value: '',
          position: this.position(),
        };
        this.queued.push(bodyToken);
        this.pendingHeredocs.push({ delimiter: delim.value, stripTabs, bodyToken });
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
      if (this.isWhitespace(ch)) break;
      // Stop at ( ) but allow it inside word if preceded by alphanumeric (for func())
      if (ch === '(' || ch === ')') break;
      // } at start of word is a brace group ender
      if (ch === '}' && !value) break;
      // [ and ] at start of word are test brackets; mid-word they're glob chars
      if ((ch === '[' || ch === ']') && !value) break;
      // Other operator starts. `#` is excluded: a word-initial `#` is
      // already consumed as a comment by scanToken, so any `#` reaching
      // scanWord is mid-word and thus a literal character — bash only
      // begins a comment at a word boundary (`echo a#b` prints `a#b`).
      if (this.isOperatorStart(ch) && ch !== '[' && ch !== ']' && ch !== '{' && ch !== '}' && ch !== '#') break;

      // Escape — keep both bytes in the raw value so downstream
      // glob/quote-removal can tell escaped meta-chars (`\*`, `\?`,
      // `\[`) apart from naturally unquoted ones. Quote removal at
      // expansion time strips the backslash before the value reaches
      // the dispatched command.
      if (ch === '\\' && !this.isAtEnd()) {
        this.advance();
        if (!this.isAtEnd()) {
          value += '\\' + this.peek();
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

    // Detect assignment. Three accepted forms:
    //   VAR=value
    //   VAR+=value
    //   VAR[subscript]=value        (indexed or associative element)
    //   VAR[subscript]+=value
    const eqIdx = value.indexOf('=');
    if (eqIdx > 0) {
      const nameEnd = value[eqIdx - 1] === '+' ? eqIdx - 1 : eqIdx;
      const lhs = value.substring(0, nameEnd);
      const m = lhs.match(/^([A-Za-z_][A-Za-z_0-9]*)(?:\[([^\]]+)\])?$/);
      if (m) {
        return { type: TokenType.ASSIGNMENT_WORD, value, position: start };
      }
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
    // Pending heredoc bodies start on the line after their operators —
    // consume them here so subsequent tokens resume past the bodies.
    if (this.pendingHeredocs.length > 0) this.collectHeredocBodies();
    return { type: TokenType.NEWLINE, value: '\n', position: start };
  }

  /**
   * Delimiter word right after `<<` / `<<-`: a quoted ('EOF' / "EOF") or
   * bare word. Returns null when the operator has no delimiter (a syntax
   * error the parser reports when its redirection target is missing).
   */
  private scanHeredocDelimiter(): { value: string; quoted: boolean } | null {
    if (this.isAtEnd()) return null;
    const ch = this.peek();
    if (ch === "'" || ch === '"') {
      const quote = ch;
      this.advance();
      let value = '';
      while (!this.isAtEnd() && this.peek() !== quote) {
        value += this.peek();
        this.advance();
      }
      if (!this.isAtEnd()) this.advance(); // closing quote
      return value.length > 0 ? { value, quoted: true } : null;
    }
    let value = '';
    let quoted = false;
    while (!this.isAtEnd() && !' \t\n|&;<>()'.includes(this.peek())) {
      // A backslash-escaped delimiter (\EOF) also disables expansion.
      if (this.peek() === '\\') {
        quoted = true;
        this.advance();
        if (this.isAtEnd()) break;
      }
      value += this.peek();
      this.advance();
    }
    return value.length > 0 ? { value, quoted } : null;
  }

  /**
   * Consume the heredoc bodies queued on the line that just ended, in
   * order, filling each operator's body token. The delimiter line itself
   * is swallowed. `<<-` strips leading tabs from body and delimiter
   * lines, per bash.
   */
  private collectHeredocBodies(): void {
    const pending = this.pendingHeredocs;
    this.pendingHeredocs = [];
    for (const h of pending) {
      const bodyLines: string[] = [];
      while (!this.isAtEnd()) {
        let lineEnd = this.input.indexOf('\n', this.pos);
        if (lineEnd === -1) lineEnd = this.input.length;
        const rawLine = this.input.slice(this.pos, lineEnd);
        const line = h.stripTabs ? rawLine.replace(/^\t+/, '') : rawLine;
        // Advance past the line (and its newline, if present).
        while (this.pos < lineEnd) this.advance();
        if (!this.isAtEnd()) this.advance();
        if (line.trim() === h.delimiter) break;
        bodyLines.push(line);
      }
      h.bodyToken.value = bodyLines.join('\n');
    }
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

  /** `\<newline>` outside a word is a line continuation: both characters
   *  vanish, unlike a bare `\n` which is a significant statement
   *  separator — this is what lets `cmd1 && \` + newline + `cmd2` read
   *  as one logical line, a common real-world script formatting idiom. */
  private skipSpacesAndTabs(): void {
    while (!this.isAtEnd()) {
      const ch = this.peek();
      if (ch === ' ' || ch === '\t') { this.advance(); continue; }
      if (ch === '\\' && this.peekAt(1) === '\n') { this.advance(); this.advance(); continue; }
      break;
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
