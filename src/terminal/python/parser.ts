/**
 * Python Parser - Parse tokens into AST
 */

import { Token, TokenType, KEYWORDS } from './lexer';
import { SyntaxError } from './errors';
import {
  ASTNode, FunctionParam,
  NumberLiteral, StringLiteral, BoolLiteral, NoneLiteral, Identifier,
  BinaryOp, UnaryOp, Compare, BoolOp,
  Assignment, AugmentedAssignment, MultipleAssignment,
  ListExpr, TupleExpr, DictExpr, SetExpr, Subscript, Slice, Attribute, Call,
  IfExpr, IfStatement, WhileStatement, ForStatement,
  FunctionDef, ClassDef, Return, Break, Continue, Pass,
  Import, ImportFrom, TryExcept, ExceptHandler, Raise, Assert, Delete,
  WithStatement, ListComp, DictComp, SetComp, GeneratorExpr,
  ComprehensionGenerator, Lambda, YieldExpr, Global, Nonlocal, ExprStatement
} from './types';

export class Parser {
  private tokens: Token[];
  private pos: number = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parse(): ASTNode[] {
    const statements: ASTNode[] = [];

    while (!this.isAtEnd()) {
      this.skipNewlines();
      if (!this.isAtEnd()) {
        const stmt = this.parseStatement();
        if (stmt) {
          statements.push(stmt);
        }
      }
    }

    return statements;
  }

  // Parse a single line for REPL
  parseSingle(): ASTNode | null {
    this.skipNewlines();
    if (this.isAtEnd()) return null;
    return this.parseStatement();
  }

  private parseStatement(): ASTNode {
    // Handle compound statements
    if (this.check(TokenType.KEYWORD)) {
      const keyword = this.peek().value as string;

      switch (keyword) {
        case 'if': return this.parseIf();
        case 'while': return this.parseWhile();
        case 'for': return this.parseFor();
        case 'def': return this.parseFunctionDef();
        case 'class': return this.parseClassDef();
        case 'try': return this.parseTry();
        case 'with': return this.parseWith();
        case 'return': return this.parseReturn();
        case 'break': return this.parseBreak();
        case 'continue': return this.parseContinue();
        case 'pass': return this.parsePass();
        case 'import': return this.parseImport();
        case 'from': return this.parseFromImport();
        case 'raise': return this.parseRaise();
        case 'assert': return this.parseAssert();
        case 'del': return this.parseDelete();
        case 'global': return this.parseGlobal();
        case 'nonlocal': return this.parseNonlocal();
      }
    }

    // Handle decorators
    if (this.check(TokenType.AT)) {
      return this.parseDecorated();
    }

    // Expression statement (including assignments)
    return this.parseExpressionStatement();
  }

  private parseExpressionStatement(): ASTNode {
    const expr = this.parseExpression();

    // Check for assignment
    if (this.check(TokenType.ASSIGN)) {
      return this.parseAssignment(expr);
    }

    // Check for augmented assignment
    if (this.checkAugAssign()) {
      return this.parseAugmentedAssignment(expr);
    }

    this.consumeNewline();
    return { type: 'ExprStatement', expr } as ExprStatement;
  }

  private parseAssignment(target: ASTNode): ASTNode {
    const targets: ASTNode[] = [target];

    while (this.match(TokenType.ASSIGN)) {
      const value = this.parseExpression();

      if (this.check(TokenType.ASSIGN)) {
        targets.push(value);
      } else {
        this.consumeNewline();

        if (targets.length === 1) {
          return { type: 'Assignment', target: targets[0], value } as Assignment;
        } else {
          return { type: 'MultipleAssignment', targets, value } as MultipleAssignment;
        }
      }
    }

    throw this.error('Expected value after =');
  }

  private parseAugmentedAssignment(target: ASTNode): ASTNode {
    const opToken = this.advance();
    const operator = opToken.value as AugmentedAssignment['operator'];
    const value = this.parseExpression();
    this.consumeNewline();

    return { type: 'AugmentedAssignment', operator, target, value } as AugmentedAssignment;
  }

  private parseExpression(): ASTNode {
    return this.parseTernary();
  }

  private parseTernary(): ASTNode {
    let expr = this.parseOr();

    if (this.checkKeyword('if')) {
      this.advance();
      const test = this.parseOr();
      this.expectKeyword('else');
      const orelse = this.parseTernary();
      return { type: 'IfExpr', test, body: expr, orelse } as IfExpr;
    }

    return expr;
  }

  private parseOr(): ASTNode {
    let left = this.parseAnd();

    while (this.checkKeyword('or')) {
      this.advance();
      const right = this.parseAnd();
      left = { type: 'BoolOp', operator: 'or', values: [left, right] } as BoolOp;
    }

    return left;
  }

  private parseAnd(): ASTNode {
    let left = this.parseNot();

    while (this.checkKeyword('and')) {
      this.advance();
      const right = this.parseNot();
      left = { type: 'BoolOp', operator: 'and', values: [left, right] } as BoolOp;
    }

    return left;
  }

  private parseNot(): ASTNode {
    if (this.checkKeyword('not')) {
      this.advance();
      const operand = this.parseNot();
      return { type: 'UnaryOp', operator: 'not', operand } as UnaryOp;
    }

    return this.parseComparison();
  }

  private parseComparison(): ASTNode {
    let left = this.parseBitwiseOr();
    const ops: Compare['ops'] = [];
    const comparators: ASTNode[] = [];

    while (true) {
      let op: Compare['ops'][0] | null = null;

      if (this.match(TokenType.EQ)) op = '==';
      else if (this.match(TokenType.NE)) op = '!=';
      else if (this.match(TokenType.LT)) op = '<';
      else if (this.match(TokenType.GT)) op = '>';
      else if (this.match(TokenType.LE)) op = '<=';
      else if (this.match(TokenType.GE)) op = '>=';
      else if (this.checkKeyword('in')) {
        this.advance();
        op = 'in';
      }
      else if (this.checkKeyword('not') && this.peekNext()?.value === 'in') {
        this.advance();
        this.advance();
        op = 'not in';
      }
      else if (this.checkKeyword('is')) {
        this.advance();
        if (this.checkKeyword('not')) {
          this.advance();
          op = 'is not';
        } else {
          op = 'is';
        }
      }

      if (op === null) break;

      ops.push(op);
      comparators.push(this.parseBitwiseOr());
    }

    if (ops.length === 0) return left;

    return { type: 'Compare', left, ops, comparators } as Compare;
  }

  private parseBitwiseOr(): ASTNode {
    let left = this.parseBitwiseXor();

    while (this.match(TokenType.PIPE)) {
      const right = this.parseBitwiseXor();
      left = { type: 'BinaryOp', operator: '|' as any, left, right };
    }

    return left;
  }

  private parseBitwiseXor(): ASTNode {
    let left = this.parseBitwiseAnd();

    while (this.match(TokenType.CARET)) {
      const right = this.parseBitwiseAnd();
      left = { type: 'BinaryOp', operator: '^' as any, left, right };
    }

    return left;
  }

  private parseBitwiseAnd(): ASTNode {
    let left = this.parseShift();

    while (this.match(TokenType.AMP)) {
      const right = this.parseShift();
      left = { type: 'BinaryOp', operator: '&' as any, left, right };
    }

    return left;
  }

  private parseShift(): ASTNode {
    let left = this.parseAddSub();

    while (true) {
      if (this.match(TokenType.LSHIFT)) {
        const right = this.parseAddSub();
        left = { type: 'BinaryOp', operator: '<<' as any, left, right };
      } else if (this.match(TokenType.RSHIFT)) {
        const right = this.parseAddSub();
        left = { type: 'BinaryOp', operator: '>>' as any, left, right };
      } else {
        break;
      }
    }

    return left;
  }

  private parseAddSub(): ASTNode {
    let left = this.parseMulDiv();

    while (true) {
      if (this.match(TokenType.PLUS)) {
        const right = this.parseMulDiv();
        left = { type: 'BinaryOp', operator: '+', left, right } as BinaryOp;
      } else if (this.match(TokenType.MINUS)) {
        const right = this.parseMulDiv();
        left = { type: 'BinaryOp', operator: '-', left, right } as BinaryOp;
      } else {
        break;
      }
    }

    return left;
  }

  private parseMulDiv(): ASTNode {
    let left = this.parseUnary();

    while (true) {
      if (this.match(TokenType.STAR)) {
        const right = this.parseUnary();
        left = { type: 'BinaryOp', operator: '*', left, right } as BinaryOp;
      } else if (this.match(TokenType.SLASH)) {
        const right = this.parseUnary();
        left = { type: 'BinaryOp', operator: '/', left, right } as BinaryOp;
      } else if (this.match(TokenType.DOUBLESLASH)) {
        const right = this.parseUnary();
        left = { type: 'BinaryOp', operator: '//', left, right } as BinaryOp;
      } else if (this.match(TokenType.PERCENT)) {
        const right = this.parseUnary();
        left = { type: 'BinaryOp', operator: '%', left, right } as BinaryOp;
      } else if (this.match(TokenType.AT)) {
        const right = this.parseUnary();
        left = { type: 'BinaryOp', operator: '@', left, right } as BinaryOp;
      } else {
        break;
      }
    }

    return left;
  }

  private parseUnary(): ASTNode {
    if (this.match(TokenType.MINUS)) {
      const operand = this.parseUnary();
      return { type: 'UnaryOp', operator: '-', operand } as UnaryOp;
    }

    if (this.match(TokenType.PLUS)) {
      const operand = this.parseUnary();
      return { type: 'UnaryOp', operator: '+', operand } as UnaryOp;
    }

    if (this.match(TokenType.TILDE)) {
      const operand = this.parseUnary();
      return { type: 'UnaryOp', operator: '~', operand } as UnaryOp;
    }

    return this.parsePower();
  }

  private parsePower(): ASTNode {
    const left = this.parsePostfix();

    if (this.match(TokenType.DOUBLESTAR)) {
      const right = this.parseUnary();
      return { type: 'BinaryOp', operator: '**', left, right } as BinaryOp;
    }

    return left;
  }

  private parsePostfix(): ASTNode {
    let expr = this.parsePrimary();

    while (true) {
      if (this.match(TokenType.LPAREN)) {
        expr = this.parseCall(expr);
      } else if (this.match(TokenType.LBRACKET)) {
        expr = this.parseSubscript(expr);
      } else if (this.match(TokenType.DOT)) {
        const attr = this.expect(TokenType.IDENTIFIER).value as string;
        expr = { type: 'Attribute', object: expr, attr } as Attribute;
      } else {
        break;
      }
    }

    return expr;
  }

  private parseCall(func: ASTNode): Call {
    const args: ASTNode[] = [];
    const kwargs: { name: string; value: ASTNode }[] = [];
    let starArgs: ASTNode | undefined;
    let starKwargs: ASTNode | undefined;

    if (!this.check(TokenType.RPAREN)) {
      do {
        if (this.match(TokenType.DOUBLESTAR)) {
          starKwargs = this.parseExpression();
        } else if (this.match(TokenType.STAR)) {
          starArgs = this.parseExpression();
        } else {
          const expr = this.parseExpression();

          // Check if this is a keyword argument
          if (expr.type === 'Identifier' && this.match(TokenType.ASSIGN)) {
            const value = this.parseExpression();
            kwargs.push({ name: (expr as Identifier).name, value });
          } else {
            args.push(expr);
          }
        }
      } while (this.match(TokenType.COMMA) && !this.check(TokenType.RPAREN));
    }

    this.expect(TokenType.RPAREN);

    return { type: 'Call', func, args, kwargs, starArgs, starKwargs };
  }

  private parseSubscript(object: ASTNode): ASTNode {
    // Check for slice
    if (this.check(TokenType.COLON) || this.isSliceStart()) {
      const slice = this.parseSlice();
      this.expect(TokenType.RBRACKET);
      return { type: 'Subscript', object, index: slice } as Subscript;
    }

    const index = this.parseExpression();

    // Check if this is actually a slice after the first expression
    if (this.check(TokenType.COLON)) {
      const slice = this.parseSliceAfter(index);
      this.expect(TokenType.RBRACKET);
      return { type: 'Subscript', object, index: slice } as Subscript;
    }

    this.expect(TokenType.RBRACKET);
    return { type: 'Subscript', object, index } as Subscript;
  }

  private isSliceStart(): boolean {
    const token = this.peek();
    if (token.type === TokenType.COLON) return true;
    // Could have an expression then colon
    return false;
  }

  private parseSlice(): Slice {
    let lower: ASTNode | null = null;
    let upper: ASTNode | null = null;
    let step: ASTNode | null = null;

    // Parse lower bound
    if (!this.check(TokenType.COLON)) {
      lower = this.parseExpression();
    }

    this.expect(TokenType.COLON);

    // Parse upper bound
    if (!this.check(TokenType.COLON) && !this.check(TokenType.RBRACKET)) {
      upper = this.parseExpression();
    }

    // Parse step
    if (this.match(TokenType.COLON)) {
      if (!this.check(TokenType.RBRACKET)) {
        step = this.parseExpression();
      }
    }

    return { type: 'Slice', lower, upper, step };
  }

  private parseSliceAfter(lower: ASTNode): Slice {
    let upper: ASTNode | null = null;
    let step: ASTNode | null = null;

    this.expect(TokenType.COLON);

    // Parse upper bound
    if (!this.check(TokenType.COLON) && !this.check(TokenType.RBRACKET)) {
      upper = this.parseExpression();
    }

    // Parse step
    if (this.match(TokenType.COLON)) {
      if (!this.check(TokenType.RBRACKET)) {
        step = this.parseExpression();
      }
    }

    return { type: 'Slice', lower, upper, step };
  }

  private parsePrimary(): ASTNode {
    // Numbers
    if (this.check(TokenType.NUMBER)) {
      const token = this.advance();
      const value = token.value as number;
      return {
        type: 'NumberLiteral',
        value,
        isFloat: !Number.isInteger(value)
      } as NumberLiteral;
    }

    // Strings
    if (this.check(TokenType.STRING) || this.check(TokenType.FSTRING)) {
      const token = this.advance();
      return {
        type: 'StringLiteral',
        value: token.value as string,
        isFormatted: token.type === TokenType.FSTRING
      } as StringLiteral;
    }

    // Keywords: True, False, None
    if (this.checkKeyword('True')) {
      this.advance();
      return { type: 'BoolLiteral', value: true } as BoolLiteral;
    }
    if (this.checkKeyword('False')) {
      this.advance();
      return { type: 'BoolLiteral', value: false } as BoolLiteral;
    }
    if (this.checkKeyword('None')) {
      this.advance();
      return { type: 'NoneLiteral' } as NoneLiteral;
    }

    // Lambda
    if (this.checkKeyword('lambda')) {
      return this.parseLambda();
    }

    // Yield
    if (this.checkKeyword('yield')) {
      return this.parseYield();
    }

    // Identifiers
    if (this.check(TokenType.IDENTIFIER)) {
      const name = this.advance().value as string;
      return { type: 'Identifier', name } as Identifier;
    }

    // Parenthesized expression, tuple, or generator
    if (this.match(TokenType.LPAREN)) {
      return this.parseParenExpr();
    }

    // List or list comprehension
    if (this.match(TokenType.LBRACKET)) {
      return this.parseListOrComp();
    }

    // Dict, set, or comprehension
    if (this.match(TokenType.LBRACE)) {
      return this.parseDictSetOrComp();
    }

    // Ellipsis
    if (this.match(TokenType.ELLIPSIS)) {
      return { type: 'Identifier', name: '...' } as Identifier;
    }

    throw this.error(`Unexpected token: ${this.peek().value}`);
  }

  private parseParenExpr(): ASTNode {
    // Empty tuple
    if (this.match(TokenType.RPAREN)) {
      return { type: 'TupleExpr', elements: [] } as TupleExpr;
    }

    const first = this.parseExpression();

    // Generator expression
    if (this.checkKeyword('for')) {
      const generators = this.parseComprehensionGenerators();
      this.expect(TokenType.RPAREN);
      return { type: 'GeneratorExpr', element: first, generators } as GeneratorExpr;
    }

    // Tuple with trailing comma or multiple elements
    if (this.match(TokenType.COMMA)) {
      const elements: ASTNode[] = [first];

      if (!this.check(TokenType.RPAREN)) {
        do {
          elements.push(this.parseExpression());
        } while (this.match(TokenType.COMMA) && !this.check(TokenType.RPAREN));
      }

      this.expect(TokenType.RPAREN);
      return { type: 'TupleExpr', elements } as TupleExpr;
    }

    // Just a parenthesized expression
    this.expect(TokenType.RPAREN);
    return first;
  }

  private parseListOrComp(): ASTNode {
    // Empty list
    if (this.match(TokenType.RBRACKET)) {
      return { type: 'ListExpr', elements: [] } as ListExpr;
    }

    const first = this.parseExpression();

    // List comprehension
    if (this.checkKeyword('for')) {
      const generators = this.parseComprehensionGenerators();
      this.expect(TokenType.RBRACKET);
      return { type: 'ListComp', element: first, generators } as ListComp;
    }

    // Regular list
    const elements: ASTNode[] = [first];

    while (this.match(TokenType.COMMA) && !this.check(TokenType.RBRACKET)) {
      elements.push(this.parseExpression());
    }

    this.expect(TokenType.RBRACKET);
    return { type: 'ListExpr', elements } as ListExpr;
  }

  private parseDictSetOrComp(): ASTNode {
    // Empty dict
    if (this.match(TokenType.RBRACE)) {
      return { type: 'DictExpr', keys: [], values: [] } as DictExpr;
    }

    // Check for **spread
    if (this.match(TokenType.DOUBLESTAR)) {
      const value = this.parseExpression();
      const keys: (ASTNode | null)[] = [null];
      const values: ASTNode[] = [value];

      while (this.match(TokenType.COMMA) && !this.check(TokenType.RBRACE)) {
        if (this.match(TokenType.DOUBLESTAR)) {
          keys.push(null);
          values.push(this.parseExpression());
        } else {
          const key = this.parseExpression();
          this.expect(TokenType.COLON);
          keys.push(key);
          values.push(this.parseExpression());
        }
      }

      this.expect(TokenType.RBRACE);
      return { type: 'DictExpr', keys, values } as DictExpr;
    }

    const first = this.parseExpression();

    // Dict (key: value)
    if (this.match(TokenType.COLON)) {
      const firstValue = this.parseExpression();

      // Dict comprehension
      if (this.checkKeyword('for')) {
        const generators = this.parseComprehensionGenerators();
        this.expect(TokenType.RBRACE);
        return { type: 'DictComp', key: first, value: firstValue, generators } as DictComp;
      }

      // Regular dict
      const keys: (ASTNode | null)[] = [first];
      const values: ASTNode[] = [firstValue];

      while (this.match(TokenType.COMMA) && !this.check(TokenType.RBRACE)) {
        if (this.match(TokenType.DOUBLESTAR)) {
          keys.push(null);
          values.push(this.parseExpression());
        } else {
          keys.push(this.parseExpression());
          this.expect(TokenType.COLON);
          values.push(this.parseExpression());
        }
      }

      this.expect(TokenType.RBRACE);
      return { type: 'DictExpr', keys, values } as DictExpr;
    }

    // Set comprehension
    if (this.checkKeyword('for')) {
      const generators = this.parseComprehensionGenerators();
      this.expect(TokenType.RBRACE);
      return { type: 'SetComp', element: first, generators } as SetComp;
    }

    // Regular set
    const elements: ASTNode[] = [first];

    while (this.match(TokenType.COMMA) && !this.check(TokenType.RBRACE)) {
      elements.push(this.parseExpression());
    }

    this.expect(TokenType.RBRACE);
    return { type: 'SetExpr', elements } as SetExpr;
  }

  private parseComprehensionGenerators(): ComprehensionGenerator[] {
    const generators: ComprehensionGenerator[] = [];

    while (this.checkKeyword('for')) {
      this.advance();
      const target = this.parseTargets();
      this.expectKeyword('in');
      const iter = this.parseOr();

      const ifs: ASTNode[] = [];
      while (this.checkKeyword('if')) {
        this.advance();
        ifs.push(this.parseOr());
      }

      generators.push({ target, iter, ifs, isAsync: false });
    }

    return generators;
  }

  private parseTargets(): ASTNode {
    const first = this.parsePrimary();

    if (this.match(TokenType.COMMA)) {
      const elements: ASTNode[] = [first];
      do {
        if (this.checkKeyword('in')) break;
        elements.push(this.parsePrimary());
      } while (this.match(TokenType.COMMA));
      return { type: 'TupleExpr', elements } as TupleExpr;
    }

    return first;
  }

  private parseLambda(): Lambda {
    this.advance(); // 'lambda'
    const params = this.parseLambdaParams();
    this.expect(TokenType.COLON);
    const body = this.parseExpression();
    return { type: 'Lambda', params, body };
  }

  private parseLambdaParams(): FunctionParam[] {
    const params: FunctionParam[] = [];

    if (this.check(TokenType.COLON)) return params;

    do {
      if (this.match(TokenType.STAR)) {
        if (this.check(TokenType.IDENTIFIER)) {
          const name = this.advance().value as string;
          params.push({ name, isArgs: true });
        }
      } else if (this.match(TokenType.DOUBLESTAR)) {
        const name = this.expect(TokenType.IDENTIFIER).value as string;
        params.push({ name, isKwargs: true });
      } else {
        const name = this.expect(TokenType.IDENTIFIER).value as string;
        let defaultVal: any;

        if (this.match(TokenType.ASSIGN)) {
          defaultVal = this.parseExpression();
        }

        params.push({ name, default: defaultVal });
      }
    } while (this.match(TokenType.COMMA) && !this.check(TokenType.COLON));

    return params;
  }

  private parseYield(): YieldExpr {
    this.advance(); // 'yield'

    let isFrom = false;
    let value: ASTNode | null = null;

    if (this.checkKeyword('from')) {
      this.advance();
      isFrom = true;
      value = this.parseExpression();
    } else if (!this.check(TokenType.NEWLINE) && !this.check(TokenType.RPAREN)) {
      value = this.parseExpression();
    }

    return { type: 'YieldExpr', value, isFrom };
  }

  // === Compound Statements ===

  private parseIf(): IfStatement {
    this.advance(); // 'if'
    const test = this.parseExpression();
    this.expect(TokenType.COLON);
    const body = this.parseBlock();

    const elifs: { test: ASTNode; body: ASTNode[] }[] = [];
    let orelse: ASTNode[] = [];

    while (this.checkKeyword('elif')) {
      this.advance();
      const elifTest = this.parseExpression();
      this.expect(TokenType.COLON);
      const elifBody = this.parseBlock();
      elifs.push({ test: elifTest, body: elifBody });
    }

    if (this.checkKeyword('else')) {
      this.advance();
      this.expect(TokenType.COLON);
      orelse = this.parseBlock();
    }

    return { type: 'IfStatement', test, body, elifs, orelse };
  }

  private parseWhile(): WhileStatement {
    this.advance(); // 'while'
    const test = this.parseExpression();
    this.expect(TokenType.COLON);
    const body = this.parseBlock();

    let orelse: ASTNode[] = [];
    if (this.checkKeyword('else')) {
      this.advance();
      this.expect(TokenType.COLON);
      orelse = this.parseBlock();
    }

    return { type: 'WhileStatement', test, body, orelse };
  }

  private parseFor(): ForStatement {
    this.advance(); // 'for'
    const target = this.parseTargets();
    this.expectKeyword('in');
    const iter = this.parseExpression();
    this.expect(TokenType.COLON);
    const body = this.parseBlock();

    let orelse: ASTNode[] = [];
    if (this.checkKeyword('else')) {
      this.advance();
      this.expect(TokenType.COLON);
      orelse = this.parseBlock();
    }

    return { type: 'ForStatement', target, iter, body, orelse };
  }

  private parseFunctionDef(decorators: ASTNode[] = []): FunctionDef {
    this.advance(); // 'def'
    const name = this.expect(TokenType.IDENTIFIER).value as string;
    this.expect(TokenType.LPAREN);
    const params = this.parseFunctionParams();
    this.expect(TokenType.RPAREN);

    let returns: ASTNode | undefined;
    if (this.match(TokenType.ARROW)) {
      returns = this.parseExpression();
    }

    this.expect(TokenType.COLON);
    const body = this.parseBlock();

    return { type: 'FunctionDef', name, params, body, decorators, returns };
  }

  private parseFunctionParams(): FunctionParam[] {
    const params: FunctionParam[] = [];

    if (this.check(TokenType.RPAREN)) return params;

    do {
      if (this.match(TokenType.STAR)) {
        if (this.check(TokenType.IDENTIFIER)) {
          const name = this.advance().value as string;
          params.push({ name, isArgs: true });
        } else {
          // Bare * for keyword-only args
          params.push({ name: '*', isArgs: true });
        }
      } else if (this.match(TokenType.DOUBLESTAR)) {
        const name = this.expect(TokenType.IDENTIFIER).value as string;
        params.push({ name, isKwargs: true });
      } else {
        const name = this.expect(TokenType.IDENTIFIER).value as string;
        let defaultVal: any;

        // Type annotation
        if (this.match(TokenType.COLON)) {
          this.parseExpression(); // Skip annotation for now
        }

        if (this.match(TokenType.ASSIGN)) {
          defaultVal = this.parseExpression();
        }

        params.push({ name, default: defaultVal });
      }
    } while (this.match(TokenType.COMMA) && !this.check(TokenType.RPAREN));

    return params;
  }

  private parseClassDef(decorators: ASTNode[] = []): ClassDef {
    this.advance(); // 'class'
    const name = this.expect(TokenType.IDENTIFIER).value as string;

    const bases: ASTNode[] = [];
    if (this.match(TokenType.LPAREN)) {
      if (!this.check(TokenType.RPAREN)) {
        do {
          bases.push(this.parseExpression());
        } while (this.match(TokenType.COMMA) && !this.check(TokenType.RPAREN));
      }
      this.expect(TokenType.RPAREN);
    }

    this.expect(TokenType.COLON);
    const body = this.parseBlock();

    return { type: 'ClassDef', name, bases, body, decorators };
  }

  private parseTry(): TryExcept {
    this.advance(); // 'try'
    this.expect(TokenType.COLON);
    const body = this.parseBlock();

    const handlers: ExceptHandler[] = [];
    let orelse: ASTNode[] = [];
    let finalbody: ASTNode[] = [];

    while (this.checkKeyword('except')) {
      this.advance();

      let exceptionType: ASTNode | null = null;
      let exceptionName: string | null = null;

      if (!this.check(TokenType.COLON)) {
        exceptionType = this.parseExpression();

        if (this.checkKeyword('as')) {
          this.advance();
          exceptionName = this.expect(TokenType.IDENTIFIER).value as string;
        }
      }

      this.expect(TokenType.COLON);
      const handlerBody = this.parseBlock();

      handlers.push({
        type: 'ExceptHandler',
        exceptionType,
        name: exceptionName,
        body: handlerBody
      });
    }

    if (this.checkKeyword('else')) {
      this.advance();
      this.expect(TokenType.COLON);
      orelse = this.parseBlock();
    }

    if (this.checkKeyword('finally')) {
      this.advance();
      this.expect(TokenType.COLON);
      finalbody = this.parseBlock();
    }

    return { type: 'TryExcept', body, handlers, orelse, finalbody };
  }

  private parseWith(): WithStatement {
    this.advance(); // 'with'

    const items: { context: ASTNode; optional_vars: ASTNode | null }[] = [];

    do {
      const context = this.parseExpression();
      let optional_vars: ASTNode | null = null;

      if (this.checkKeyword('as')) {
        this.advance();
        optional_vars = this.parseTargets();
      }

      items.push({ context, optional_vars });
    } while (this.match(TokenType.COMMA));

    this.expect(TokenType.COLON);
    const body = this.parseBlock();

    return { type: 'WithStatement', items, body };
  }

  private parseDecorated(): ASTNode {
    const decorators: ASTNode[] = [];

    while (this.match(TokenType.AT)) {
      decorators.push(this.parseExpression());
      this.consumeNewline();
      this.skipNewlines();
    }

    if (this.checkKeyword('def')) {
      return this.parseFunctionDef(decorators);
    } else if (this.checkKeyword('class')) {
      return this.parseClassDef(decorators);
    }

    throw this.error('Expected function or class definition after decorator');
  }

  // === Simple Statements ===

  private parseReturn(): Return {
    this.advance(); // 'return'

    let value: ASTNode | null = null;
    if (!this.check(TokenType.NEWLINE) && !this.isAtEnd()) {
      value = this.parseExpression();
    }

    this.consumeNewline();
    return { type: 'Return', value };
  }

  private parseBreak(): Break {
    this.advance(); // 'break'
    this.consumeNewline();
    return { type: 'Break' };
  }

  private parseContinue(): Continue {
    this.advance(); // 'continue'
    this.consumeNewline();
    return { type: 'Continue' };
  }

  private parsePass(): Pass {
    this.advance(); // 'pass'
    this.consumeNewline();
    return { type: 'Pass' };
  }

  private parseImport(): Import {
    this.advance(); // 'import'

    const names: { name: string; alias?: string }[] = [];

    do {
      let name = this.expect(TokenType.IDENTIFIER).value as string;

      // Handle dotted names
      while (this.match(TokenType.DOT)) {
        name += '.' + this.expect(TokenType.IDENTIFIER).value;
      }

      let alias: string | undefined;
      if (this.checkKeyword('as')) {
        this.advance();
        alias = this.expect(TokenType.IDENTIFIER).value as string;
      }

      names.push({ name, alias });
    } while (this.match(TokenType.COMMA));

    this.consumeNewline();
    return { type: 'Import', names };
  }

  private parseFromImport(): ImportFrom {
    this.advance(); // 'from'

    let module = '';
    while (this.match(TokenType.DOT)) {
      module += '.';
    }

    if (this.check(TokenType.IDENTIFIER)) {
      module += this.advance().value;
      while (this.match(TokenType.DOT)) {
        module += '.' + this.expect(TokenType.IDENTIFIER).value;
      }
    }

    this.expectKeyword('import');

    const names: { name: string; alias?: string }[] = [];

    if (this.match(TokenType.STAR)) {
      names.push({ name: '*' });
    } else {
      const hasParen = this.match(TokenType.LPAREN);

      do {
        const name = this.expect(TokenType.IDENTIFIER).value as string;
        let alias: string | undefined;

        if (this.checkKeyword('as')) {
          this.advance();
          alias = this.expect(TokenType.IDENTIFIER).value as string;
        }

        names.push({ name, alias });
      } while (this.match(TokenType.COMMA) && !this.check(TokenType.RPAREN));

      if (hasParen) {
        this.expect(TokenType.RPAREN);
      }
    }

    this.consumeNewline();
    return { type: 'ImportFrom', module, names };
  }

  private parseRaise(): Raise {
    this.advance(); // 'raise'

    let exception: ASTNode | null = null;
    let cause: ASTNode | null = null;

    if (!this.check(TokenType.NEWLINE) && !this.isAtEnd()) {
      exception = this.parseExpression();

      if (this.checkKeyword('from')) {
        this.advance();
        cause = this.parseExpression();
      }
    }

    this.consumeNewline();
    return { type: 'Raise', exception, cause };
  }

  private parseAssert(): Assert {
    this.advance(); // 'assert'
    const test = this.parseExpression();

    let msg: ASTNode | null = null;
    if (this.match(TokenType.COMMA)) {
      msg = this.parseExpression();
    }

    this.consumeNewline();
    return { type: 'Assert', test, msg };
  }

  private parseDelete(): Delete {
    this.advance(); // 'del'

    const targets: ASTNode[] = [];
    do {
      targets.push(this.parseExpression());
    } while (this.match(TokenType.COMMA));

    this.consumeNewline();
    return { type: 'Delete', targets };
  }

  private parseGlobal(): Global {
    this.advance(); // 'global'

    const names: string[] = [];
    do {
      names.push(this.expect(TokenType.IDENTIFIER).value as string);
    } while (this.match(TokenType.COMMA));

    this.consumeNewline();
    return { type: 'Global', names };
  }

  private parseNonlocal(): Nonlocal {
    this.advance(); // 'nonlocal'

    const names: string[] = [];
    do {
      names.push(this.expect(TokenType.IDENTIFIER).value as string);
    } while (this.match(TokenType.COMMA));

    this.consumeNewline();
    return { type: 'Nonlocal', names };
  }

  private parseBlock(): ASTNode[] {
    this.consumeNewline();
    this.expect(TokenType.INDENT);

    const statements: ASTNode[] = [];

    while (!this.check(TokenType.DEDENT) && !this.isAtEnd()) {
      this.skipNewlines();
      if (this.check(TokenType.DEDENT)) break;
      statements.push(this.parseStatement());
    }

    if (this.check(TokenType.DEDENT)) {
      this.advance();
    }

    return statements;
  }

  // === Helper Methods ===

  private isAtEnd(): boolean {
    return this.peek().type === TokenType.EOF;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private peekNext(): Token | null {
    if (this.pos + 1 >= this.tokens.length) return null;
    return this.tokens[this.pos + 1];
  }

  private advance(): Token {
    if (!this.isAtEnd()) this.pos++;
    return this.tokens[this.pos - 1];
  }

  private check(type: TokenType): boolean {
    return this.peek().type === type;
  }

  private checkKeyword(keyword: string): boolean {
    return this.check(TokenType.KEYWORD) && this.peek().value === keyword;
  }

  private match(type: TokenType): boolean {
    if (this.check(type)) {
      this.advance();
      return true;
    }
    return false;
  }

  private expect(type: TokenType): Token {
    if (this.check(type)) {
      return this.advance();
    }
    throw this.error(`Expected ${type}, got ${this.peek().type}`);
  }

  private expectKeyword(keyword: string): void {
    if (!this.checkKeyword(keyword)) {
      throw this.error(`Expected '${keyword}'`);
    }
    this.advance();
  }

  private checkAugAssign(): boolean {
    const type = this.peek().type;
    return [
      TokenType.PLUSEQ, TokenType.MINUSEQ, TokenType.STAREQ,
      TokenType.SLASHEQ, TokenType.DOUBLESLASHEQ, TokenType.PERCENTEQ,
      TokenType.DOUBLESTAREQ, TokenType.AMPEQ, TokenType.PIPEEQ,
      TokenType.CARETEQ, TokenType.RSHIFTEQ, TokenType.LSHIFTEQ
    ].includes(type);
  }

  private consumeNewline(): void {
    if (this.check(TokenType.NEWLINE)) {
      this.advance();
    }
  }

  private skipNewlines(): void {
    while (this.check(TokenType.NEWLINE)) {
      this.advance();
    }
  }

  private error(message: string): SyntaxError {
    const token = this.peek();
    return new SyntaxError(message, token.line, token.column);
  }
}

// Convenience function
export function parse(tokens: Token[]): ASTNode[] {
  const parser = new Parser(tokens);
  return parser.parse();
}
