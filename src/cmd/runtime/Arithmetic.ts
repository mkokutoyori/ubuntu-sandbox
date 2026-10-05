export interface ArithmeticVariables {
  get(name: string): string | undefined;
  set(name: string, value: string): void;
}

export class ArithmeticError extends Error {}

type Token =
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'name'; readonly name: string }
  | { readonly kind: 'operator'; readonly text: string };

const ASSIGNMENT_OPERATORS = ['<<=', '>>=', '*=', '/=', '%=', '+=', '-=', '&=', '^=', '|=', '='];
const MULTI_CHARACTER_OPERATORS = ['<<=', '>>=', '<<', '>>', '*=', '/=', '%=', '+=', '-=', '&=', '^=', '|='];
const INVALID_NUMBER = 'Invalid number.  Numeric constants are either decimal (17), hexadecimal (0x11), or octal (021).';
const toInt32 = (value: number): number => value | 0;

function parseNumber(text: string): number {
  if (/^0x[0-9a-f]+$/i.test(text)) return toInt32(Number.parseInt(text.slice(2), 16));
  if (/^0[0-7]+$/.test(text)) return toInt32(Number.parseInt(text, 8));
  if (/^\d+$/.test(text) && !(text.length > 1 && text.startsWith('0'))) return toInt32(Number.parseInt(text, 10));
  throw new ArithmeticError(INVALID_NUMBER);
}

function tokenize(expression: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < expression.length) {
    const character = expression[index];
    if (/\s/.test(character)) { index++; continue; }
    const number = /^(0x[0-9a-f]+|\d+)/i.exec(expression.slice(index));
    if (number) {
      tokens.push({ kind: 'number', value: parseNumber(number[0]) });
      index += number[0].length;
      continue;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(expression.slice(index));
    if (name) {
      tokens.push({ kind: 'name', name: name[0] });
      index += name[0].length;
      continue;
    }
    const multi = MULTI_CHARACTER_OPERATORS.find(operator => expression.startsWith(operator, index));
    if (multi) { tokens.push({ kind: 'operator', text: multi }); index += multi.length; continue; }
    if ('+-*/%&|^~!()=,<>'.includes(character)) { tokens.push({ kind: 'operator', text: character }); index++; continue; }
    throw new ArithmeticError('Missing operator.');
  }
  return tokens;
}

class Evaluator {
  private position = 0;

  constructor(private readonly tokens: Token[], private readonly variables: ArithmeticVariables) {}

  run(): number {
    if (this.tokens.length === 0) throw new ArithmeticError('Missing operand.');
    let value = this.assignment();
    while (this.acceptOperator(',')) value = this.assignment();
    if (this.position < this.tokens.length) throw new ArithmeticError('Missing operator.');
    return value;
  }

  private peek(): Token | undefined { return this.tokens[this.position]; }

  private acceptOperator(text: string): boolean {
    const token = this.peek();
    if (token?.kind === 'operator' && token.text === text) { this.position++; return true; }
    return false;
  }

  private readVariable(name: string): number {
    const raw = this.variables.get(name);
    if (raw === undefined) return 0;
    const parsed = /^\s*(-?)(0x[0-9a-f]+|\d+)\s*$/i.exec(raw);
    if (!parsed) return 0;
    const magnitude = parseNumber(parsed[2]);
    return parsed[1] === '-' ? toInt32(-magnitude) : magnitude;
  }

  private assignment(): number {
    const token = this.peek();
    const next = this.tokens[this.position + 1];
    if (token?.kind === 'name' && next?.kind === 'operator' && ASSIGNMENT_OPERATORS.includes(next.text)) {
      this.position += 2;
      const right = this.assignment();
      const left = next.text === '=' ? 0 : this.readVariable(token.name);
      const value = next.text === '=' ? right : this.binary(next.text.slice(0, -1), left, right);
      this.variables.set(token.name, String(value));
      return value;
    }
    return this.bitwiseOr();
  }

  private binary(operator: string, left: number, right: number): number {
    switch (operator) {
      case '*': return toInt32(Math.imul(left, right));
      case '/':
        if (right === 0) throw new ArithmeticError('Divide by zero error.');
        return toInt32(Math.trunc(left / right));
      case '%':
        if (right === 0) throw new ArithmeticError('Divide by zero error.');
        return toInt32(left % right);
      case '+': return toInt32(left + right);
      case '-': return toInt32(left - right);
      case '<<': return toInt32(left << (right & 31));
      case '>>': return toInt32(left >> (right & 31));
      case '&': return toInt32(left & right);
      case '^': return toInt32(left ^ right);
      case '|': return toInt32(left | right);
      default: throw new ArithmeticError('Missing operator.');
    }
  }

  private level(operators: readonly string[], inner: () => number): number {
    let value = inner();
    for (;;) {
      const token = this.peek();
      if (token?.kind !== 'operator' || !operators.includes(token.text)) return value;
      const following = this.tokens[this.position + 1];
      if (following?.kind === 'operator' && following.text === '=' && token.text !== '=') return value;
      this.position++;
      value = this.binary(token.text, value, inner());
    }
  }

  private bitwiseOr(): number { return this.level(['|'], () => this.bitwiseXor()); }

  private bitwiseXor(): number { return this.level(['^'], () => this.bitwiseAnd()); }

  private bitwiseAnd(): number { return this.level(['&'], () => this.shift()); }

  private shift(): number { return this.level(['<<', '>>'], () => this.additive()); }

  private additive(): number { return this.level(['+', '-'], () => this.multiplicative()); }

  private multiplicative(): number { return this.level(['*', '/', '%'], () => this.unary()); }

  private unary(): number {
    if (this.acceptOperator('-')) return toInt32(-this.unary());
    if (this.acceptOperator('+')) return this.unary();
    if (this.acceptOperator('!')) return this.unary() === 0 ? 1 : 0;
    if (this.acceptOperator('~')) return toInt32(~this.unary());
    return this.primary();
  }

  private primary(): number {
    const token = this.peek();
    if (token === undefined) throw new ArithmeticError('Missing operand.');
    if (token.kind === 'number') { this.position++; return token.value; }
    if (token.kind === 'name') { this.position++; return this.readVariable(token.name); }
    if (token.text === '(') {
      this.position++;
      const value = this.assignment();
      if (!this.acceptOperator(')')) throw new ArithmeticError('Missing operator.');
      return value;
    }
    throw new ArithmeticError('Missing operand.');
  }
}

export function evaluateArithmetic(expression: string, variables: ArithmeticVariables): number {
  return new Evaluator(tokenize(expression), variables).run();
}
