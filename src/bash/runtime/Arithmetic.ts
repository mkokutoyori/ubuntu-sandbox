import { ArithmeticError } from '@/bash/errors/BashError';

export interface ArithmeticScope {
  get(name: string): string | undefined;
  set(name: string, value: string): void;
  getArrayElement(name: string, index: number): string | undefined;
  setArrayElement(name: string, index: number, value: string): void;
  isAssoc(name: string): boolean;
  getAssocElement(name: string, key: string): string | undefined;
  setAssocElement(name: string, key: string, value: string): void;
}

const MAX_RECURSION = 1024;
const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ@_';

interface Reference {
  readonly name: string;
  readonly subscript?: string;
}

interface Operand {
  readonly value: bigint;
  readonly reference?: Reference;
}

const ASSIGNMENT_OPERATORS = ['<<=', '>>=', '+=', '-=', '*=', '/=', '%=', '&=', '^=', '|=', '='];

function wrap(value: bigint): bigint {
  return BigInt.asIntN(64, value);
}

function truth(value: boolean): bigint {
  return value ? 1n : 0n;
}

export function evaluateArithmeticExpression(text: string, scope: ArithmeticScope): bigint {
  return new Evaluator(text, scope, 0).evaluate();
}

class Evaluator {
  private position = 0;
  private suppressed = 0;

  constructor(
    private readonly text: string,
    private readonly scope: ArithmeticScope,
    private readonly depth: number,
  ) {}

  evaluate(): bigint {
    this.skipSpace();
    if (this.position >= this.text.length) return 0n;
    const value = this.comma().value;
    this.skipSpace();
    if (this.position < this.text.length) {
      throw this.syntaxError(this.text[this.position] === ')' ? 'unbalanced )' : 'syntax error: operand expected');
    }
    return value;
  }

  private skipSpace(): void {
    while (this.position < this.text.length && /\s/.test(this.text[this.position])) this.position++;
  }

  private syntaxError(message: string, tokenStart = this.position): ArithmeticError {
    return new ArithmeticError(`${this.text.trim()}: ${message} (error token is "${this.text.slice(tokenStart)}")`);
  }

  private startsWith(operator: string): boolean {
    this.skipSpace();
    return this.text.startsWith(operator, this.position);
  }

  private accept(operator: string, notFollowedBy?: RegExp): boolean {
    if (!this.startsWith(operator)) return false;
    const next = this.text[this.position + operator.length];
    if (notFollowedBy !== undefined && next !== undefined && notFollowedBy.test(next)) return false;
    this.position += operator.length;
    return true;
  }

  private comma(): Operand {
    let operand = this.assignment();
    while (this.accept(',')) operand = this.assignment();
    return operand;
  }

  private assignment(): Operand {
    const left = this.conditional();
    this.skipSpace();
    for (const operator of ASSIGNMENT_OPERATORS) {
      if (!this.text.startsWith(operator, this.position)) continue;
      if (operator === '=' && this.text[this.position + 1] === '=') break;
      const tokenStart = this.position;
      if (left.reference === undefined) throw this.syntaxError('attempted assignment to non-variable', tokenStart);
      this.position += operator.length;
      const right = this.assignment().value;
      const current = this.read(left.reference);
      const next = operator === '=' ? right : this.binary(operator.slice(0, -1), current, right, tokenStart);
      this.write(left.reference, wrap(next));
      return { value: wrap(next), reference: left.reference };
    }
    return left;
  }

  private conditional(): Operand {
    const condition = this.logicalOr();
    if (!this.accept('?')) return condition;
    const chosen = condition.value !== 0n;
    const whenTrue = this.unlessSuppressed(!chosen, () => this.assignment());
    if (!this.accept(':')) throw this.syntaxError('expression expected');
    const whenFalse = this.unlessSuppressed(chosen, () => this.conditional());
    return chosen ? whenTrue : whenFalse;
  }

  private unlessSuppressed<T>(suppress: boolean, parse: () => T): T {
    if (suppress) this.suppressed++;
    try { return parse(); } finally { if (suppress) this.suppressed--; }
  }

  private logicalOr(): Operand {
    let left = this.logicalAnd();
    while (this.accept('||')) {
      const right = this.unlessSuppressed(left.value !== 0n, () => this.logicalAnd());
      left = { value: truth(left.value !== 0n || right.value !== 0n) };
    }
    return left;
  }

  private logicalAnd(): Operand {
    let left = this.bitwiseOr();
    while (this.accept('&&')) {
      const right = this.unlessSuppressed(left.value === 0n, () => this.bitwiseOr());
      left = { value: truth(left.value !== 0n && right.value !== 0n) };
    }
    return left;
  }

  private bitwiseOr(): Operand {
    let left = this.bitwiseXor();
    while (this.accept('|', /[|=]/)) left = { value: left.value | this.bitwiseXor().value };
    return left;
  }

  private bitwiseXor(): Operand {
    let left = this.bitwiseAnd();
    while (this.accept('^', /=/)) left = { value: left.value ^ this.bitwiseAnd().value };
    return left;
  }

  private bitwiseAnd(): Operand {
    let left = this.equality();
    while (this.accept('&', /[&=]/)) left = { value: left.value & this.equality().value };
    return left;
  }

  private equality(): Operand {
    let left = this.relational();
    for (;;) {
      if (this.accept('==')) left = { value: truth(left.value === this.relational().value) };
      else if (this.accept('!=')) left = { value: truth(left.value !== this.relational().value) };
      else return left;
    }
  }

  private relational(): Operand {
    let left = this.shift();
    for (;;) {
      if (this.accept('<=')) left = { value: truth(left.value <= this.shift().value) };
      else if (this.accept('>=')) left = { value: truth(left.value >= this.shift().value) };
      else if (this.accept('<', /[<=]/)) left = { value: truth(left.value < this.shift().value) };
      else if (this.accept('>', /[>=]/)) left = { value: truth(left.value > this.shift().value) };
      else return left;
    }
  }

  private shift(): Operand {
    let left = this.additive();
    for (;;) {
      const tokenStart = this.position;
      if (this.accept('<<', /=/)) left = { value: this.binary('<<', left.value, this.additive().value, tokenStart) };
      else if (this.accept('>>', /=/)) left = { value: this.binary('>>', left.value, this.additive().value, tokenStart) };
      else return left;
    }
  }

  private additive(): Operand {
    let left = this.multiplicative();
    for (;;) {
      if (this.accept('+', /[+=]/)) left = { value: wrap(left.value + this.multiplicative().value) };
      else if (this.accept('-', /[-=]/)) left = { value: wrap(left.value - this.multiplicative().value) };
      else return left;
    }
  }

  private multiplicative(): Operand {
    let left = this.power();
    for (;;) {
      this.skipSpace();
      const operator = this.text[this.position];
      const following = this.text[this.position + 1];
      if (!['*', '/', '%'].includes(operator) || following === '=' || (operator === '*' && following === '*')) return left;
      this.position++;
      this.skipSpace();
      const tokenStart = this.position;
      const right = this.power();
      left = { value: this.binary(operator, left.value, right.value, tokenStart) };
    }
  }

  private power(): Operand {
    const base = this.unary();
    if (!this.accept('**')) return base;
    this.skipSpace();
    const tokenStart = this.position;
    const exponent = this.power();
    return { value: this.binary('**', base.value, exponent.value, tokenStart) };
  }

  private binary(operator: string, left: bigint, right: bigint, tokenStart: number): bigint {
    switch (operator) {
      case '+': return wrap(left + right);
      case '-': return wrap(left - right);
      case '*': return wrap(left * right);
      case '/':
      case '%':
        if (right === 0n) {
          if (this.suppressed > 0) return 0n;
          throw this.syntaxError('division by 0', tokenStart);
        }
        return wrap(operator === '/' ? left / right : left % right);
      case '<<': return wrap(left << (right & 63n));
      case '>>': return wrap(left >> (right & 63n));
      case '&': return left & right;
      case '|': return left | right;
      case '^': return left ^ right;
      case '**': {
        if (right < 0n) throw this.syntaxError('exponent less than 0', tokenStart);
        let result = 1n;
        let factor = left;
        let remaining = right;
        while (remaining > 0n) {
          if (remaining & 1n) result = wrap(result * factor);
          factor = wrap(factor * factor);
          remaining >>= 1n;
        }
        return result;
      }
      default: return right;
    }
  }

  private unary(): Operand {
    this.skipSpace();
    if (this.accept('++') || this.accept('--')) {
      const increment = this.text.slice(this.position - 2, this.position) === '++';
      const operand = this.unary();
      if (operand.reference === undefined) throw this.syntaxError('operand expected', this.position - 2);
      const next = wrap(this.read(operand.reference) + (increment ? 1n : -1n));
      this.write(operand.reference, next);
      return { value: next, reference: operand.reference };
    }
    if (this.accept('+')) return { value: this.unary().value };
    if (this.accept('-')) return { value: wrap(-this.unary().value) };
    if (this.accept('!', /=/)) return { value: truth(this.unary().value === 0n) };
    if (this.accept('~')) return { value: ~this.unary().value };
    return this.postfix();
  }

  private postfix(): Operand {
    const operand = this.primary();
    if (operand.reference === undefined) return operand;
    if (this.accept('++')) {
      this.write(operand.reference, wrap(operand.value + 1n));
      return { value: operand.value };
    }
    if (this.accept('--')) {
      this.write(operand.reference, wrap(operand.value - 1n));
      return { value: operand.value };
    }
    return operand;
  }

  private primary(): Operand {
    this.skipSpace();
    const start = this.position;
    if (start >= this.text.length) throw this.syntaxError('syntax error: operand expected');
    const character = this.text[start];
    if (character === '(') {
      this.position++;
      const inner = this.comma();
      if (!this.accept(')')) throw this.syntaxError("missing `)'", this.position);
      return { value: inner.value };
    }
    if (/[0-9]/.test(character)) return { value: this.number() };
    if (/[A-Za-z_]/.test(character)) return this.variable();
    throw this.syntaxError('syntax error: operand expected', start);
  }

  private number(): bigint {
    const start = this.position;
    while (this.position < this.text.length && /[0-9A-Za-z@_#]/.test(this.text[this.position])) this.position++;
    const token = this.text.slice(start, this.position);
    return this.parseNumber(token, start);
  }

  private parseNumber(token: string, start: number): bigint {
    const hash = token.indexOf('#');
    if (hash > 0) {
      const base = Number(token.slice(0, hash));
      if (!/^\d+$/.test(token.slice(0, hash)) || base < 2 || base > 64) throw this.syntaxError('invalid arithmetic base', start);
      return this.digits(token.slice(hash + 1), base, token, start);
    }
    if (/^0[xX]/.test(token)) {
      if (token.length === 2) throw this.syntaxError('invalid number', start);
      return this.digits(token.slice(2), 16, token, start);
    }
    if (token.length > 1 && token[0] === '0') return this.digits(token.slice(1), 8, token, start);
    return this.digits(token, 10, token, start);
  }

  private digits(body: string, base: number, token: string, start: number): bigint {
    if (body === '') throw this.syntaxError('invalid number', start);
    let result = 0n;
    for (const character of body) {
      let digit = DIGITS.indexOf(character);
      if (base <= 36 && digit >= 36) digit -= 26;
      if (digit < 0 || digit >= base) throw this.syntaxError('value too great for base', start);
      result = wrap(result * BigInt(base) + BigInt(digit));
    }
    if (token.length === 0) throw this.syntaxError('invalid number', start);
    return result;
  }

  private variable(): Operand {
    const start = this.position;
    while (this.position < this.text.length && /[A-Za-z0-9_]/.test(this.text[this.position])) this.position++;
    const name = this.text.slice(start, this.position);
    let subscript: string | undefined;
    if (this.text[this.position] === '[') {
      const close = this.matchingBracket(this.position);
      if (close < 0) throw this.syntaxError("bad array subscript", start);
      subscript = this.text.slice(this.position + 1, close);
      this.position = close + 1;
    }
    const reference: Reference = { name, subscript };
    return { value: this.read(reference), reference };
  }

  private matchingBracket(open: number): number {
    let depth = 0;
    for (let index = open; index < this.text.length; index++) {
      if (this.text[index] === '[') depth++;
      else if (this.text[index] === ']' && --depth === 0) return index;
    }
    return -1;
  }

  private read(reference: Reference): bigint {
    return this.evaluateText(this.rawValue(reference));
  }

  private rawValue(reference: Reference): string | undefined {
    const { name, subscript } = reference;
    if (subscript === undefined) return this.scope.get(name);
    if (this.scope.isAssoc(name)) return this.scope.getAssocElement(name, subscript);
    const index = this.index(subscript);
    return this.scope.getArrayElement(name, index) ?? (index === 0 ? this.scope.get(name) : undefined);
  }

  private index(subscript: string): number {
    return Number(this.child(subscript).evaluate());
  }

  private child(text: string): Evaluator {
    if (this.depth >= MAX_RECURSION) throw new ArithmeticError(`${this.text.trim()}: expression recursion level exceeded (error token is "${text}")`);
    return new Evaluator(text, this.scope, this.depth + 1);
  }

  private evaluateText(raw: string | undefined): bigint {
    if (raw === undefined || raw.trim() === '') return 0n;
    return this.child(raw).evaluate();
  }

  private write(reference: Reference, value: bigint): void {
    if (this.suppressed > 0) return;
    const { name, subscript } = reference;
    const text = value.toString();
    if (subscript === undefined) {
      this.scope.set(name, text);
      return;
    }
    if (this.scope.isAssoc(name)) {
      this.scope.setAssocElement(name, subscript, text);
      return;
    }
    this.scope.setArrayElement(name, this.index(subscript), text);
  }
}
