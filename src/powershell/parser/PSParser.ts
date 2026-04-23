/**
 * PSParser — Recursive descent parser for PowerShell 5.1.
 *
 * Consumes PSToken[] from PSLexer and produces a PSProgram AST.
 *
 * Grammar summary:
 *   Program → StatementList EOF
 *   StatementList → (Statement (NEWLINE|SEMICOLON)*)*
 *   Statement → AssignmentStatement | PipelineStatement | compound-statement
 *   Pipeline → Command (PIPE Command)*
 *   Command → cmdName parameter* argument*
 *   Expression → unary, binary, member, index, cast, range, ...
 */

import { PSTokenType, PS_OPERATOR_PARAMS } from '@/powershell/lexer/PSToken';
// PSTokenType.INCREMENT and PSTokenType.DECREMENT are used below
import type { PSToken, SourcePosition } from '@/powershell/lexer/PSToken';
import { PSParserError } from './PSParserError';
import {
  makeProgram, makeStatementList, makePipeline, makePipelineStatement,
  makeCommand, makeCommandParam, makeLiteral, makeVariable,
  makeAssignment, makeUnary, makeBinary, makeRange,
  makeMember, makeIndex, makeCast, makeScriptBlock,
  makeHashtable, makeArrayExpr, makeIfStatement, makeFunctionDef,
  makeRedirection,
} from './PSASTNode';
import type {
  PSProgram, PSStatementList, PSStatement, PSPipelineStatement, PSPipeline,
  PSCommand, PSCommandParameter, PSAssignmentStatement,
  PSIfStatement, PSElseifClause, PSWhileStatement, PSDoWhileStatement,
  PSDoUntilStatement, PSForStatement, PSForeachStatement,
  PSSwitchStatement, PSSwitchClause, PSTryStatement, PSCatchClause,
  PSFunctionDefinition, PSReturnStatement, PSBreakStatement,
  PSContinueStatement, PSThrowStatement, PSTrapStatement,
  PSScriptBlock, PSParamBlock, PSParamDeclaration, PSAttribute,
  PSExpression, PSLiteralExpression, PSVariableExpression,
  PSBinaryExpression, PSBinaryOperator, PSUnaryOperator,
  PSHashtableExpression, PSHashtablePair, PSArrayExpression,
  PSPipelineExpression,
  PSRedirection, PSRedirectionOp,
  PSClassDefinition, PSClassMember, PSPropertyDeclaration, PSMethodDefinition,
  PSEnumDefinition, PSEnumMember,
} from './PSASTNode';

// ─── Operator precedence (higher = tighter binding) ──────────────────────────

const PRECEDENCE: Record<string, number> = {
  '-or': 1, '-xor': 2, '-and': 3,
  '-band': 4, '-bor': 4, '-bxor': 4,
  '-eq': 5, '-ne': 5, '-gt': 5, '-ge': 5, '-lt': 5, '-le': 5,
  '-ceq': 5, '-cne': 5, '-cgt': 5, '-cge': 5, '-clt': 5, '-cle': 5,
  '-ieq': 5, '-ine': 5, '-igt': 5, '-ige': 5, '-ilt': 5, '-ile': 5,
  '-like': 5, '-notlike': 5, '-match': 5, '-notmatch': 5,
  '-clike': 5, '-cnotlike': 5, '-cmatch': 5, '-cnotmatch': 5,
  '-ilike': 5, '-inotlike': 5, '-imatch': 5, '-inotmatch': 5,
  '-contains': 5, '-notcontains': 5, '-in': 5, '-notin': 5,
  '-is': 5, '-isnot': 5, '-as': 5,
  '-replace': 6, '-creplace': 6, '-ireplace': 6,
  '-split': 6, '-csplit': 6, '-isplit': 6,
  '-join': 6,
  '-f': 6,
  ',': 7,
  '-shl': 8, '-shr': 8,
  '+': 9, '-': 9,
  '*': 10, '/': 10, '%': 10,
};

export class PSParser {
  private tokens: PSToken[] = [];
  private pos: number = 0;

  // ─── Public API ────────────────────────────────────────────────────────────

  parse(tokens: PSToken[]): PSProgram {
    this.tokens = tokens;
    this.pos = 0;
    this.skipTerminators();
    const body = this.parseStatementList();
    this.skipTerminators();
    if (!this.isAtEnd()) {
      const tok = this.peek();
      throw new PSParserError(`Unexpected token '${tok.value}' (${tok.type})`, tok.position);
    }
    return makeProgram(body, tokens[0]?.position);
  }

  // ─── Statement List ────────────────────────────────────────────────────────

  parseStatementList(until?: () => boolean): PSStatementList {
    const pos = this.peek().position;
    const statements: PSStatement[] = [];
    this.skipTerminators();
    while (!this.isAtEnd() && !(until?.() ?? false)) {
      statements.push(this.parseStatement());
      // Consume one or more statement terminators
      if (!this.isAtEnd() && this.isTerminator()) {
        this.skipTerminators();
      } else {
        break;
      }
    }
    return makeStatementList(statements, pos);
  }

  // ─── Statement dispatcher ──────────────────────────────────────────────────

  private parseStatement(): PSStatement {
    const tok = this.peek();

    // ── Keyword-driven compound statements ──
    if (tok.type === PSTokenType.WORD) {
      switch (tok.value) {
        case 'if':        return this.parseIfStatement();
        case 'while':     return this.parseWhileStatement();
        case 'do':        return this.parseDoStatement();
        case 'for':       return this.parseForStatement();
        case 'foreach':   return this.parseForeachStatement();
        case 'switch':    return this.parseSwitchStatement();
        case 'try':       return this.parseTryStatement();
        case 'function':
        case 'filter':
        case 'workflow':
        case 'configuration': return this.parseFunctionDef();
        case 'class':     return this.parseClassDef();
        case 'enum':      return this.parseEnumDef();
        case 'return':    return this.parseReturnStatement();
        case 'break':     return this.parseBreakStatement();
        case 'continue':  return this.parseContinueStatement();
        case 'throw':     return this.parseThrowStatement();
        case 'trap':      return this.parseTrapStatement();
        case 'using':     return this.parseUsingStatement();
      }
    }

    // ── Assignment: $var = / += / -= / etc. ──
    if (tok.type === PSTokenType.VARIABLE && this.isAssignmentAhead()) {
      return this.parseAssignmentStatement();
    }

    // ── Default: pipeline statement ──
    return this.parsePipelineStatement();
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private peek(): PSToken { return this.tokens[this.pos] || this.tokens[this.tokens.length - 1]; }

  private peekAt(offset: number): PSToken | undefined { return this.tokens[this.pos + offset]; }

  private advance(): PSToken {
    const tok = this.tokens[this.pos];
    if (!this.isAtEnd()) this.pos++;
    return tok;
  }

  private isAtEnd(): boolean {
    return this.pos >= this.tokens.length || this.peek().type === PSTokenType.EOF;
  }

  private check(type: PSTokenType): boolean {
    return !this.isAtEnd() && this.peek().type === type;
  }

  private checkValue(type: PSTokenType, value: string): boolean {
    return this.check(type) && this.peek().value === value;
  }

  private expect(type: PSTokenType, hint?: string): PSToken {
    if (!this.check(type)) {
      const tok = this.peek();
      throw new PSParserError(
        `Expected ${hint ?? type}, got '${tok.value}' (${tok.type})`,
        tok.position,
      );
    }
    return this.advance();
  }

  private expectWord(word: string): PSToken {
    if (!this.checkValue(PSTokenType.WORD, word)) {
      const tok = this.peek();
      throw new PSParserError(`Expected keyword '${word}', got '${tok.value}'`, tok.position);
    }
    return this.advance();
  }

  private isTerminator(): boolean {
    return this.check(PSTokenType.NEWLINE) || this.check(PSTokenType.SEMICOLON);
  }

  private skipTerminators(): void {
    while (this.isTerminator()) this.advance();
  }

  /**
   * Skip only newline terminators — preserve semicolons so they can continue
   * to delimit compound statements (e.g. `if (...) {} ;` followed by another stmt).
   */
  private skipNewlinesOnly(): void {
    while (this.check(PSTokenType.NEWLINE)) this.advance();
  }

  private pos_(): SourcePosition { return this.peek().position; }

  /**
   * Detect VARIABLE (possibly followed by index/member chain) followed by an
   * assignment operator.  Matches: `$v =`, `$v[...] =`, `$v.prop =`, etc.
   */
  private isAssignmentAhead(): boolean {
    let i = 1;
    // Walk past postfix chain: [index], .member, ::member
    while (true) {
      const tok = this.peekAt(i);
      if (!tok) return false;
      if (tok.type === PSTokenType.LBRACKET) {
        // Skip balanced brackets
        let depth = 1;
        i++;
        while (depth > 0) {
          const t = this.peekAt(i);
          if (!t || t.type === PSTokenType.EOF) return false;
          if (t.type === PSTokenType.LBRACKET) depth++;
          else if (t.type === PSTokenType.RBRACKET) depth--;
          i++;
        }
        continue;
      }
      if (tok.type === PSTokenType.DOT) { i += 2; continue; } // .member
      if (tok.type === PSTokenType.STATIC_MEMBER) { i += 2; continue; } // ::member
      break;
    }
    const next = this.peekAt(i);
    if (!next) return false;
    return next.type === PSTokenType.ASSIGN
      || next.type === PSTokenType.PLUS_ASSIGN
      || next.type === PSTokenType.MINUS_ASSIGN
      || next.type === PSTokenType.MULTIPLY_ASSIGN
      || next.type === PSTokenType.DIVIDE_ASSIGN
      || next.type === PSTokenType.MODULO_ASSIGN;
  }

  /** True if current token can start an expression */
  private canStartExpression(): boolean {
    const t = this.peek().type;
    const v = this.peek().value;
    return t === PSTokenType.VARIABLE
      || t === PSTokenType.NUMBER
      || t === PSTokenType.STRING_SINGLE
      || t === PSTokenType.STRING_DOUBLE
      || t === PSTokenType.HEREDOC_SINGLE
      || t === PSTokenType.HEREDOC_DOUBLE
      || t === PSTokenType.SUBEXPR
      || t === PSTokenType.LPAREN
      || t === PSTokenType.LBRACE
      || t === PSTokenType.AT
      || t === PSTokenType.TYPE
      || t === PSTokenType.NOT
      || t === PSTokenType.SPLATTED
      || (t === PSTokenType.PARAMETER && (v === 'not' || PS_OPERATOR_PARAMS.has(v)))
      || (t === PSTokenType.WORD && v !== 'else' && v !== 'elseif' && v !== 'catch'
          && v !== 'finally' && v !== 'default' && v !== 'end' && v !== 'process' && v !== 'begin');
  }

  /** True if current token is `++` or `--` */
  private isIncrDecr(): boolean {
    return this.check(PSTokenType.INCREMENT) || this.check(PSTokenType.DECREMENT);
  }

  /** True if current token is a redirection operator */
  private isRedirection(): boolean {
    const t = this.peek().type;
    return t === PSTokenType.REDIRECT_OUT || t === PSTokenType.REDIRECT_APPEND
      || t === PSTokenType.REDIRECT_ERR_OUT || t === PSTokenType.REDIRECT_ERR_APPEND
      || t === PSTokenType.REDIRECT_ALL_OUT || t === PSTokenType.REDIRECT_ALL_APPEND;
  }

  // ─── Pipeline Statement ────────────────────────────────────────────────────

  private parsePipelineStatement(): PSPipelineStatement {
    const pos = this.pos_();
    const pipeline = this.parsePipeline();
    const redirections = this.parseRedirections();
    return makePipelineStatement(pipeline, redirections, pos);
  }

  private parsePipeline(): PSPipeline {
    const pos = this.pos_();
    const commands: PSCommand[] = [this.parseCommand()];
    while (this.check(PSTokenType.PIPE)) {
      this.advance(); // consume |
      this.skipTerminators();
      commands.push(this.parseCommand());
    }
    return makePipeline(commands, pos);
  }

  private parseCommand(): PSCommand {
    const pos = this.pos_();
    const name = this.parseCommandName();
    const parameters: PSCommandParameter[] = [];
    const args: PSExpression[] = [];

    // Parse parameters and arguments
    while (!this.isAtEnd() && !this.isTerminator() && !this.check(PSTokenType.PIPE) && !this.isRedirection()) {
      if (this.check(PSTokenType.PARAMETER)) {
        parameters.push(this.parseCommandParameter());
      } else if (this.canStartExpression()) {
        args.push(this.parseCommandArgument());
      } else {
        break;
      }
    }

    return makeCommand(name, parameters, args, pos);
  }

  /**
   * Parse the command name: a cmdlet name (WORD), variable ($var), or & expr (call operator).
   * When the head is a literal string, number, or expression, it's treated as a command name too.
   */
  private parseCommandName(): PSExpression {
    const pos = this.pos_();
    const tok = this.peek();

    if (tok.type === PSTokenType.AMPERSAND) {
      // & $var or & "script.ps1"
      this.advance();
      return this.parsePrimaryExpression();
    }

    if (tok.type === PSTokenType.VARIABLE) {
      // Use parseExpression so that binary ops ($_ * 10, $x -gt 3),
      // postfix ($x++, $x.Prop, $x[i]), and assignment-ops ($x+=1) are consumed fully.
      return this.parseExpression();
    }

    if (tok.type === PSTokenType.WORD || tok.type === PSTokenType.NUMBER
        || tok.type === PSTokenType.STRING_SINGLE || tok.type === PSTokenType.STRING_DOUBLE) {
      this.advance();
      // Numbers and strings as command heads are treated as literals
      if (tok.type === PSTokenType.NUMBER) return this.makeNumberLiteral(tok.value, pos);
      if (tok.type === PSTokenType.STRING_SINGLE) {
        return makeLiteral(tok.value, tok.value, 'string', pos);
      }
      if (tok.type === PSTokenType.STRING_DOUBLE) {
        return makeLiteral(tok.value, tok.value, 'expandable', pos);
      }
      return { type: 'CommandExpression', name: tok.value, position: pos };
    }

    if (tok.type === PSTokenType.LPAREN || tok.type === PSTokenType.AT || tok.type === PSTokenType.TYPE) {
      return this.parsePrimaryExpression();
    }

    this.advance();
    return { type: 'CommandExpression', name: tok.value, position: pos };
  }

  private parseCommandParameter(): PSCommandParameter {
    const pos = this.pos_();
    const paramTok = this.advance(); // consume PARAMETER token
    const name = paramTok.value;    // already lowercased

    // If next token can be a value (not another param, not a terminator, not a pipe)
    // and the param name is NOT a known operator used standalone
    let value: PSExpression | null = null;
    if (!PS_OPERATOR_PARAMS.has(name) && this.canStartExpression()
        && !this.isTerminator() && !this.check(PSTokenType.PIPE)) {
      value = this.parseCommandArgument();
    }

    return makeCommandParam(name, value, pos);
  }

  /**
   * Parse a command argument (value after cmdlet name or -ParamName).
   * In command mode, expressions are "argument expressions" — less permissive than
   * full expression mode (no binary operators at top level unless parenthesized).
   */
  private parseCommandArgument(): PSExpression {
    const pos = this.pos_();
    const first = this.parsePostfixExpression();
    if (!this.check(PSTokenType.COMMA)) return first;
    // Comma-separated list → ArrayExpression
    const elements: PSStatement[] = [this.exprToStatement(first)];
    while (this.check(PSTokenType.COMMA)) {
      this.advance();
      if (this.isAtEnd() || this.isTerminator() || this.check(PSTokenType.PIPE)) break;
      elements.push(this.exprToStatement(this.parsePostfixExpression()));
    }
    return makeArrayExpr(elements, pos);
  }

  // ─── Redirections ──────────────────────────────────────────────────────────

  private parseRedirections(): PSRedirection[] {
    const result: PSRedirection[] = [];
    while (this.isRedirection()) {
      const pos = this.pos_();
      const op = this.advance().value as PSRedirectionOp;
      let target: PSExpression | null = null;
      if (this.canStartExpression()) target = this.parsePrimaryExpression();
      result.push(makeRedirection(op, target, pos));
    }
    return result;
  }

  // ─── Assignment Statement ──────────────────────────────────────────────────

  private parseAssignmentStatement(): PSAssignmentStatement {
    const pos = this.pos_();
    // Parse a postfix expression so the target can be $v, $v[i], $v.prop, etc.
    const target = this.parsePostfixExpression() as PSAssignmentStatement['target'];
    const opTok = this.advance(); // = += -= etc.
    const operator = opTok.value as PSAssignmentStatement['operator'];
    const value = this.parseAssignmentRHS();

    return makeAssignment(target, operator, value, pos);
  }

  /**
   * Parses the right-hand side of an assignment.
   * Handles: single expression, comma list, cmdlet call with named params, and pipeline.
   */
  private parseAssignmentRHS(): PSExpression {
    const pos = this.pos_();
    const first = this.parseCommaList();

    // "CmdLet -ParamName value" — the first token was a WORD/cmdlet and a PARAMETER follows
    // that is NOT an operator (e.g. not -eq, -and, …)
    if (this.check(PSTokenType.PARAMETER) && !PS_OPERATOR_PARAMS.has(this.peek().value)) {
      const params: PSCommandParameter[] = [];
      const args:   PSExpression[]       = [];
      while (this.check(PSTokenType.PARAMETER)) params.push(this.parseCommandParameter());
      while (!this.isAtEnd() && !this.isTerminator() && !this.check(PSTokenType.PIPE)
             && this.canStartExpression()) {
        args.push(this.parseCommandArgument());
      }
      const firstCmd = makeCommand(first, params, args, pos);
      const cmds = [firstCmd];
      while (this.check(PSTokenType.PIPE)) { this.advance(); cmds.push(this.parseCommand()); }
      return { type: 'PipelineExpression', pipeline: makePipeline(cmds, pos), position: pos };
    }

    if (!this.check(PSTokenType.PIPE)) return first;
    return this.continuePipeline(first, pos);
  }

  /**
   * Parses a comma-separated list of expressions.
   * If only one expression, returns it directly; otherwise wraps in ArrayExpression.
   */
  parseCommaList(): PSExpression {
    const pos = this.pos_();
    const first = this.parseExpression();
    if (!this.check(PSTokenType.COMMA)) return first;
    const elements: PSStatement[] = [this.exprToStatement(first)];
    while (this.check(PSTokenType.COMMA)) {
      this.advance();
      this.skipTerminators();
      if (this.isAtEnd() || this.isTerminator() || this.check(PSTokenType.PIPE)) break;
      elements.push(this.exprToStatement(this.parseExpression()));
    }
    return makeArrayExpr(elements, pos);
  }

  /** Wraps an expression in a minimal PipelineStatement for ArrayExpression.elements */
  private exprToStatement(expr: PSExpression): PSStatement {
    const cmd = makeCommand(expr, [], [], expr.position);
    const pl  = makePipeline([cmd], expr.position);
    return makePipelineStatement(pl, [], expr.position);
  }

  /** Given a head expression already parsed, continues consuming | commands. */
  private continuePipeline(head: PSExpression, pos: SourcePosition): PSPipelineExpression {
    const firstCmd = makeCommand(head, [], [], head.position);
    const commands: PSCommand[] = [firstCmd];
    while (this.check(PSTokenType.PIPE)) {
      this.advance();
      commands.push(this.parseCommand());
    }
    const pipeline = makePipeline(commands, pos);
    return { type: 'PipelineExpression', pipeline, position: pos };
  }

  // ─── if / elseif / else ────────────────────────────────────────────────────

  private parseIfStatement(): PSIfStatement {
    const pos = this.pos_();
    this.expectWord('if');
    this.expect(PSTokenType.LPAREN);
    const condition = this.parseExpression();
    this.expect(PSTokenType.RPAREN);
    const thenBody = this.parseScriptBlock();

    const elseifClauses: PSElseifClause[] = [];
    let elseBody: PSScriptBlock | null = null;

    // Only skip newlines here — semicolons must remain as statement separators
    // so the if-statement can be followed by `; nextStatement` in a block.
    this.skipNewlinesOnly();
    while (this.checkValue(PSTokenType.WORD, 'elseif')) {
      this.advance(); // elseif
      this.expect(PSTokenType.LPAREN);
      const eic = this.parseExpression();
      this.expect(PSTokenType.RPAREN);
      const eib = this.parseScriptBlock();
      elseifClauses.push({ condition: eic, body: eib });
      this.skipNewlinesOnly();
    }

    if (this.checkValue(PSTokenType.WORD, 'else')) {
      this.advance(); // else
      elseBody = this.parseScriptBlock();
    }

    return makeIfStatement(condition, thenBody, elseifClauses, elseBody, pos);
  }

  // ─── while ─────────────────────────────────────────────────────────────────

  private parseWhileStatement(): PSWhileStatement {
    const pos = this.pos_();
    this.expectWord('while');
    this.expect(PSTokenType.LPAREN);
    const condition = this.parseExpression();
    this.expect(PSTokenType.RPAREN);
    const body = this.parseScriptBlock();
    return { type: 'WhileStatement', condition, body, position: pos };
  }

  // ─── do / while | until ────────────────────────────────────────────────────

  private parseDoStatement(): PSDoWhileStatement | PSDoUntilStatement {
    const pos = this.pos_();
    this.expectWord('do');
    const body = this.parseScriptBlock();
    this.skipTerminators();
    const keyword = this.peek().value; // 'while' or 'until'
    this.advance();
    this.expect(PSTokenType.LPAREN);
    const condition = this.parseExpression();
    this.expect(PSTokenType.RPAREN);
    if (keyword === 'until') {
      return { type: 'DoUntilStatement', body, condition, position: pos };
    }
    return { type: 'DoWhileStatement', body, condition, position: pos };
  }

  // ─── for (init; cond; iter) ────────────────────────────────────────────────

  private parseForStatement(): PSForStatement {
    const pos = this.pos_();
    this.expectWord('for');
    this.expect(PSTokenType.LPAREN);

    let init: PSStatement | null = null;
    if (!this.check(PSTokenType.SEMICOLON)) {
      init = this.parseStatement();
    }
    this.expect(PSTokenType.SEMICOLON);

    let condition: PSExpression | null = null;
    if (!this.check(PSTokenType.SEMICOLON)) {
      condition = this.parseExpression();
    }
    this.expect(PSTokenType.SEMICOLON);

    let iterator: PSStatement | null = null;
    if (!this.check(PSTokenType.RPAREN)) {
      iterator = this.parseStatement();
    }
    this.expect(PSTokenType.RPAREN);
    const body = this.parseScriptBlock();
    return { type: 'ForStatement', init, condition, iterator, body, position: pos };
  }

  // ─── foreach ───────────────────────────────────────────────────────────────

  private parseForeachStatement(): PSForeachStatement {
    const pos = this.pos_();
    this.expectWord('foreach');

    // Optional flags: -parallel, etc.
    const flags: string[] = [];
    while (this.check(PSTokenType.PARAMETER)) {
      flags.push(this.advance().value);
    }

    this.expect(PSTokenType.LPAREN);
    const varTok = this.expect(PSTokenType.VARIABLE);
    const variable = makeVariable(varTok.value, varTok.position);
    this.expectWord('in');
    const collection = this.parseCommaList();
    this.expect(PSTokenType.RPAREN);
    const body = this.parseScriptBlock();
    return { type: 'ForeachStatement', flags, variable, collection, body, position: pos };
  }

  // ─── switch ────────────────────────────────────────────────────────────────

  private parseSwitchStatement(): PSSwitchStatement {
    const pos = this.pos_();
    this.expectWord('switch');

    const flags: string[] = [];
    while (this.check(PSTokenType.PARAMETER)) {
      flags.push(this.advance().value); // regex, wildcard, exact, caseSensitive, file
    }

    this.expect(PSTokenType.LPAREN);
    const subject = this.parseExpression();
    this.expect(PSTokenType.RPAREN);
    this.skipTerminators();
    this.expect(PSTokenType.LBRACE);
    this.skipTerminators();

    const clauses: PSSwitchClause[] = [];
    let defaultBody: PSScriptBlock | null = null;

    while (!this.check(PSTokenType.RBRACE) && !this.isAtEnd()) {
      if (this.checkValue(PSTokenType.WORD, 'default')) {
        this.advance();
        defaultBody = this.parseScriptBlock();
      } else {
        const pattern = this.parseExpression();
        const body = this.parseScriptBlock();
        clauses.push({ pattern, body });
      }
      this.skipTerminators();
    }

    this.expect(PSTokenType.RBRACE);
    return { type: 'SwitchStatement', flags, subject, clauses, defaultBody, position: pos };
  }

  // ─── try / catch / finally ─────────────────────────────────────────────────

  private parseTryStatement(): PSTryStatement {
    const pos = this.pos_();
    this.expectWord('try');
    const tryBody = this.parseScriptBlock();

    const catchClauses: PSCatchClause[] = [];
    let finallyBody: PSScriptBlock | null = null;

    this.skipTerminators();
    while (this.checkValue(PSTokenType.WORD, 'catch')) {
      this.advance(); // catch
      const types: string[] = [];
      // Optional [ExceptionType] list
      while (this.check(PSTokenType.TYPE)) {
        types.push(this.advance().value);
        // Multiple types separated by comma
        if (this.check(PSTokenType.COMMA)) this.advance();
      }
      const body = this.parseScriptBlock();
      catchClauses.push({ types, body });
      this.skipTerminators();
    }

    if (this.checkValue(PSTokenType.WORD, 'finally')) {
      this.advance();
      finallyBody = this.parseScriptBlock();
    }

    return { type: 'TryStatement', tryBody, catchClauses, finallyBody, position: pos };
  }

  // ─── function / filter ─────────────────────────────────────────────────────

  private parseFunctionDef(): PSFunctionDefinition {
    const pos = this.pos_();
    const kindTok = this.advance(); // function | filter | workflow | configuration
    const kind = kindTok.value as PSFunctionDefinition['kind'];

    // Function name: any WORD (including Verb-Noun style with hyphens)
    const nameTok = this.advance();
    const name = nameTok.value;

    const body = this.parseScriptBlock();
    return makeFunctionDef(kind, name, body, pos);
  }

  // ─── class ─────────────────────────────────────────────────────────────────

  private parseClassDef(): PSClassDefinition {
    const pos = this.pos_();
    this.expectWord('class');
    const name = this.advance().value;
    let baseClass: string | null = null;
    const interfaces: string[] = [];

    if (this.checkValue(PSTokenType.WORD, ':')) {
      this.advance(); // :
      baseClass = this.advance().value;
    }

    this.expect(PSTokenType.LBRACE);
    this.skipTerminators();
    const members: PSClassMember[] = [];
    while (!this.check(PSTokenType.RBRACE) && !this.isAtEnd()) {
      members.push(this.parseClassMember());
      this.skipTerminators();
    }
    this.expect(PSTokenType.RBRACE);
    return { type: 'ClassDefinition', name, baseClass, interfaces, members, position: pos };
  }

  private parseClassMember(): PSClassMember {
    const pos = this.pos_();
    const modifiers: string[] = [];
    while (this.checkValue(PSTokenType.WORD, 'hidden') || this.checkValue(PSTokenType.WORD, 'static')) {
      modifiers.push(this.advance().value);
    }
    let memberType: string | null = null;
    if (this.check(PSTokenType.TYPE)) memberType = this.advance().value;

    const nameTok = this.advance();

    // Method: name followed by LPAREN
    if (this.check(PSTokenType.LPAREN)) {
      this.advance(); // (
      const params: PSParamDeclaration[] = [];
      if (!this.check(PSTokenType.RPAREN)) {
        do {
          if (this.check(PSTokenType.COMMA)) this.advance();
          params.push(this.parseParamDeclaration());
        } while (this.check(PSTokenType.COMMA));
      }
      this.expect(PSTokenType.RPAREN);
      this.skipTerminators();
      this.expect(PSTokenType.LBRACE);
      const body = this.parseStatementList(() => this.check(PSTokenType.RBRACE));
      this.expect(PSTokenType.RBRACE);
      return { type: 'MethodDefinition', modifiers, returnType: memberType, name: nameTok.value, parameters: params, body, position: pos };
    }

    // Property
    let initializer = null;
    if (this.check(PSTokenType.ASSIGN)) { this.advance(); initializer = this.parseExpression(); }
    return { type: 'PropertyDeclaration', modifiers, propertyType: memberType, name: nameTok.value, initializer, position: pos };
  }

  // ─── enum ──────────────────────────────────────────────────────────────────

  private parseEnumDef(): PSEnumDefinition {
    const pos = this.pos_();
    this.expectWord('enum');
    const name = this.advance().value;
    let baseType: string | null = null;
    if (this.checkValue(PSTokenType.WORD, ':')) { this.advance(); baseType = this.advance().value; }
    this.expect(PSTokenType.LBRACE);
    this.skipTerminators();
    const members: PSEnumMember[] = [];
    while (!this.check(PSTokenType.RBRACE) && !this.isAtEnd()) {
      const memberName = this.advance().value;
      let value = null;
      if (this.check(PSTokenType.ASSIGN)) { this.advance(); value = this.parseExpression(); }
      members.push({ name: memberName, value });
      this.skipTerminators();
    }
    this.expect(PSTokenType.RBRACE);
    return { type: 'EnumDefinition', name, baseType, members, position: pos };
  }

  // ─── Control flow ──────────────────────────────────────────────────────────

  private parseReturnStatement(): PSReturnStatement {
    const pos = this.pos_();
    this.expectWord('return');
    const value = !this.isTerminator() && !this.isAtEnd() && this.canStartExpression()
      ? this.parseExpression() : null;
    return { type: 'ReturnStatement', value, position: pos };
  }

  private parseBreakStatement(): PSBreakStatement {
    const pos = this.pos_();
    this.expectWord('break');
    const label = this.check(PSTokenType.WORD) && !this.isTerminator() ? this.advance().value : null;
    return { type: 'BreakStatement', label, position: pos };
  }

  private parseContinueStatement(): PSContinueStatement {
    const pos = this.pos_();
    this.expectWord('continue');
    const label = this.check(PSTokenType.WORD) && !this.isTerminator() ? this.advance().value : null;
    return { type: 'ContinueStatement', label, position: pos };
  }

  private parseThrowStatement(): PSThrowStatement {
    const pos = this.pos_();
    this.expectWord('throw');
    const value = !this.isTerminator() && !this.isAtEnd() && this.canStartExpression()
      ? this.parseExpression() : null;
    return { type: 'ThrowStatement', value, position: pos };
  }

  private parseTrapStatement(): PSTrapStatement {
    const pos = this.pos_();
    this.expectWord('trap');
    let exceptionType: string | null = null;
    if (this.check(PSTokenType.TYPE)) exceptionType = this.advance().value;
    const body = this.parseScriptBlock();
    return { type: 'TrapStatement', exceptionType, body, position: pos };
  }

  private parseUsingStatement() {
    const pos = this.pos_();
    this.expectWord('using');
    const kindTok = this.advance(); // module, namespace, assembly
    const kind = kindTok.value as 'module' | 'namespace' | 'assembly';
    const name = this.peek().type === PSTokenType.STRING_SINGLE || this.peek().type === PSTokenType.STRING_DOUBLE
      ? this.advance().value
      : this.advance().value;
    return { type: 'UsingStatement' as const, kind, name, position: pos };
  }

  // ─── Script Block { ... } ──────────────────────────────────────────────────

  private parseScriptBlock(): PSScriptBlock {
    const pos = this.pos_();
    this.skipTerminators();
    this.expect(PSTokenType.LBRACE);
    this.skipTerminators();

    let paramBlock: PSParamBlock | null = null;
    let beginBlock = null, processBlock = null, endBlock = null;
    let body = null;

    // param() block at the very start of the script block
    if (this.checkValue(PSTokenType.WORD, 'param')) {
      paramBlock = this.parseParamBlock();
      this.skipTerminators();
    }

    // Named blocks begin/process/end
    if (this.checkValue(PSTokenType.WORD, 'begin')
        || this.checkValue(PSTokenType.WORD, 'process')
        || this.checkValue(PSTokenType.WORD, 'end')
        || this.checkValue(PSTokenType.WORD, 'dynamicparam')) {
      while (!this.check(PSTokenType.RBRACE) && !this.isAtEnd()) {
        const blockKw = this.peek().value;
        this.advance(); // consume begin/process/end
        const bl = this.parseInnerBlock();
        if (blockKw === 'begin') beginBlock = bl;
        else if (blockKw === 'process') processBlock = bl;
        else if (blockKw === 'end') endBlock = bl;
        this.skipTerminators();
      }
    } else {
      // Regular body
      body = this.parseStatementList(() => this.check(PSTokenType.RBRACE));
    }

    this.expect(PSTokenType.RBRACE);
    const sb = makeScriptBlock(body, paramBlock, pos);
    sb.beginBlock = beginBlock;
    sb.processBlock = processBlock;
    sb.endBlock = endBlock;
    return sb;
  }

  private parseInnerBlock() {
    this.expect(PSTokenType.LBRACE);
    this.skipTerminators();
    const stmts = this.parseStatementList(() => this.check(PSTokenType.RBRACE));
    this.expect(PSTokenType.RBRACE);
    return stmts;
  }

  // ─── param() block ─────────────────────────────────────────────────────────

  private parseParamBlock(): PSParamBlock {
    const pos = this.pos_();
    this.expectWord('param');
    this.expect(PSTokenType.LPAREN);
    const parameters: PSParamDeclaration[] = [];

    while (!this.check(PSTokenType.RPAREN) && !this.isAtEnd()) {
      this.skipTerminators();
      if (this.check(PSTokenType.RPAREN)) break;
      parameters.push(this.parseParamDeclaration());
      this.skipTerminators();
      if (this.check(PSTokenType.COMMA)) { this.advance(); this.skipTerminators(); }
    }

    this.expect(PSTokenType.RPAREN);
    return { type: 'ParamBlock', attributes: [], parameters, position: pos };
  }

  private parseParamDeclaration(): PSParamDeclaration {
    const pos = this.pos_();
    const attrs: PSAttribute[] = [];

    // [Attribute(...)] decorators
    while (this.check(PSTokenType.TYPE) && this.peekAt(1)?.type !== PSTokenType.VARIABLE) {
      attrs.push(this.parseAttribute());
    }

    // [type] annotation
    let paramType: string | null = null;
    if (this.check(PSTokenType.TYPE)) {
      paramType = this.advance().value;
    }

    const varTok = this.expect(PSTokenType.VARIABLE);
    const name = makeVariable(varTok.value, varTok.position);

    let defaultValue: PSExpression | null = null;
    if (this.check(PSTokenType.ASSIGN)) {
      this.advance();
      // Comma separates parameters in the param block — don't let comma form an array here.
      defaultValue = this.parseExpression(PRECEDENCE[',']);
    }

    return { type: 'ParamDeclaration', attributes: attrs, paramType, name, defaultValue, mandatory: false, position: pos };
  }

  private parseAttribute(): PSAttribute {
    const pos = this.pos_();
    const name = this.advance().value; // TYPE token contains the attribute name

    const positionalArgs: PSExpression[] = [];
    const namedArgs: Record<string, PSExpression> = {};

    if (this.check(PSTokenType.LPAREN)) {
      this.advance();
      while (!this.check(PSTokenType.RPAREN) && !this.isAtEnd()) {
        // Named arg: Name = value
        if ((this.check(PSTokenType.WORD) || this.check(PSTokenType.PARAMETER))
            && this.peekAt(1)?.type === PSTokenType.ASSIGN) {
          const k = this.advance().value;
          this.advance(); // =
          namedArgs[k] = this.parseExpression();
        } else {
          positionalArgs.push(this.parseExpression());
        }
        if (this.check(PSTokenType.COMMA)) this.advance();
      }
      this.expect(PSTokenType.RPAREN);
    }

    return { type: 'Attribute', name, positionalArgs, namedArgs, position: pos };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Expression Parsing — Pratt-style (precedence climbing)
  // ═══════════════════════════════════════════════════════════════════════════

  parseExpression(minPrec: number = 0): PSExpression {
    // Unary prefix operators
    let left = this.parseUnaryExpression();

    // Binary operators via precedence climbing
    while (true) {
      const op = this.currentBinaryOp();
      if (!op) break;
      const prec = PRECEDENCE[op] ?? 0;
      if (prec <= minPrec) break;

      // Comma operator → build an ArrayExpression collecting all same-prec elements
      if (op === ',') {
        const elements: PSStatement[] = [this.exprToStatement(left)];
        while (this.check(PSTokenType.COMMA)) {
          this.advance();
          this.skipTerminators();
          if (this.isAtEnd() || this.isTerminator() || this.check(PSTokenType.PIPE)) break;
          elements.push(this.exprToStatement(this.parseExpression(PRECEDENCE[','])));
        }
        left = makeArrayExpr(elements, left.position);
        continue;
      }

      this.advance(); // consume operator token
      const right = this.parseExpression(prec);
      left = makeBinary(op as PSBinaryOperator, left, right, left.position);
    }

    // Range operator a..b
    if (this.check(PSTokenType.RANGE)) {
      this.advance();
      const end = this.parseExpression(PRECEDENCE['+']);
      left = makeRange(left, end, left.position);
    }

    return left;
  }

  private parseUnaryExpression(): PSExpression {
    const pos = this.pos_();

    // -not, !
    if (this.check(PSTokenType.NOT)) {
      this.advance();
      return makeUnary('!', this.parseUnaryExpression(), pos);
    }
    if (this.checkValue(PSTokenType.PARAMETER, 'not')) {
      this.advance();
      return makeUnary('-not', this.parseUnaryExpression(), pos);
    }
    if (this.checkValue(PSTokenType.PARAMETER, 'bnot')) {
      this.advance();
      return makeUnary('-bnot' as PSUnaryOperator, this.parseUnaryExpression(), pos);
    }

    // Prefix ++ and --
    if (this.check(PSTokenType.INCREMENT)) {
      this.advance();
      const operand = this.parseUnaryExpression() as PSVariableExpression;
      return makeAssignment(operand, '+=', makeLiteral(1, '1', 'number', pos), pos) as unknown as PSExpression;
    }
    if (this.check(PSTokenType.DECREMENT)) {
      this.advance();
      const operand = this.parseUnaryExpression() as PSVariableExpression;
      return makeAssignment(operand, '-=', makeLiteral(1, '1', 'number', pos), pos) as unknown as PSExpression;
    }

    // Unary + and - (arithmetic sign)
    if (this.check(PSTokenType.MINUS)) {
      this.advance();
      return makeUnary('-', this.parseUnaryExpression(), pos);
    }
    if (this.check(PSTokenType.PLUS)) {
      this.advance();
      return makeUnary('+', this.parseUnaryExpression(), pos);
    }

    // Type cast: [TypeName] expr
    if (this.check(PSTokenType.TYPE)) {
      const typeName = this.advance().value;
      const operand = this.parseUnaryExpression();
      return makeCast(typeName, operand, pos);
    }

    return this.parsePostfixExpression();
  }

  /** Returns the binary operator string for the current token, or null */
  private currentBinaryOp(): string | null {
    const tok = this.peek();

    if (tok.type === PSTokenType.PLUS) return '+';
    if (tok.type === PSTokenType.MINUS) return '-';
    if (tok.type === PSTokenType.MULTIPLY) return '*';
    if (tok.type === PSTokenType.DIVIDE) return '/';
    if (tok.type === PSTokenType.MODULO) return '%';
    if (tok.type === PSTokenType.COMMA) return ',';

    if (tok.type === PSTokenType.PARAMETER) {
      const v = `-${tok.value}`;
      if (PRECEDENCE[v] !== undefined) return v;
    }

    return null;
  }

  // ─── Postfix expressions (.member, [index], method()) ─────────────────────

  private parsePostfixExpression(): PSExpression {
    let expr = this.parsePrimaryExpression();

    while (true) {
      if (this.check(PSTokenType.DOT)) {
        const pos = this.pos_();
        this.advance();
        if (this.check(PSTokenType.WORD) || this.check(PSTokenType.NUMBER)) {
          const member = this.advance().value;
          // Method call: $obj.Method(args)
          if (this.check(PSTokenType.LPAREN)) {
            this.advance();
            const args = this.parseArgumentList();
            this.expect(PSTokenType.RPAREN);
            expr = { type: 'InvocationExpression', callee: makeMember(expr, member, false, pos), arguments: args, position: pos };
          } else {
            expr = makeMember(expr, member, false, pos);
          }
        }
        continue;
      }

      if (this.check(PSTokenType.STATIC_MEMBER)) {
        const pos = this.pos_();
        this.advance();
        const member = this.advance().value;
        if (this.check(PSTokenType.LPAREN)) {
          this.advance();
          const args = this.parseArgumentList();
          this.expect(PSTokenType.RPAREN);
          // Static method call
          const typeName = (expr as { typeName?: string }).typeName ?? '';
          const callee = { type: 'StaticMemberExpression' as const, typeName, member, position: pos };
          expr = { type: 'InvocationExpression', callee, arguments: args, position: pos };
        } else {
          const typeName = (expr as { typeName?: string }).typeName ?? '';
          expr = { type: 'StaticMemberExpression', typeName, member, position: pos };
        }
        continue;
      }

      // Index access: expr[index]
      if (this.check(PSTokenType.LBRACKET)) {
        const pos = this.pos_();
        this.advance();
        const index = this.parseExpression();
        this.expect(PSTokenType.RBRACKET);
        expr = makeIndex(expr, index, pos);
        continue;
      }

      // Postfix ++ / -- : convert to assignment expression ($x++ → $x += 1)
      if (this.check(PSTokenType.INCREMENT)) {
        const pos = this.pos_();
        this.advance();
        const target = expr as PSVariableExpression;
        expr = makeAssignment(target, '+=', makeLiteral(1, '1', 'number', pos), pos) as unknown as PSExpression;
        continue;
      }
      if (this.check(PSTokenType.DECREMENT)) {
        const pos = this.pos_();
        this.advance();
        const target = expr as PSVariableExpression;
        expr = makeAssignment(target, '-=', makeLiteral(1, '1', 'number', pos), pos) as unknown as PSExpression;
        continue;
      }

      break;
    }

    return expr;
  }

  // ─── Primary Expressions ───────────────────────────────────────────────────

  private parsePrimaryExpression(): PSExpression {
    const pos = this.pos_();
    const tok = this.peek();

    // ── Parenthesized expression (expr) ──
    if (tok.type === PSTokenType.LPAREN) {
      this.advance();
      const inner = this.parseExpression();
      this.expect(PSTokenType.RPAREN);
      return inner;
    }

    // ── Variable ──
    if (tok.type === PSTokenType.VARIABLE) {
      this.advance();
      // Special automatic variables → literals
      if (tok.value === 'true') return makeLiteral(true, '$true', 'boolean', pos);
      if (tok.value === 'false') return makeLiteral(false, '$false', 'boolean', pos);
      if (tok.value === 'null') return makeLiteral(null, '$null', 'null', pos);
      return makeVariable(tok.value, pos);
    }

    // ── Subexpression $(...) ──
    if (tok.type === PSTokenType.SUBEXPR) {
      this.advance();
      // Parse the inner content recursively
      const innerTokens = new PSLexer_().tokenize(tok.value);
      const innerParser = new PSParser();
      const innerAst = innerParser.parse(innerTokens);
      return { type: 'SubExpression', body: innerAst.body, position: pos };
    }

    // ── Array expression @(...) ──
    if (tok.type === PSTokenType.AT && this.peekAt(1)?.type === PSTokenType.LPAREN) {
      this.advance(); // @
      this.advance(); // (
      this.skipTerminators();
      const elements: PSStatement[] = [];
      while (!this.check(PSTokenType.RPAREN) && !this.isAtEnd()) {
        elements.push(this.parseStatement());
        this.skipTerminators();
        if (this.check(PSTokenType.COMMA)) { this.advance(); this.skipTerminators(); }
      }
      this.expect(PSTokenType.RPAREN);
      return makeArrayExpr(elements, pos);
    }

    // ── Hashtable @{...} ──
    if (tok.type === PSTokenType.AT && this.peekAt(1)?.type === PSTokenType.LBRACE) {
      this.advance(); // @
      this.advance(); // {
      this.skipTerminators();
      const pairs: PSHashtablePair[] = [];
      while (!this.check(PSTokenType.RBRACE) && !this.isAtEnd()) {
        // In hashtable key position, barewords are string literals
        const key = this.parseHashtableKey();
        this.expect(PSTokenType.ASSIGN);
        const value = this.parseExpression();
        pairs.push({ key, value });
        this.skipTerminators();
        if (this.check(PSTokenType.SEMICOLON)) { this.advance(); this.skipTerminators(); }
      }
      this.expect(PSTokenType.RBRACE);
      return makeHashtable(pairs, pos);
    }

    // ── Bare @ alone ──
    if (tok.type === PSTokenType.AT) {
      this.advance();
      return { type: 'CommandExpression', name: '@', position: pos };
    }

    // ── Script block { ... } ──
    if (tok.type === PSTokenType.LBRACE) {
      return this.parseScriptBlock();
    }

    // ── Type literal [TypeName] — when used as a value ──
    if (tok.type === PSTokenType.TYPE) {
      this.advance();
      return { type: 'TypeLiteral', typeName: tok.value, position: pos };
    }

    // ── Splatting @varname ──
    if (tok.type === PSTokenType.SPLATTED) {
      this.advance();
      return { type: 'SplatExpression', name: tok.value, position: pos };
    }

    // ── Number literal ──
    if (tok.type === PSTokenType.NUMBER) {
      this.advance();
      return this.makeNumberLiteral(tok.value, pos);
    }

    // ── String literals ──
    if (tok.type === PSTokenType.STRING_SINGLE) {
      this.advance();
      return makeLiteral(tok.value, tok.value, 'string', pos);
    }
    if (tok.type === PSTokenType.STRING_DOUBLE) {
      this.advance();
      return makeLiteral(tok.value, tok.value, 'expandable', pos);
    }
    if (tok.type === PSTokenType.HEREDOC_SINGLE || tok.type === PSTokenType.HEREDOC_DOUBLE) {
      this.advance();
      return makeLiteral(tok.value, tok.value, 'heredoc', pos);
    }

    // ── Bareword (used in expression context) ──
    if (tok.type === PSTokenType.WORD) {
      this.advance();
      return { type: 'CommandExpression', name: tok.value, position: pos };
    }

    // ── Unknown — skip and return a placeholder ──
    this.advance();
    return { type: 'CommandExpression', name: tok.value, position: pos };
  }

  /** In hashtable key position, bareword identifiers become string literals */
  private parseHashtableKey(): PSExpression {
    const pos = this.pos_();
    const tok = this.peek();
    if (tok.type === PSTokenType.WORD) {
      this.advance();
      return makeLiteral(tok.value, tok.value, 'string', pos);
    }
    return this.parseExpression();
  }

  private makeNumberLiteral(raw: string, pos: SourcePosition): PSLiteralExpression {
    let value: number;
    if (raw.startsWith('0x') || raw.startsWith('0X')) {
      value = parseInt(raw, 16);
    } else if (raw.endsWith('KB') || raw.endsWith('kb')) {
      value = parseFloat(raw) * 1024;
    } else if (raw.endsWith('MB') || raw.endsWith('mb')) {
      value = parseFloat(raw) * 1024 * 1024;
    } else if (raw.endsWith('GB') || raw.endsWith('gb')) {
      value = parseFloat(raw) * 1024 ** 3;
    } else if (raw.endsWith('TB') || raw.endsWith('tb')) {
      value = parseFloat(raw) * 1024 ** 4;
    } else if (raw.endsWith('PB') || raw.endsWith('pb')) {
      value = parseFloat(raw) * 1024 ** 5;
    } else if (raw.endsWith('L') || raw.endsWith('l')) {
      value = parseInt(raw, 10);
    } else {
      value = parseFloat(raw);
    }
    return makeLiteral(value, raw, 'number', pos);
  }

  // ─── Argument list (method calls) ──────────────────────────────────────────

  private parseArgumentList(): PSExpression[] {
    const args: PSExpression[] = [];
    if (this.check(PSTokenType.RPAREN)) return args;
    // Pass minPrec = PRECEDENCE[','] so comma isn't consumed as array construction.
    args.push(this.parseExpression(PRECEDENCE[',']));
    while (this.check(PSTokenType.COMMA)) {
      this.advance();
      args.push(this.parseExpression(PRECEDENCE[',']));
    }
    return args;
  }
}

// Lazy import of PSLexer to avoid circular deps — used only for parsing SUBEXPR content
import { PSLexer as PSLexer_ } from '@/powershell/lexer/PSLexer';
