/**
 * BashParser — Recursive descent parser for bash scripts.
 *
 * Consumes Token[] from BashLexer and produces a Program AST.
 * Grammar rules follow parser.out (PLY-generated LALR tables), but
 * implemented as a hand-written recursive descent parser for clarity.
 *
 * Grammar hierarchy:
 *   Program → CommandList → AndOrList → Pipeline → Command → ...
 */

import { TokenType, BASH_KEYWORDS, type Token, type SourcePosition } from '@/bash/lexer/Token';
import { ParserError } from './ParserError';
import type {
  Program, CommandList, AndOrList, AndOrPart, Pipeline, Command,
  SimpleCommand, IfClause, ElifClause, ForClause, WhileClause, UntilClause,
  CaseClause, CaseItem, FunctionDef, BraceGroup, Subshell,
  Word, Assignment, Redirection, RedirectionOp,
} from './ASTNode';
import {
  makeProgram, makeCommandList, makeAndOrList, makePipeline,
  makeSimpleCommand, makeLiteralWord, makeAssignment, makeRedirection,
} from './ASTNode';

/**
 * Open compound-command context. The parser pushes one of these onto
 * `contextStack` while parsing the body of an `if`/`for`/`while`/`until`/
 * `case` so that reserved-word recognition (and therefore the
 * "compound-end" check) is context-sensitive — `done` only ends a
 * loop body, `fi` only ends an `if`, `esac` only ends a `case`, and
 * outside any of them all of these are just plain words.
 */
type ParseContext = 'if' | 'loop' | 'case';

export class BashParser {
  private tokens: Token[] = [];
  private pos: number = 0;
  /** Stack of open compound contexts; the top governs which reserved words terminate. */
  private contextStack: ParseContext[] = [];

  /**
   * Parse a token stream into a Program AST.
   */
  parse(tokens: Token[]): Program {
    this.tokens = tokens;
    this.pos = 0;

    this.skipNewlines();
    const body = this.parseCommandList();
    this.skipNewlines();

    if (!this.isAtEnd()) {
      const tok = this.peek();
      throw new ParserError(`Unexpected token '${tok.value}'`, tok.position);
    }

    return makeProgram(body, tokens[0]?.position);
  }

  // ─── Command List (Grammar Rules 3-6, 63-66) ──────────────────

  private parseCommandList(): CommandList {
    const pos = this.peek().position;
    const commands: AndOrList[] = [];

    this.skipNewlines();
    if (this.isAtEnd() || this.isCompoundEnd()) {
      return makeCommandList(commands, pos);
    }

    commands.push(this.parseAndOrList());

    while (this.matchSeparator()) {
      this.skipNewlines();
      if (this.isAtEnd() || this.isCompoundEnd()) break;
      commands.push(this.parseAndOrList());
    }

    return makeCommandList(commands, pos);
  }

  // ─── And/Or List (Grammar Rules 7-9) ──────────────────────────

  private parseAndOrList(): AndOrList {
    const pos = this.peek().position;
    const firstPipeline = this.parsePipeline();
    const rest: AndOrPart[] = [];

    while (this.check(TokenType.AND_IF) || this.check(TokenType.OR_IF)) {
      const op = this.advance().value as '&&' | '||';
      this.skipNewlines();
      rest.push({ operator: op, pipeline: this.parsePipeline() });
    }

    return makeAndOrList(firstPipeline, rest, pos);
  }

  // ─── Pipeline (Grammar Rules 10-11) ───────────────────────────

  private parsePipeline(): Pipeline {
    const pos = this.peek().position;
    const commands: Command[] = [this.parseCommand()];

    while (this.check(TokenType.PIPE)) {
      this.advance(); // consume |
      this.skipNewlines();
      commands.push(this.parseCommand());
    }

    return makePipeline(commands, pos);
  }

  // ─── Command (Grammar Rules 12-15) ────────────────────────────

  private parseCommand(): Command {
    // Function definition: WORD () { ... }
    if (this.isFunctionDef()) return this.parseFunctionDef();
    // Compound commands
    if (this.checkWord('if')) return this.parseIfClause();
    if (this.checkWord('for')) return this.parseForClause();
    if (this.checkWord('while')) return this.parseWhileClause();
    if (this.checkWord('until')) return this.parseUntilClause();
    if (this.checkWord('case')) return this.parseCaseClause();
    if (this.checkWord('function')) return this.parseFunctionDef();
    if (this.check(TokenType.LBRACE)) return this.parseBraceGroup();
    if (this.check(TokenType.LPAREN)) return this.parseSubshell();

    // Simple command
    return this.parseSimpleCommand();
  }

  // ─── Simple Command (Grammar Rules 16-29) ─────────────────────

  private parseSimpleCommand(): SimpleCommand {
    const pos = this.peek().position;
    const assignments: Assignment[] = [];
    const words: Word[] = [];
    const redirections: Redirection[] = [];

    // Parse leading assignments and redirections (cmd_prefix)
    while (!this.isAtEnd()) {
      if (this.check(TokenType.ASSIGNMENT_WORD) && words.length === 0) {
        assignments.push(this.parseAssignment());
      } else if (this.isRedirectionStart()) {
        redirections.push(this.parseRedirection());
      } else {
        break;
      }
    }

    // Parse command word and suffix (cmd_word + cmd_suffix)
    while (!this.isAtEnd() && this.isWordToken() && !this.isCompoundEnd()) {
      words.push(this.parseWord());
    }

    // Parse trailing redirections
    while (this.isRedirectionStart()) {
      redirections.push(this.parseRedirection());
    }

    return makeSimpleCommand(words, assignments, redirections, pos);
  }

  // ─── If Clause (Grammar Rules 40-45) ──────────────────────────

  private parseIfClause(): IfClause {
    const pos = this.peek().position;
    this.expectWord('if');
    this.skipNewlines();
    return this.withContext('if', () => {
      const condition = this.parseCommandList();
      this.skipNewlines();
      this.expectWord('then');
      this.skipNewlines();

      const thenBody = this.parseCommandList();
      this.skipNewlines();

      const elifClauses: ElifClause[] = [];
      while (this.checkWord('elif')) {
        this.advance();
        this.skipNewlines();
        const elifCondition = this.parseCommandList();
        this.skipNewlines();
        this.expectWord('then');
        this.skipNewlines();
        const elifBody = this.parseCommandList();
        this.skipNewlines();
        elifClauses.push({ condition: elifCondition, body: elifBody });
      }

      let elseBody: CommandList | null = null;
      if (this.checkWord('else')) {
        this.advance();
        this.skipNewlines();
        elseBody = this.parseCommandList();
        this.skipNewlines();
      }

      this.expectWord('fi');

      const redirections = this.parseTrailingRedirections();
      return { type: 'IfClause', condition, thenBody, elifClauses, elseBody, redirections, position: pos };
    });
  }

  // ─── For Clause (Grammar Rules 46-47) ─────────────────────────

  private parseForClause(): ForClause {
    const pos = this.peek().position;
    this.expectWord('for');
    this.skipNewlines();

    const varTok = this.advance();
    if (varTok.type !== TokenType.WORD) {
      throw new ParserError(`Expected variable name after 'for', got '${varTok.value}'`, varTok.position);
    }
    const variable = varTok.value;
    this.skipNewlines();

    let words: Word[] | null = null;
    if (this.checkWord('in')) {
      this.advance();
      words = [];
      while (!this.isAtEnd() && this.isWordToken() && !this.checkWord('do') && !this.check(TokenType.SEMI) && !this.check(TokenType.NEWLINE)) {
        words.push(this.parseWord());
      }
    }

    this.matchSeparator();
    this.skipNewlines();
    return this.withContext('loop', () => {
      this.expectWord('do');
      this.skipNewlines();
      const body = this.parseCommandList();
      this.skipNewlines();
      this.expectWord('done');
      const redirections = this.parseTrailingRedirections();
      return { type: 'ForClause', variable, words, body, redirections, position: pos };
    });
  }

  // ─── While Clause (Grammar Rule 48) ───────────────────────────

  private parseWhileClause(): WhileClause {
    const pos = this.peek().position;
    this.expectWord('while');
    this.skipNewlines();
    return this.withContext('loop', () => {
      const condition = this.parseCommandList();
      this.skipNewlines();
      this.expectWord('do');
      this.skipNewlines();
      const body = this.parseCommandList();
      this.skipNewlines();
      this.expectWord('done');
      const redirections = this.parseTrailingRedirections();
      return { type: 'WhileClause', condition, body, redirections, position: pos };
    });
  }

  // ─── Until Clause (Grammar Rule 49) ───────────────────────────

  private parseUntilClause(): UntilClause {
    const pos = this.peek().position;
    this.expectWord('until');
    this.skipNewlines();
    return this.withContext('loop', () => {
      const condition = this.parseCommandList();
      this.skipNewlines();
      this.expectWord('do');
      this.skipNewlines();
      const body = this.parseCommandList();
      this.skipNewlines();
      this.expectWord('done');
      const redirections = this.parseTrailingRedirections();
      return { type: 'UntilClause', condition, body, redirections, position: pos };
    });
  }

  // ─── Case Clause (Grammar Rules 50-58) ────────────────────────

  private parseCaseClause(): CaseClause {
    const pos = this.peek().position;
    this.expectWord('case');
    const word = this.parseWord();
    this.skipNewlines();
    this.expectWord('in');
    this.skipNewlines();
    return this.withContext('case', () => {
      const items: CaseItem[] = [];
      while (!this.isAtEnd() && !this.checkWord('esac')) {
        items.push(this.parseCaseItem());
        this.skipNewlines();
      }
      this.expectWord('esac');
      const redirections = this.parseTrailingRedirections();
      return { type: 'CaseClause', word, items, redirections, position: pos };
    });
  }

  private parseCaseItem(): CaseItem {
    // Optional leading (
    if (this.check(TokenType.LPAREN)) this.advance();

    const patterns: Word[] = [this.parseWord()];
    while (this.check(TokenType.PIPE)) {
      this.advance();
      patterns.push(this.parseWord());
    }

    this.expect(TokenType.RPAREN);
    this.skipNewlines();

    let body: CommandList | null = null;
    if (!this.check(TokenType.DSEMI) && !this.checkWord('esac')) {
      body = this.parseCommandList();
    }

    // Consume ;; if present
    if (this.check(TokenType.DSEMI)) this.advance();
    this.skipNewlines();

    return { patterns, body };
  }

  // ─── Function Definition (Grammar Rules 59-62) ────────────────

  private parseFunctionDef(): FunctionDef {
    const pos = this.peek().position;
    let name: string;

    if (this.checkWord('function')) {
      this.advance();
      this.skipNewlines();
      name = this.advance().value;
      // Optional ()
      if (this.check(TokenType.LPAREN)) {
        this.advance();
        this.expect(TokenType.RPAREN);
      }
    } else {
      // name() form
      name = this.advance().value;
      this.expect(TokenType.LPAREN);
      this.expect(TokenType.RPAREN);
    }

    this.skipNewlines();
    const body = this.parseCommand();

    const redirections = this.parseTrailingRedirections();
    return { type: 'FunctionDef', name, body, redirections, position: pos };
  }

  // ─── Brace Group & Subshell (Grammar Rules 37-38) ─────────────

  private parseBraceGroup(): BraceGroup {
    const pos = this.peek().position;
    this.expect(TokenType.LBRACE);
    this.skipNewlines();
    const body = this.parseCommandList();
    this.skipNewlines();
    this.expect(TokenType.RBRACE);
    const redirections = this.parseTrailingRedirections();
    return { type: 'BraceGroup', body, redirections, position: pos };
  }

  private parseSubshell(): Subshell {
    const pos = this.peek().position;
    this.expect(TokenType.LPAREN);
    this.skipNewlines();
    const body = this.parseCommandList();
    this.skipNewlines();
    this.expect(TokenType.RPAREN);
    const redirections = this.parseTrailingRedirections();
    return { type: 'Subshell', body, redirections, position: pos };
  }

  // ─── Word Parsing ─────────────────────────────────────────────

  /**
   * Parse a word, fusing any immediately-adjacent atoms into a single
   * {@link CompoundWord}. This is how `name='a b'`, `pre"$x"post` and
   * `foo'bar'` become one shell word rather than several.
   */
  private parseWord(): Word {
    const first = this.parseWordAtom();
    if (this.isAtEnd() || !this.peek().adjacent || !this.isWordToken() || this.isCompoundEnd()) {
      return first;
    }
    const parts: Word[] = [first];
    while (!this.isAtEnd() && this.peek().adjacent && this.isWordToken() && !this.isCompoundEnd()) {
      parts.push(this.parseWordAtom());
    }
    return { type: 'CompoundWord', parts, position: first.position };
  }

  /** Parse exactly one word token into its Word AST node. */
  private parseWordAtom(): Word {
    const tok = this.advance();
    const pos = tok.position;

    switch (tok.type) {
      case TokenType.WORD:
        return makeLiteralWord(tok.value, pos);
      case TokenType.SINGLE_QUOTED:
        return { type: 'SingleQuotedWord', value: tok.value, position: pos };
      case TokenType.DOUBLE_QUOTED:
        return { type: 'DoubleQuotedWord', parts: [{ type: 'text', value: tok.value }], position: pos };
      case TokenType.VAR_SIMPLE:
        return { type: 'VariableRef', name: tok.value, braced: false, position: pos };
      case TokenType.VAR_BRACED:
        return this.parseBracedVar(tok.value, pos);
      case TokenType.VAR_SPECIAL:
        return { type: 'VariableRef', name: tok.value, braced: false, position: pos };
      case TokenType.CMD_SUB:
        return { type: 'CommandSubstitution', command: tok.value, backtick: false, position: pos };
      case TokenType.CMD_SUB_BACKTICK:
        return { type: 'CommandSubstitution', command: tok.value, backtick: true, position: pos };
      case TokenType.ARITH_SUB:
        return { type: 'ArithmeticSubstitution', expression: tok.value, position: pos };
      case TokenType.NUMBER:
        return makeLiteralWord(tok.value, pos);
      case TokenType.ASSIGNMENT_WORD:
        // Treated as word in suffix position
        return makeLiteralWord(tok.value, pos);
      case TokenType.LBRACKET:
      case TokenType.RBRACKET:
      case TokenType.DLBRACKET:
      case TokenType.DRBRACKET:
        return makeLiteralWord(tok.value, pos);
      default:
        throw new ParserError(`Unexpected token type ${tok.type} ('${tok.value}')`, pos);
    }
  }

  private parseBracedVar(content: string, pos: SourcePosition | undefined): Word {
    // ${VAR}, ${VAR:-default}, ${VAR:+alt}, ${VAR:=val}, ${#VAR}
    const modifierMatch = content.match(/^(\w+)(:-|:=|:\+|:|\+|-|=)(.*)$/);
    if (modifierMatch) {
      return {
        type: 'VariableRef', name: modifierMatch[1], braced: true,
        modifier: modifierMatch[2] + modifierMatch[3], position: pos,
      };
    }
    if (content.startsWith('#')) {
      return {
        type: 'VariableRef', name: content.slice(1), braced: true,
        modifier: '#', position: pos,
      };
    }
    return { type: 'VariableRef', name: content, braced: true, position: pos };
  }

  // ─── Assignment Parsing ───────────────────────────────────────

  private parseAssignment(): Assignment {
    const tok = this.advance();
    const pos = tok.position;
    // The lexer marks `name+=…` as ASSIGNMENT_WORD too (the `+=` literal
    // is encoded in the raw value); detect it here.
    const eqIdx = tok.value.indexOf('=');
    const append = eqIdx > 0 && tok.value[eqIdx - 1] === '+';
    const name = tok.value.substring(0, append ? eqIdx - 1 : eqIdx);
    const rawValue = tok.value.substring(eqIdx + 1);

    // ── Array literal: `name=(elem1 elem2 …)` ────────────────────
    // Triggered when the RHS is empty (the lexer broke at `(`) and the
    // very next token is `(` with no intervening whitespace.
    if (rawValue === '' && this.check(TokenType.LPAREN) && this.peek().adjacent) {
      this.advance();                                       // consume `(`
      this.skipNewlines();
      const elements: Word[] = [];
      while (!this.isAtEnd() && !this.check(TokenType.RPAREN)) {
        if (this.isWordToken()) elements.push(this.parseWord());
        else this.advance();                                // skip stray whitespace / newlines
        this.skipNewlines();
      }
      this.expect(TokenType.RPAREN);
      return { type: 'Assignment', name, value: null, arrayElements: elements, append, position: pos };
    }

    // Collect any adjacent (no-whitespace) tokens that continue the value.
    // This makes `ROOT=/srv/$1`, `OUT=$(date)foo`, `LIST="a b"$XS` parse
    // as a single compound assignment value rather than splitting after
    // the literal prefix.
    const parts: Word[] = [];
    if (rawValue) parts.push(makeLiteralWord(rawValue, pos));
    while (!this.isAtEnd() && this.peek().adjacent && this.isWordToken() && !this.isCompoundEnd()) {
      parts.push(this.parseWordAtom());
    }
    // Empty form `X=` followed by whitespace: also support `X=$VAR` where
    // the value starts at the next (separated) word.
    if (parts.length === 0 && this.isWordToken() && !this.isCompoundEnd()) {
      parts.push(this.parseWord());
    }
    let value: Word | null = null;
    if (parts.length === 1) value = parts[0];
    else if (parts.length > 1) value = { type: 'CompoundWord', parts, position: pos };
    return { type: 'Assignment', name, value, append, position: pos };
  }

  // ─── Redirection Parsing ──────────────────────────────────────

  private parseRedirection(): Redirection {
    const tok = this.advance();
    const pos = tok.position;
    let fd: number | undefined;
    let op: RedirectionOp;

    switch (tok.type) {
      case TokenType.GREAT: op = '>'; break;
      case TokenType.DGREAT: op = '>>'; break;
      case TokenType.LESS: op = '<'; break;
      case TokenType.HEREDOC: op = '<<'; break;
      case TokenType.HERESTRING: op = '<<<'; break;
      case TokenType.LESSAND: op = '<&'; break;
      case TokenType.GREATAND: {
        // GREATAND can be: >&, 2>&1, 1>&2, etc.
        const gaMatch = tok.value.match(/^(\d+)>&(\d+)$/);
        if (gaMatch) {
          fd = parseInt(gaMatch[1]);
          op = '>&';
          const target = makeLiteralWord(gaMatch[2], pos);
          return makeRedirection(op, target, fd, pos);
        }
        op = '>&';
        break;
      }
      case TokenType.FD_GREAT: {
        const match = tok.value.match(/^(\d+)>$/);
        fd = match ? parseInt(match[1]) : undefined;
        op = '>';
        break;
      }
      case TokenType.FD_DGREAT: {
        const match = tok.value.match(/^(\d+)>>$/);
        fd = match ? parseInt(match[1]) : undefined;
        op = '>>';
        break;
      }
      default:
        throw new ParserError(`Expected redirection operator, got '${tok.value}'`, pos);
    }

    const target = this.parseWord();
    return makeRedirection(op, target, fd, pos);
  }

  private parseTrailingRedirections(): Redirection[] {
    const redirections: Redirection[] = [];
    while (this.isRedirectionStart()) {
      redirections.push(this.parseRedirection());
    }
    return redirections;
  }

  // ─── Helpers ───────────────────────────────────────────────────

  private peek(): Token { return this.tokens[this.pos] || this.tokens[this.tokens.length - 1]; }

  private advance(): Token {
    const tok = this.tokens[this.pos];
    this.pos++;
    return tok;
  }

  private check(type: TokenType): boolean {
    return !this.isAtEnd() && this.peek().type === type;
  }

  private checkWord(word: string): boolean {
    return this.check(TokenType.WORD) && this.peek().value === word;
  }

  private expect(type: TokenType): Token {
    if (!this.check(type)) {
      const tok = this.peek();
      throw new ParserError(`Expected ${type}, got '${tok.value}'`, tok.position);
    }
    return this.advance();
  }

  private expectWord(word: string): Token {
    if (!this.checkWord(word)) {
      const tok = this.peek();
      throw new ParserError(`Expected '${word}', got '${tok.value}'`, tok.position);
    }
    return this.advance();
  }

  private isAtEnd(): boolean {
    return this.pos >= this.tokens.length || this.peek().type === TokenType.EOF;
  }

  private skipNewlines(): void {
    while (this.check(TokenType.NEWLINE)) this.advance();
  }

  private matchSeparator(): boolean {
    if (this.check(TokenType.SEMI) || this.check(TokenType.AMP) || this.check(TokenType.NEWLINE)) {
      this.advance();
      this.skipNewlines();
      return true;
    }
    return false;
  }

  /** Check if current token starts a redirection. */
  private isRedirectionStart(): boolean {
    if (this.isAtEnd()) return false;
    const t = this.peek().type;
    return t === TokenType.GREAT || t === TokenType.DGREAT || t === TokenType.LESS
      || t === TokenType.HEREDOC || t === TokenType.HERESTRING || t === TokenType.LESSAND
      || t === TokenType.GREATAND || t === TokenType.FD_GREAT || t === TokenType.FD_DGREAT;
  }

  /** Check if current token could be part of a word. */
  private isWordToken(): boolean {
    if (this.isAtEnd()) return false;
    const t = this.peek().type;
    return t === TokenType.WORD || t === TokenType.SINGLE_QUOTED || t === TokenType.DOUBLE_QUOTED
      || t === TokenType.VAR_SIMPLE || t === TokenType.VAR_BRACED || t === TokenType.VAR_SPECIAL
      || t === TokenType.CMD_SUB || t === TokenType.CMD_SUB_BACKTICK || t === TokenType.ARITH_SUB
      || t === TokenType.NUMBER || t === TokenType.ASSIGNMENT_WORD
      || t === TokenType.LBRACKET || t === TokenType.RBRACKET
      || t === TokenType.DLBRACKET || t === TokenType.DRBRACKET;
  }

  /**
   * Is the current token a compound-command terminator? Reserved-word
   * recognition is gated on `contextStack`: `done` ends a loop only
   * when one is open, `fi` ends an `if` only inside one, etc. This is
   * why bare `echo done` parses cleanly at the top level instead of
   * tripping over `done` as a stray keyword.
   *
   * `RBRACE`, `RPAREN`, and `DSEMI` are unambiguous operator tokens,
   * so they always terminate regardless of context.
   */
  private isCompoundEnd(): boolean {
    if (this.isAtEnd()) return false;
    const tok = this.peek();
    if (tok.type === TokenType.RBRACE || tok.type === TokenType.RPAREN || tok.type === TokenType.DSEMI) {
      return true;
    }
    if (tok.type !== TokenType.WORD) return false;
    const v = tok.value;
    const top = this.contextStack[this.contextStack.length - 1];
    if (!top) return false;                  // no open compound → no reserved-word ends
    if (top === 'if')   return v === 'then' || v === 'elif' || v === 'else' || v === 'fi';
    if (top === 'loop') return v === 'do' || v === 'done';
    if (top === 'case') return v === 'esac';
    return false;
  }

  /** Run `fn` with `ctx` pushed on the context stack. */
  private withContext<T>(ctx: ParseContext, fn: () => T): T {
    this.contextStack.push(ctx);
    try { return fn(); }
    finally { this.contextStack.pop(); }
  }

  /** Detect function definition: WORD ( ) */
  private isFunctionDef(): boolean {
    if (!this.check(TokenType.WORD)) return false;
    if (BASH_KEYWORDS.has(this.peek().value)) return false;
    // Look ahead for ()
    const saved = this.pos;
    this.pos++;
    const isFunc = this.check(TokenType.LPAREN) &&
      this.pos + 1 < this.tokens.length && this.tokens[this.pos + 1].type === TokenType.RPAREN;
    this.pos = saved;
    return isFunc;
  }
}
