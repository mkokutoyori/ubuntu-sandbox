/**
 * POSIX `expr` evaluator with full operator precedence, regex match,
 * and the GNU string-function set (`length`, `substr`, `index`, `match`).
 *
 * Precedence (lowest → highest), all left-associative:
 *   1. `|`            — first non-empty/non-zero of left or right
 *   2. `&`            — both non-empty/non-zero ? left : 0
 *   3. `= != < <= > >=` — string-or-int comparison
 *   4. `+ -`
 *   5. `* / %`
 *   6. `: REGEX`      — BRE anchored at start; returns capture or length
 *
 * Exit codes mirror coreutils `expr(1)`:
 *   0 → result is non-zero and non-empty
 *   1 → result is zero or the empty string
 *   2 → invalid expression (syntax)
 *   3 → invalid argument or runtime error
 */

import { posixToJsSource } from '../regex/PosixRegex';

export interface ExprResult {
  output: string;
  exitCode: number;
}

interface Value {
  raw: string;
  asInt(): number;
  isTrue(): boolean;
}

const makeStr = (s: string): Value => ({
  raw: s,
  asInt() {
    if (!/^-?\d+$/.test(s)) throw new ExprRuntimeError(`non-integer argument: ${s}`);
    return Number.parseInt(s, 10);
  },
  isTrue() { return s !== '' && s !== '0'; },
});
const makeInt = (n: number): Value => makeStr(String(n));

class ExprSyntaxError extends Error {}
class ExprRuntimeError extends Error {}

/**
 * Recursive-descent parser over the argv. Each operator/operand is one
 * argv token, so there is no lexing step — argv *is* the token stream.
 */
export class ExprEvaluator {
  private tokens: readonly string[] = [];
  private pos = 0;

  /** Evaluate `expr arg1 arg2 …` (argv already split). */
  run(args: readonly string[]): ExprResult {
    if (args.length === 1 && (args[0] === '--help' || args[0] === '--version')) {
      return { output: '', exitCode: 0 };
    }
    if (args.length === 0) {
      return { output: 'expr: syntax error: missing argument', exitCode: 2 };
    }
    this.tokens = args;
    this.pos = 0;
    try {
      const v = this.parseOr();
      if (this.pos !== this.tokens.length) {
        throw new ExprSyntaxError(`unexpected argument: ${this.tokens[this.pos]}`);
      }
      return { output: v.raw, exitCode: v.isTrue() ? 0 : 1 };
    } catch (e) {
      if (e instanceof ExprSyntaxError) return { output: `expr: ${e.message}`, exitCode: 2 };
      if (e instanceof ExprRuntimeError) return { output: `expr: ${e.message}`, exitCode: 3 };
      return { output: 'expr: internal error', exitCode: 3 };
    }
  }

  private parseOr(): Value {
    let v = this.parseAnd();
    while (this.peek() === '|') { this.pos++; const r = this.parseAnd(); if (!v.isTrue()) v = r.isTrue() ? r : makeInt(0); }
    return v;
  }

  private parseAnd(): Value {
    let v = this.parseRel();
    while (this.peek() === '&') { this.pos++; const r = this.parseRel(); v = v.isTrue() && r.isTrue() ? v : makeInt(0); }
    return v;
  }

  private parseRel(): Value {
    let v = this.parseAdd();
    while (this.isRel(this.peek())) {
      const op = this.tokens[this.pos++];
      const r = this.parseAdd();
      v = makeInt(this.cmp(v, op, r) ? 1 : 0);
    }
    return v;
  }

  private parseAdd(): Value {
    let v = this.parseMul();
    while (this.peek() === '+' || this.peek() === '-') {
      const op = this.tokens[this.pos++];
      const r = this.parseMul();
      v = makeInt(op === '+' ? v.asInt() + r.asInt() : v.asInt() - r.asInt());
    }
    return v;
  }

  private parseMul(): Value {
    let v = this.parseMatch();
    while (this.peek() === '*' || this.peek() === '/' || this.peek() === '%') {
      const op = this.tokens[this.pos++];
      const r = this.parseMatch();
      const a = v.asInt(), b = r.asInt();
      if ((op === '/' || op === '%') && b === 0) throw new ExprRuntimeError('division by zero');
      v = makeInt(op === '*' ? a * b : op === '/' ? Math.trunc(a / b) : a - Math.trunc(a / b) * b);
    }
    return v;
  }

  private parseMatch(): Value {
    let v = this.parseAtom();
    while (this.peek() === ':') {
      this.pos++;
      const pat = this.parseAtom().raw;
      v = makeStr(this.matchBre(v.raw, pat));
    }
    return v;
  }

  private parseAtom(): Value {
    const t = this.tokens[this.pos];
    if (t === undefined) throw new ExprSyntaxError('argument expected');

    if (t === '(') {
      this.pos++;
      const v = this.parseOr();
      if (this.peek() !== ')') throw new ExprSyntaxError("missing `)'");
      this.pos++;
      return v;
    }

    if (t === 'length' && this.tokens.length - this.pos >= 2) {
      this.pos++;
      const s = this.parseAtom().raw;
      return makeInt(s.length);
    }
    if (t === 'substr' && this.tokens.length - this.pos >= 4) {
      this.pos++;
      const s = this.parseAtom().raw;
      const p = this.parseAtom().asInt();
      const n = this.parseAtom().asInt();
      if (p <= 0 || n <= 0 || p > s.length) return makeStr('');
      return makeStr(s.slice(p - 1, p - 1 + n));
    }
    if (t === 'index' && this.tokens.length - this.pos >= 3) {
      this.pos++;
      const s = this.parseAtom().raw;
      const chars = this.parseAtom().raw;
      let best = 0;
      for (const c of chars) {
        const idx = s.indexOf(c);
        if (idx >= 0 && (best === 0 || idx + 1 < best)) best = idx + 1;
      }
      return makeInt(best);
    }
    if (t === 'match' && this.tokens.length - this.pos >= 3) {
      this.pos++;
      const s = this.parseAtom().raw;
      const re = this.parseAtom().raw;
      return makeStr(this.matchBre(s, re));
    }
    if (t === '+') {                // GNU `+ TOKEN` — force literal
      this.pos++;
      const lit = this.tokens[this.pos++];
      if (lit === undefined) throw new ExprSyntaxError("syntax error: '+' expects argument");
      return makeStr(lit);
    }

    this.pos++;
    return makeStr(t);
  }

  private peek(): string | undefined { return this.tokens[this.pos]; }
  private isRel(t: string | undefined): boolean {
    return t === '=' || t === '!=' || t === '<' || t === '<=' || t === '>' || t === '>=';
  }

  private cmp(l: Value, op: string, r: Value): boolean {
    const isNum = /^-?\d+$/.test(l.raw) && /^-?\d+$/.test(r.raw);
    const a: number | string = isNum ? l.asInt() : l.raw;
    const b: number | string = isNum ? r.asInt() : r.raw;
    switch (op) {
      case '=':  return a === b;
      case '!=': return a !== b;
      case '<':  return a <   b;
      case '<=': return a <=  b;
      case '>':  return a >   b;
      case '>=': return a >=  b;
    }
    return false;
  }

  /**
   * `STR : BRE` — POSIX expr applies the BRE anchored at the start of
   * STR. With a capturing group, returns the first capture (or "" if
   * the match failed). Without one, returns the length of the match
   * (0 on no-match).
   */
  private matchBre(str: string, bre: string): string {
    const js = posixToJsSource(bre, { extended: false });
    let re: RegExp;
    try { re = new RegExp('^(?:' + js + ')'); }
    catch { throw new ExprRuntimeError(`bad regular expression: ${bre}`); }
    const m = re.exec(str);
    if (!m) return /\(/.test(bre) ? '' : '0';
    return m.length > 1 && m[1] !== undefined ? m[1] : String(m[0].length);
  }
}

export function runExpr(args: readonly string[]): ExprResult {
  return new ExprEvaluator().run(args);
}
