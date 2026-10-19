import { describeProperty } from '../Properties';
import type { BinaryOperator, ConfigObject, Expr, Location, Stmt } from './Ast';
import { NvList } from './Ast';
import { ConfigScanner, type Diagnostic, type ObjectType, type Token, type TokenType } from './Lexer';

export interface ConfigSink {
  object(object: ConfigObject): void;
  script(statements: Stmt[]): void;
  cfsysline(line: string): void;
  legacyRuleset(line: string): void;
  bsdTag(line: string): void;
  bsdHost(line: string): void;
  includeConfig(path: string): void;
  include(params: NvList): void;
  newAction(params: NvList, location: Location): Stmt;
  newLegacyAction(line: string, location: Location): Stmt;
  newPriorityFilter(text: string, then: Stmt[], location: Location): Stmt;
  newPropertyFilter(text: string, then: Stmt[], location: Location): Stmt;
  newCall(name: string): Stmt;
  checkFunction(name: string, argumentCount: number, location: Location): void;
  report(diagnostic: Diagnostic): void;
}

class SyntaxFailure extends Error {}

const PRECEDENCE: Readonly<Partial<Record<TokenType | string, number>>> = {
  AND: 1, OR: 1,
  CMP_EQ: 2, CMP_NE: 2, CMP_LE: 2, CMP_GE: 2, CMP_LT: 2, CMP_GT: 2, CMP_CONTAINS: 2, CMP_CONTAINSI: 2,
  CMP_STARTSWITH: 2, CMP_STARTSWITHI: 2, CMP_ENDSWITH: 2,
  '+': 3, '-': 3, '&': 3,
  '*': 4, '/': 4, '%': 4,
};

export class ConfigParser {
  private lookahead: Token | null = null;
  private lastText = '';

  constructor(private readonly scanner: ConfigScanner, private readonly sink: ConfigSink) {}

  private fetch(): Token {
    for (;;) {
      const token = this.scanner.next();
      this.lastText = token.text;
      if (token.type === 'CFSYSLINE') {
        this.sink.cfsysline(token.text);
        continue;
      }
      if (token.type === 'INCLUDECONFIG') {
        this.sink.includeConfig(String(token.value));
        continue;
      }
      return token;
    }
  }

  private peek(): Token {
    if (this.lookahead === null) this.lookahead = this.fetch();
    return this.lookahead;
  }

  private take(): Token {
    const token = this.peek();
    this.lookahead = null;
    return token;
  }

  private location(token?: Token): Location {
    const reference = token ?? this.lookahead;
    return reference === null ? { file: this.scanner.fileName, line: this.scanner.lineNumber } : { file: reference.file, line: reference.line };
  }

  private fail(token: Token): never {
    this.sink.report({
      severity: 'error',
      file: token.file,
      line: token.line,
      message: `syntax error on token '${token.type === 'EOF' ? this.lastText : token.text}'`,
    });
    throw new SyntaxFailure();
  }

  private isChar(character: string): boolean {
    const token = this.peek();
    return token.type === 'CHAR' && token.text === character;
  }

  private expectChar(character: string): Token {
    const token = this.peek();
    if (token.type !== 'CHAR' || token.text !== character) this.fail(token);
    return this.take();
  }

  private expect(type: TokenType): Token {
    const token = this.peek();
    if (token.type !== type) this.fail(token);
    return this.take();
  }

  parse(): boolean {
    try {
      for (;;) {
        const token = this.peek();
        switch (token.type) {
          case 'EOF': return true;
          case 'LEGACY_RULESET': this.take(); this.sink.legacyRuleset(token.text); break;
          case 'BSD_TAG_SELECTOR': this.take(); this.sink.bsdTag(token.text); break;
          case 'BSD_HOST_SELECTOR': this.take(); this.sink.bsdHost(token.text); break;
          case 'BEGINOBJ':
          case 'BEGIN_TPL':
          case 'BEGIN_RULESET':
            this.parseObject();
            break;
          default: {
            const statements = this.parseStatement();
            if (statements.length > 0) this.sink.script(statements);
          }
        }
      }
    } catch (error) {
      if (error instanceof SyntaxFailure) return false;
      throw error;
    }
  }

  private parseNameValueList(): NvList {
    const list = new NvList();
    while (this.peek().type === 'NAME') {
      const name = String(this.take().value);
      this.expectChar('=');
      const token = this.peek();
      if (token.type === 'STRING') {
        this.take();
        list.add(name, String(token.value));
      } else if (this.isChar('[')) {
        list.add(name, this.parseArray());
      } else this.fail(token);
    }
    return list;
  }

  private parseArray(): string[] {
    this.expectChar('[');
    const values: string[] = [String(this.expect('STRING').value)];
    while (this.isChar(',')) {
      this.take();
      values.push(String(this.expect('STRING').value));
    }
    this.expectChar(']');
    return values;
  }

  private parseObject(): void {
    const begin = this.take();
    const location = this.location(begin);
    const params = this.parseNameValueList();
    this.expect('ENDOBJ');
    const objectType: ObjectType = begin.type === 'BEGIN_TPL' ? 'template' : begin.type === 'BEGIN_RULESET' ? 'ruleset' : (begin.objectType as ObjectType);
    const object: ConfigObject = { type: objectType, params, location };
    if (begin.type === 'BEGIN_TPL' && this.isChar('{')) {
      this.take();
      object.subObjects = [];
      while (!this.isChar('}')) {
        const entry = this.take();
        if (entry.type !== 'BEGIN_PROPERTY' && entry.type !== 'BEGIN_CONSTANT') this.fail(entry);
        const entryParams = this.parseNameValueList();
        this.expect('ENDOBJ');
        object.subObjects.push({ type: entry.type === 'BEGIN_PROPERTY' ? 'property' : 'constant', params: entryParams, location: this.location(entry) });
      }
      this.take();
    } else if (begin.type === 'BEGIN_RULESET') {
      this.expectChar('{');
      if (this.isChar('}')) {
        this.take();
        object.script = null;
      } else {
        object.script = this.parseScript();
        this.expectChar('}');
      }
    }
    this.sink.object(object);
  }

  private parseScript(): Stmt[] {
    const statements: Stmt[] = [];
    for (;;) {
      statements.push(...this.parseStatement());
      if (this.isChar('}') || this.peek().type === 'EOF') return statements;
    }
  }

  private parseBlock(): Stmt[] {
    if (this.isChar('{')) {
      this.take();
      const script = this.parseScript();
      this.expectChar('}');
      return script;
    }
    return this.parseStatement();
  }

  private parseActionList(first: Stmt): Stmt[] {
    const list = [first];
    while (this.isChar('&')) {
      this.take();
      list.push(this.parseSimpleAction());
    }
    return list;
  }

  private parseSimpleAction(): Stmt {
    const token = this.take();
    const location = this.location(token);
    switch (token.type) {
      case 'BEGIN_ACTION': {
        const params = this.parseNameValueList();
        this.expect('ENDOBJ');
        return this.sink.newAction(params, location);
      }
      case 'LEGACY_ACTION': return this.sink.newLegacyAction(token.text, location);
      case 'STOP': return { k: 'stop' };
      case 'CALL': return this.sink.newCall(String(this.expect('NAME').value));
      case 'CALL_INDIRECT': {
        const expr = this.parseExpression();
        this.expectChar(';');
        return { k: 'callIndirect', expr };
      }
      case 'CONTINUE': return { k: 'nop', printable: 'continue' };
      default: return this.fail(token);
    }
  }

  private parseStatement(): Stmt[] {
    const token = this.peek();
    switch (token.type) {
      case 'BEGIN_ACTION':
      case 'LEGACY_ACTION':
      case 'STOP':
      case 'CALL':
      case 'CALL_INDIRECT':
      case 'CONTINUE': {
        return this.parseActionList(this.parseSimpleAction());
      }
      case 'IF': return [this.parseIf()];
      case 'FOREACH': {
        this.take();
        this.expectChar('(');
        const variable = this.expect('VAR');
        this.expect('ITERATOR_ASSIGNMENT');
        const collection = this.parseExpression();
        this.expectChar(')');
        this.expect('DO');
        return [{ k: 'foreach', variable: String(variable.value), collection, body: this.parseBlock() }];
      }
      case 'SET':
      case 'RESET': {
        this.take();
        const variable = this.expect('VAR');
        this.expectChar('=');
        const expr = this.parseExpression();
        this.expectChar(';');
        return [this.checkedVariable(variable, { k: 'set', variable: String(variable.value), expr, reset: token.type === 'RESET' }, 'set')];
      }
      case 'UNSET': {
        this.take();
        const variable = this.expect('VAR');
        this.expectChar(';');
        return [this.checkedVariable(variable, { k: 'unset', variable: String(variable.value) }, 'unset')];
      }
      case 'PRIFILT': {
        this.take();
        const then = this.parseBlock();
        return [this.sink.newPriorityFilter(token.text, then, this.location(token))];
      }
      case 'PROPFILT': {
        this.take();
        const then = this.parseBlock();
        return [this.sink.newPropertyFilter(token.text, then, this.location(token))];
      }
      case 'RELOAD_LOOKUP_TABLE': {
        this.take();
        this.expectChar('(');
        const args = this.parseArguments();
        this.expectChar(')');
        return [{ k: 'reloadLookupTable', args }];
      }
      case 'BEGIN_INCLUDE': {
        this.take();
        const params = this.parseNameValueList();
        this.expect('ENDOBJ');
        this.sink.include(params);
        return [];
      }
      case 'BEGINOBJ':
        this.sink.report({
          severity: 'error', file: token.file, line: token.line,
          message: `declarative object '${token.text}' not permitted in action block [stmt]`,
        });
        this.take();
        return [];
      default: return this.fail(token);
    }
  }

  private checkedVariable(token: Token, statement: Stmt, keyword: string): Stmt {
    const descriptor = describeProperty(String(token.value));
    if (descriptor.id !== 'cee' && descriptor.id !== 'local-var' && descriptor.id !== 'global-var') {
      this.sink.report({ severity: 'error', file: token.file, line: token.line, message: `invalid variable '${String(token.value)}' in ${keyword} statement.` });
      return { k: 'nop' };
    }
    return statement;
  }

  private parseIf(): Stmt {
    this.take();
    const expr = this.parseExpression();
    this.expect('THEN');
    const then = this.parseBlock();
    return { k: 'if', expr, then, else: this.parseElseTail() };
  }

  private parseElseTail(): Stmt[] | null {
    const token = this.peek();
    if (token.type === 'ELSE') {
      this.take();
      return this.parseBlock();
    }
    if (token.type === 'ELSEIF') {
      this.take();
      const expr = this.parseExpression();
      this.expect('THEN');
      const then = this.parseBlock();
      return [{ k: 'if', expr, then, else: this.parseElseTail() }];
    }
    return null;
  }

  private parseArguments(): Expr[] {
    if (this.isChar(')')) return [];
    const args = [this.parseExpression()];
    while (this.isChar(',')) {
      this.take();
      args.push(this.parseExpression());
    }
    return args;
  }

  private operatorOf(token: Token): BinaryOperator | null {
    switch (token.type) {
      case 'AND': case 'OR': case 'CMP_EQ': case 'CMP_NE': case 'CMP_LE': case 'CMP_GE': case 'CMP_LT': case 'CMP_GT':
      case 'CMP_CONTAINS': case 'CMP_CONTAINSI': case 'CMP_STARTSWITH': case 'CMP_STARTSWITHI': case 'CMP_ENDSWITH':
        return token.type;
      case 'CHAR':
        return ['+', '-', '&', '*', '/', '%'].includes(token.text) ? (token.text as BinaryOperator) : null;
      default: return null;
    }
  }

  parseExpression(minimum = 1): Expr {
    let left = this.parseUnary();
    for (;;) {
      const token = this.peek();
      const operator = this.operatorOf(token);
      if (operator === null) return left;
      const precedence = PRECEDENCE[operator] ?? 0;
      if (precedence < minimum) return left;
      this.take();
      const right = this.parseExpression(precedence + 1);
      left = { k: 'bin', op: operator, l: left, r: right };
    }
  }

  private parseUnary(): Expr {
    const token = this.peek();
    if (token.type === 'NOT') {
      this.take();
      return { k: 'not', r: this.parseUnary() };
    }
    if (token.type === 'CHAR' && token.text === '-') {
      this.take();
      return { k: 'neg', r: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Expr {
    const token = this.take();
    switch (token.type) {
      case 'NUMBER': return { k: 'num', value: Number(token.value) };
      case 'STRING': return { k: 'str', value: String(token.value) };
      case 'VAR': return { k: 'var', name: String(token.value), prop: describeProperty(String(token.value)) };
      case 'EXISTS': {
        this.expectChar('(');
        const variable = this.expect('VAR');
        this.expectChar(')');
        return { k: 'exists', name: String(variable.value), prop: describeProperty(String(variable.value)) };
      }
      case 'FUNC': {
        this.expectChar('(');
        const args = this.parseArguments();
        this.expectChar(')');
        this.sink.checkFunction(String(token.value), args.length, this.location(token));
        return { k: 'func', name: String(token.value), args };
      }
      case 'CHAR':
        if (token.text === '(') {
          const inner = this.parseExpression();
          this.expectChar(')');
          return inner;
        }
        if (token.text === '[') {
          this.lookahead = token;
          return { k: 'arr', values: this.parseArray() };
        }
        return this.fail(token);
      default: return this.fail(token);
    }
  }
}
