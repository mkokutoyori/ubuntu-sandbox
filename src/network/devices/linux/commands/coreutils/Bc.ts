/**
 * `bc` — la calculatrice à précision arbitraire de POSIX.
 *
 * Dernier refus des transcripts `linux-text-pipes`, et le seul de la
 * famille qui ne soit pas un filtre de flux : `bc` a une grammaire, des
 * variables, et une arithmétique qui lui est propre.
 *
 * Cette arithmétique est le cœur du sujet et n'est pas celle des nombres
 * flottants : `bc` calcule sur des entiers de taille libre accompagnés
 * d'une échelle décimale. Les valeurs sont donc portées ici par des
 * `bigint` — `10/3` à `scale=2` doit rendre `3.33`, pas `3.3333333333`,
 * et `2^200` doit rendre ses soixante-et-un chiffres.
 *
 * Les règles d'échelle sont celles de POSIX, relevées sur `bc 1.07.1` :
 *
 *   a+b, a-b   échelle = max(échelle(a), échelle(b))
 *   a*b        échelle = min(échelle(a)+échelle(b), max(scale, échelles))
 *   a/b        échelle = scale
 *   a%b        a - (a/b)*b, la division faite à l'échelle courante
 *   a^b        b entier ; échelle bornée par le même minimum que le produit
 *
 * Les troncatures vont vers zéro, jamais à l'arrondi.
 */

import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';

/** Une valeur bc : `v` divisé par dix puissance `s`. */
interface Num { v: bigint; s: number }

const TEN = 10n;

function pow10(n: number): bigint {
  return TEN ** BigInt(n);
}

/** Ramène une valeur à une échelle donnée, en tronquant vers zéro. */
function rescale(n: Num, s: number): Num {
  if (s === n.s) return n;
  if (s > n.s) return { v: n.v * pow10(s - n.s), s };
  const d = pow10(n.s - s);
  const q = n.v / d;
  return { v: q, s };
}

function align(a: Num, b: Num): [bigint, bigint, number] {
  const s = Math.max(a.s, b.s);
  return [rescale(a, s).v, rescale(b, s).v, s];
}

function cmp(a: Num, b: Num): number {
  const [x, y] = align(a, b);
  return x < y ? -1 : x > y ? 1 : 0;
}

const ZERO: Num = { v: 0n, s: 0 };
const ONE: Num = { v: 1n, s: 0 };

class BcError extends Error {}

/** L'erreur d'exécution de bc, dans sa forme réelle. */
function runtimeError(message: string): BcError {
  return new BcError(`Runtime error (func=(main), adr=3): ${message}`);
}

// ─── Analyse lexicale ───────────────────────────────────────────────

type Tok =
  | { k: 'num'; text: string }
  | { k: 'name'; text: string }
  | { k: 'op'; text: string }
  | { k: 'nl' }
  | { k: 'end' };

const OPS3 = ['<<=', '>>='];
const OPS2 = ['==', '!=', '<=', '>=', '&&', '||', '+=', '-=', '*=', '/=', '%=', '^=', '++', '--'];

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\' && src[i + 1] === '\n') { i += 2; continue; }
    if (c === '\n') { out.push({ k: 'nl' }); i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9A-F.]/.test(src[j])) j++;
      out.push({ k: 'num', text: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[a-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[a-z0-9_]/.test(src[j])) j++;
      out.push({ k: 'name', text: src.slice(i, j) });
      i = j;
      continue;
    }
    const three = src.slice(i, i + 3);
    if (OPS3.includes(three)) { out.push({ k: 'op', text: three }); i += 3; continue; }
    const two = src.slice(i, i + 2);
    if (OPS2.includes(two)) { out.push({ k: 'op', text: two }); i += 2; continue; }
    out.push({ k: 'op', text: c });
    i++;
  }
  out.push({ k: 'end' });
  return out;
}

// ─── Évaluation ─────────────────────────────────────────────────────

/**
 * Le mot-clé d'un langage d'instructions que ce bc n'a pas. Les nommer
 * vaut mieux que rendre « syntax error » : l'opérateur saurait que sa
 * ligne est refusée, pas qu'elle est correcte et non prise en charge.
 */
const UNSUPPORTED = ['define', 'if', 'while', 'for', 'return', 'break', 'continue', 'auto', 'read'];

class Interp {
  vars = new Map<string, Num>();
  scale = 0;
  ibase = 10;
  obase = 10;
  last: Num = ZERO;
  out: string[] = [];
  quit = false;

  private toks: Tok[] = [];
  private p = 0;

  private peek(): Tok { return this.toks[this.p]; }
  private next(): Tok { return this.toks[this.p++]; }
  private atOp(text: string): boolean {
    const t = this.peek();
    return t.k === 'op' && t.text === text;
  }
  private eatOp(text: string): boolean {
    if (!this.atOp(text)) return false;
    this.p++;
    return true;
  }

  run(src: string): void {
    this.toks = lex(src);
    this.p = 0;
    while (this.peek().k !== 'end' && !this.quit) {
      if (this.peek().k === 'nl' || this.eatOp(';')) { if (this.peek().k === 'nl') this.p++; continue; }
      this.statement();
    }
  }

  private statement(): void {
    const t = this.peek();
    if (t.k === 'name' && UNSUPPORTED.includes(t.text)) {
      throw new BcError(`bc: '${t.text}' is not supported by this bc`);
    }
    if (t.k === 'name' && t.text === 'quit') { this.quit = true; return; }
    if (t.k === 'op' && t.text === '"') { throw new BcError('(standard_in) 1: syntax error'); }

    const before = this.p;
    const value = this.expr();
    // Une affectation seule n'imprime rien — c'est ce que fait le vrai bc.
    const wasAssignment = this.assignmentAt(before);
    this.last = value;
    if (!wasAssignment) this.out.push(this.format(value));
  }

  /** Vrai si l'expression commencée à `from` était une affectation nue. */
  private assignmentAt(from: number): boolean {
    let depth = 0;
    for (let i = from; i < this.p; i++) {
      const t = this.toks[i];
      if (t.k !== 'op') continue;
      if (t.text === '(') depth++;
      else if (t.text === ')') depth--;
      else if (depth === 0 && (t.text === '=' || /^[-+*/%^]=$/.test(t.text))) return true;
    }
    return false;
  }

  // expr := assignment
  private expr(): Num { return this.assign(); }

  private assign(): Num {
    const save = this.p;
    const t = this.peek();
    if (t.k === 'name' && !UNSUPPORTED.includes(t.text)) {
      const name = t.text;
      this.p++;
      const op = this.peek();
      if (op.k === 'op' && (op.text === '=' || /^[-+*/%^]=$/.test(op.text))) {
        this.p++;
        const rhs = this.assign();
        const value = op.text === '='
          ? rhs
          : this.binary(op.text[0], this.read(name), rhs);
        this.write(name, value);
        return this.read(name);
      }
      this.p = save;
    }
    return this.orExpr();
  }

  private orExpr(): Num {
    let left = this.andExpr();
    while (this.atOp('||')) {
      this.p++;
      const right = this.andExpr();
      left = (left.v !== 0n || right.v !== 0n) ? ONE : ZERO;
    }
    return left;
  }

  private andExpr(): Num {
    let left = this.notExpr();
    while (this.atOp('&&')) {
      this.p++;
      const right = this.notExpr();
      left = (left.v !== 0n && right.v !== 0n) ? ONE : ZERO;
    }
    return left;
  }

  private notExpr(): Num {
    if (this.eatOp('!')) return this.notExpr().v === 0n ? ONE : ZERO;
    return this.relExpr();
  }

  private relExpr(): Num {
    const left = this.addExpr();
    const t = this.peek();
    if (t.k === 'op' && ['==', '!=', '<', '<=', '>', '>='].includes(t.text)) {
      this.p++;
      const right = this.addExpr();
      const c = cmp(left, right);
      const ok = t.text === '==' ? c === 0
        : t.text === '!=' ? c !== 0
        : t.text === '<' ? c < 0
        : t.text === '<=' ? c <= 0
        : t.text === '>' ? c > 0
        : c >= 0;
      return ok ? ONE : ZERO;
    }
    return left;
  }

  private addExpr(): Num {
    let left = this.mulExpr();
    for (;;) {
      if (this.atOp('+')) { this.p++; left = this.binary('+', left, this.mulExpr()); continue; }
      if (this.atOp('-')) { this.p++; left = this.binary('-', left, this.mulExpr()); continue; }
      return left;
    }
  }

  private mulExpr(): Num {
    let left = this.unary();
    for (;;) {
      const t = this.peek();
      if (t.k === 'op' && (t.text === '*' || t.text === '/' || t.text === '%')) {
        this.p++;
        left = this.binary(t.text, left, this.unary());
        continue;
      }
      return left;
    }
  }

  private unary(): Num {
    if (this.eatOp('-')) { const n = this.unary(); return { v: -n.v, s: n.s }; }
    if (this.eatOp('+')) return this.unary();
    return this.powExpr();
  }

  private powExpr(): Num {
    const base = this.primary();
    // `^` associe à droite, et son exposant peut être signé : 2^-2.
    if (this.eatOp('^')) return this.binary('^', base, this.unary());
    return base;
  }

  private primary(): Num {
    const t = this.next();
    if (t.k === 'num') return this.parseNumber(t.text);
    if (t.k === 'op' && t.text === '(') {
      const v = this.expr();
      if (!this.eatOp(')')) throw new BcError('(standard_in) 1: syntax error');
      return v;
    }
    if (t.k === 'op' && t.text === '.') return this.last;
    if (t.k === 'name') {
      if (this.atOp('(')) {
        this.p++;
        const args: Num[] = [this.expr()];
        while (this.eatOp(',')) args.push(this.expr());
        if (!this.eatOp(')')) throw new BcError('(standard_in) 1: syntax error');
        return this.call(t.text, args);
      }
      return this.read(t.text);
    }
    throw new BcError('(standard_in) 1: syntax error');
  }

  private call(name: string, args: Num[]): Num {
    if (name === 'sqrt') return this.sqrt(args[0]);
    if (name === 'length') {
      const digits = (args[0].v < 0n ? -args[0].v : args[0].v).toString().length;
      return { v: BigInt(Math.max(digits, args[0].s)), s: 0 };
    }
    if (name === 'scale') return { v: BigInt(args[0].s), s: 0 };
    // Message exact du vrai bc lorsque la bibliothèque n'est pas chargée.
    throw runtimeError(`Function ${name} not defined.`);
  }

  private sqrt(n: Num): Num {
    if (n.v < 0n) throw runtimeError('Square root of a negative number');
    const s = Math.max(this.scale, n.s);
    const target = rescale(n, s * 2).v;
    if (target === 0n) return { v: 0n, s };
    // Racine entière par Newton — le résultat est déjà à l'échelle s.
    let x = target;
    let y = (x + 1n) / 2n;
    while (y < x) { x = y; y = (x + target / x) / 2n; }
    return { v: x, s };
  }

  private parseNumber(text: string): Num {
    const dot = text.indexOf('.');
    const intPart = dot === -1 ? text : text.slice(0, dot);
    const fracPart = dot === -1 ? '' : text.slice(dot + 1);
    if (fracPart.includes('.')) throw new BcError('(standard_in) 1: syntax error');
    if (this.ibase === 10) {
      const digits = (intPart || '0') + fracPart;
      if (!/^[0-9]*$/.test(digits)) throw new BcError('(standard_in) 1: syntax error');
      return { v: BigInt(digits || '0'), s: fracPart.length };
    }
    // Base non décimale : bc ne lit que la partie entière, chiffre à chiffre.
    let v = 0n;
    const base = BigInt(this.ibase);
    for (const ch of intPart) {
      const d = parseInt(ch, 16);
      if (Number.isNaN(d)) throw new BcError('(standard_in) 1: syntax error');
      v = v * base + BigInt(d);
    }
    return { v, s: 0 };
  }

  private binary(op: string, a: Num, b: Num): Num {
    if (op === '+' || op === '-') {
      const [x, y, s] = align(a, b);
      return { v: op === '+' ? x + y : x - y, s };
    }
    if (op === '*') {
      const raw: Num = { v: a.v * b.v, s: a.s + b.s };
      return rescale(raw, Math.min(a.s + b.s, Math.max(this.scale, a.s, b.s)));
    }
    if (op === '/') return this.divide(a, b, this.scale);
    if (op === '%') {
      const q = this.divide(a, b, this.scale);
      const prod = this.binary('*', q, b);
      const [x, y, s] = align(a, prod);
      return { v: x - y, s };
    }
    if (op === '^') return this.power(a, b);
    throw new BcError('(standard_in) 1: syntax error');
  }

  private divide(a: Num, b: Num, s: number): Num {
    if (b.v === 0n) throw runtimeError('Divide by zero');
    // (a.v/10^a.s) / (b.v/10^b.s) tronqué à s décimales.
    const num = a.v * pow10(b.s + s);
    const den = b.v * pow10(a.s);
    let q = num / den;
    // BigInt tronque déjà vers zéro ; rien à corriger sur le signe.
    if (q === 0n && num !== 0n && (num < 0n) !== (den < 0n)) q = 0n;
    return { v: q, s };
  }

  private power(a: Num, b: Num): Num {
    if (b.s !== 0) throw new BcError('(standard_in) 1: syntax error');
    const e = b.v;
    if (e === 0n) return ONE;
    const negative = e < 0n;
    const n = negative ? -e : e;
    let acc: Num = ONE;
    let base = a;
    let k = n;
    while (k > 0n) {
      if (k % 2n === 1n) acc = { v: acc.v * base.v, s: acc.s + base.s };
      base = { v: base.v * base.v, s: base.s * 2 };
      k /= 2n;
    }
    if (negative) return this.divide(ONE, acc, this.scale);
    return rescale(acc, Math.min(a.s * Number(n), Math.max(this.scale, a.s)));
  }

  private read(name: string): Num {
    if (name === 'scale') return { v: BigInt(this.scale), s: 0 };
    if (name === 'ibase') return { v: BigInt(this.ibase), s: 0 };
    if (name === 'obase') return { v: BigInt(this.obase), s: 0 };
    // Une variable jamais affectée vaut zéro, elle n'est pas une erreur.
    return this.vars.get(name) ?? ZERO;
  }

  private write(name: string, value: Num): void {
    if (name === 'scale') { this.scale = Number(rescale(value, 0).v); return; }
    if (name === 'ibase') { this.ibase = Number(rescale(value, 0).v); return; }
    if (name === 'obase') { this.obase = Number(rescale(value, 0).v); return; }
    this.vars.set(name, value);
  }

  format(n: Num): string {
    const negative = n.v < 0n;
    const abs = negative ? -n.v : n.v;
    const d = pow10(n.s);
    const intPart = abs / d;
    const frac = abs % d;

    let head: string;
    if (this.obase === 10) {
      head = intPart.toString();
    } else if (this.obase < 2) {
      head = intPart.toString();
    } else {
      head = intPart === 0n ? '0' : intPart.toString(this.obase).toUpperCase();
    }

    let text: string;
    if (n.s === 0) {
      text = head;
    } else {
      const fracDigits = frac.toString().padStart(n.s, '0');
      // bc n'écrit pas le zéro de tête : `.250`, pas `0.250`.
      text = (head === '0' ? '' : head) + '.' + fracDigits;
    }
    return (negative && (abs !== 0n) ? '-' : '') + text;
  }
}

// ─── La commande ────────────────────────────────────────────────────

function evaluate(source: string): { output: string; exitCode: number } {
  const interp = new Interp();
  try {
    interp.run(source);
  } catch (e) {
    const message = e instanceof BcError ? e.message : '(standard_in) 1: syntax error';
    const lines = [...interp.out, message];
    // Le vrai bc sort en 0 même après une erreur d'exécution lue sur
    // l'entrée standard — vérifié sur bc 1.07.1.
    return { output: lines.join('\n'), exitCode: 0 };
  }
  return { output: interp.out.join('\n'), exitCode: 0 };
}

const VERSION = [
  'bc 1.07.1',
  'Copyright 1991-1994, 1997, 1998, 2000, 2004, 2006, 2008, 2012-2017 Free Software Foundation, Inc.',
  'This is free software with ABSOLUTELY NO WARRANTY.',
].join('\n');

function bcRun(ctx: LinuxCommandContext, args: string[], stdin?: string): { output: string; exitCode: number } {
  const files: string[] = [];
  for (const a of args) {
    if (a === '-v' || a === '--version') return { output: VERSION, exitCode: 0 };
    if (a === '-h' || a === '--help') {
      return { output: 'usage: bc [options] [file ...]\n  -l  define the standard math library\n  -q  do not print the initial banner\n  -v  print version', exitCode: 0 };
    }
    if (a === '-q' || a === '--quiet' || a === '-s' || a === '--standard' || a === '-w' || a === '--warn') continue;
    if (a === '-l' || a === '--mathlib') {
      // Accepter -l en ne fournissant que scale=20 laisserait croire que
      // s(), c(), a(), l(), e() et j() répondent. Elles ne sont pas là.
      return { output: 'bc: the math library (-l) is not available in this bc', exitCode: 1 };
    }
    if (a.startsWith('-')) return { output: `bc: unrecognized option '${a}'`, exitCode: 1 };
    files.push(a);
  }

  if (files.length > 0) {
    const parts: string[] = [];
    for (const f of files) {
      const content = ctx.executor.vfs.readFile(
        ctx.executor.vfs.normalizePath(f, ctx.executor.getCwd()),
      );
      if (content === null) return { output: `bc: file '${f}' is unavailable.`, exitCode: 1 };
      parts.push(content);
    }
    if (stdin !== undefined) parts.push(stdin);
    return evaluate(parts.join('\n'));
  }

  if (stdin === undefined) {
    // Sans entrée ni fichier, le vrai bc attend au terminal. Ici rien ne
    // peut arriver : le dire vaut mieux que rendre une ligne vide.
    return { output: VERSION, exitCode: 0 };
  }
  return evaluate(stdin);
}

export const bcCommand: LinuxCommand = {
  name: 'bc',
  package: 'bc',
  needsNetworkContext: true,
  readsStdin: true,
  manSection: 1,
  usage: 'bc [-l] [-q] [file ...]',
  help: 'An arbitrary precision calculator language. Reads expressions from\n'
    + 'the given files then from standard input, and prints the value of\n'
    + 'each one that is not an assignment.\n\n'
    + 'Arithmetic follows POSIX scale rules: a division keeps `scale`\n'
    + 'digits (0 by default, so 10/3 is 3), an addition keeps the larger\n'
    + 'scale of its operands, and every truncation goes toward zero.\n\n'
    + 'Expressions, variables, comparisons, assignments, sqrt(), length()\n'
    + 'and scale() are available, as are ibase and obase. The statement\n'
    + 'language — define, if, while, for — is not, and says so rather than\n'
    + 'reporting a syntax error. The math library (-l) is not available.',
  options: [
    { flag: '-l', description: 'Use the standard math library (not available here)' },
    { flag: '-q', description: 'Do not print the initial banner' },
    { flag: '-v', description: 'Print the version and exit' },
  ],
  run(ctx: LinuxCommandContext, args: string[], stdin?: string): string {
    return bcRun(ctx, args, stdin).output;
  },
  runWithStatusSync(ctx: LinuxCommandContext, args: string[], stdin?: string) {
    return bcRun(ctx, args, stdin);
  },
};
