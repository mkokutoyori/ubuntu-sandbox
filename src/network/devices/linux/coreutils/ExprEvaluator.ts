import { PosixRegexError, MESSAGES } from '../regex/PosixEre';
import { posixToJsSource } from '../regex/PosixRegex';
import { Streams, docsResult, quoteLocale, type CoreutilsRun } from './CoreutilsKit';

const EXPR_INVALID = 2;

type Value = { readonly kind: 'integer'; readonly number: bigint } | { readonly kind: 'string'; readonly text: string };

class ExprError extends Error {
  constructor(message: string, readonly exitCode: number) {
    super(message);
  }
}

const integerValue = (number: bigint): Value => ({ kind: 'integer', number });
const stringValue = (text: string): Value => ({ kind: 'string', text });
const flagValue = (flag: boolean): Value => integerValue(flag ? 1n : 0n);

function textOf(value: Value): string {
  return value.kind === 'integer' ? value.number.toString() : value.text;
}

function looksLikeInteger(text: string): boolean {
  return /^-?\d+$/.test(text);
}

function isNull(value: Value): boolean {
  if (value.kind === 'integer') return value.number === 0n;
  return /^-?0*$/.test(value.text);
}

function integerOf(value: Value): bigint | null {
  if (value.kind === 'integer') return value.number;
  return looksLikeInteger(value.text) ? BigInt(value.text) : null;
}

function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left);
  const b = Array.from(right);
  const common = Math.min(a.length, b.length);
  for (let index = 0; index < common; index++) {
    const difference = a[index].codePointAt(0)! - b[index].codePointAt(0)!;
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

function compareIntegerText(left: string, right: string): number {
  const a = BigInt(left);
  const b = BigInt(right);
  return a === b ? 0 : a < b ? -1 : 1;
}

function matchPattern(subject: string, pattern: string): Value {
  let source: string;
  try {
    source = posixToJsSource(pattern, { extended: false });
  } catch (error) {
    if (error instanceof PosixRegexError) throw new ExprError(error.message, EXPR_INVALID);
    throw error;
  }
  let expression: RegExp;
  let groups: number;
  try {
    expression = new RegExp(`^(?:${source})`, 'su');
    groups = (new RegExp(`${source}|`, 'su').exec('') ?? []).length - 1;
  } catch {
    throw new ExprError(MESSAGES.pattern, EXPR_INVALID);
  }
  const found = expression.exec(subject);
  if (found === null) return groups > 0 ? stringValue('') : integerValue(0n);
  if (groups > 0) return stringValue(found[1] ?? '');
  return integerValue(BigInt(Array.from(found[0]).length));
}

class Evaluation {
  private position = 0;

  constructor(private readonly args: readonly string[]) {}

  finished(): boolean {
    return this.position >= this.args.length;
  }

  unexpectedArgument(): string {
    return this.args[this.position];
  }

  private nextArgument(token: string): boolean {
    if (this.finished()) return false;
    const same = this.args[this.position] === token;
    if (same) this.position++;
    return same;
  }

  private requireMoreArguments(): void {
    if (this.finished()) {
      throw new ExprError(`syntax error: missing argument after ${quoteLocale(this.args[this.position - 1])}`, EXPR_INVALID);
    }
  }

  evaluate(evaluating: boolean): Value {
    let left = this.conjunction(evaluating);
    while (this.nextArgument('|')) {
      const right = this.conjunction(evaluating && isNull(left));
      if (isNull(left)) left = isNull(right) ? integerValue(0n) : right;
    }
    return left;
  }

  private conjunction(evaluating: boolean): Value {
    let left = this.comparison(evaluating);
    while (this.nextArgument('&')) {
      const right = this.comparison(evaluating && !isNull(left));
      if (isNull(left) || isNull(right)) left = integerValue(0n);
    }
    return left;
  }

  private comparison(evaluating: boolean): Value {
    let left = this.additive(evaluating);
    for (;;) {
      let operator: string;
      if (this.nextArgument('<')) operator = '<';
      else if (this.nextArgument('<=')) operator = '<=';
      else if (this.nextArgument('=') || this.nextArgument('==')) operator = '=';
      else if (this.nextArgument('!=')) operator = '!=';
      else if (this.nextArgument('>=')) operator = '>=';
      else if (this.nextArgument('>')) operator = '>';
      else return left;
      const right = this.additive(evaluating);
      let outcome = false;
      if (evaluating) {
        const a = textOf(left);
        const b = textOf(right);
        const order = looksLikeInteger(a) && looksLikeInteger(b) ? compareIntegerText(a, b) : compareCodePoints(a, b);
        outcome = operator === '<' ? order < 0 : operator === '<=' ? order <= 0 : operator === '=' ? order === 0
          : operator === '!=' ? order !== 0 : operator === '>=' ? order >= 0 : order > 0;
      }
      left = flagValue(outcome);
    }
  }

  private additive(evaluating: boolean): Value {
    let left = this.multiplicative(evaluating);
    for (;;) {
      const plus = this.nextArgument('+');
      if (!plus && !this.nextArgument('-')) return left;
      const right = this.multiplicative(evaluating);
      if (evaluating) {
        const a = integerOf(left);
        const b = integerOf(right);
        if (a === null || b === null) throw new ExprError('non-integer argument', EXPR_INVALID);
        left = integerValue(plus ? a + b : a - b);
      }
    }
  }

  private multiplicative(evaluating: boolean): Value {
    let left = this.matching(evaluating);
    for (;;) {
      const operator = this.nextArgument('*') ? '*' : this.nextArgument('/') ? '/' : this.nextArgument('%') ? '%' : null;
      if (operator === null) return left;
      const right = this.matching(evaluating);
      if (evaluating) {
        const a = integerOf(left);
        const b = integerOf(right);
        if (a === null || b === null) throw new ExprError('non-integer argument', EXPR_INVALID);
        if (operator !== '*' && b === 0n) throw new ExprError('division by zero', EXPR_INVALID);
        left = integerValue(operator === '*' ? a * b : operator === '/' ? a / b : a % b);
      }
    }
  }

  private matching(evaluating: boolean): Value {
    let left = this.keyword(evaluating);
    while (this.nextArgument(':')) {
      const right = this.keyword(evaluating);
      if (evaluating) left = matchPattern(textOf(left), textOf(right));
    }
    return left;
  }

  private keyword(evaluating: boolean): Value {
    if (this.nextArgument('+')) {
      this.requireMoreArguments();
      return stringValue(this.args[this.position++]);
    }
    if (this.nextArgument('length')) {
      return integerValue(BigInt(Array.from(textOf(this.keyword(evaluating))).length));
    }
    if (this.nextArgument('match')) {
      const subject = this.keyword(evaluating);
      const pattern = this.keyword(evaluating);
      return evaluating ? matchPattern(textOf(subject), textOf(pattern)) : subject;
    }
    if (this.nextArgument('index')) {
      const subject = Array.from(textOf(this.keyword(evaluating)));
      const characters = new Set(Array.from(textOf(this.keyword(evaluating))));
      const found = subject.findIndex((character) => characters.has(character));
      return integerValue(BigInt(found + 1));
    }
    if (this.nextArgument('substr')) {
      const subject = Array.from(textOf(this.keyword(evaluating)));
      const start = integerOf(this.keyword(evaluating));
      const length = integerOf(this.keyword(evaluating));
      if (start === null || length === null || start < 1n || length < 1n || start > BigInt(subject.length)) return stringValue('');
      const from = Number(start) - 1;
      const count = length > BigInt(subject.length) ? subject.length : Number(length);
      return stringValue(subject.slice(from, from + count).join(''));
    }
    return this.operand();
  }

  private operand(): Value {
    this.requireMoreArguments();
    if (this.nextArgument('(')) {
      const inner = this.evaluate(true);
      if (this.finished()) {
        throw new ExprError(`syntax error: expecting ')' after ${quoteLocale(this.args[this.position - 1])}`, EXPR_INVALID);
      }
      if (!this.nextArgument(')')) {
        throw new ExprError(`syntax error: expecting ')' instead of ${quoteLocale(this.args[this.position])}`, EXPR_INVALID);
      }
      return inner;
    }
    if (this.nextArgument(')')) throw new ExprError("syntax error: unexpected ')'", EXPR_INVALID);
    return stringValue(this.args[this.position++]);
  }
}

function docsRequest(args: readonly string[]): 'help' | 'version' | null {
  if (args.length !== 1) return null;
  if (/^--h(e(l(p)?)?)?$/.test(args[0])) return 'help';
  if (/^--v(e(r(s(i(o(n)?)?)?)?)?)?$/.test(args[0])) return 'version';
  return null;
}

export function runExpr(args: readonly string[]): CoreutilsRun {
  const request = docsRequest(args);
  if (request !== null) return docsResult('expr', request);
  const operands = args[0] === '--' ? args.slice(1) : args;
  const streams = new Streams();
  if (operands.length === 0) {
    streams.diagnostic('expr: missing operand');
    streams.diagnostic("Try 'expr --help' for more information.");
    streams.exitCode = EXPR_INVALID;
    return streams.result();
  }
  const evaluation = new Evaluation(operands);
  try {
    const value = evaluation.evaluate(true);
    if (!evaluation.finished()) {
      throw new ExprError(`syntax error: unexpected argument ${quoteLocale(evaluation.unexpectedArgument())}`, EXPR_INVALID);
    }
    streams.stdout(`${textOf(value)}\n`);
    streams.exitCode = isNull(value) ? 1 : 0;
  } catch (error) {
    if (!(error instanceof ExprError)) throw error;
    streams.diagnostic(`expr: ${error.message}`);
    streams.exitCode = error.exitCode;
  }
  return streams.result();
}
