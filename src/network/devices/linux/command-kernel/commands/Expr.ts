import { posixToJsSource } from '../../regex/PosixRegex';
import { ParsedArgs } from '@/command-kernel/args/parsed-args';
import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel, Session } from '@/command-kernel/session/types';

interface ExprValue {
  raw: string;
  asInt(): number;
  isTrue(): boolean;
}

const makeStr = (s: string): ExprValue => ({
  raw: s,
  asInt() {
    if (!/^-?\d+$/.test(s)) throw new ExprRuntimeError(`non-integer argument: ${s}`);
    return Number.parseInt(s, 10);
  },
  isTrue() { return s !== '' && s !== '0'; },
});
const makeInt = (n: number): ExprValue => makeStr(String(n));

class ExprSyntaxError extends Error {}
class ExprRuntimeError extends Error {}

/**
 * Évaluateur POSIX `expr` (précédences complètes, comparaison chaîne/entier,
 * `:` BRE ancré, fonctions GNU `length`/`substr`/`index`/`match`). Une
 * instance neuve est créée par exécution pour éviter tout partage d'état
 * (`pos`/`tokens`). Interne à la commande `expr` — pas une dépendance
 * héritée. La conversion BRE→JS réutilise l'utilitaire regex partagé
 * `posixToJsSource` (infrastructure, comme une bibliothèque standard).
 */
class ExprEvaluator {
  private tokens: readonly string[] = [];
  private pos = 0;

  evaluate(args: readonly string[]): { output: string; exitCode: number } {
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

  private parseOr(): ExprValue {
    let v = this.parseAnd();
    while (this.peek() === '|') { this.pos++; const r = this.parseAnd(); if (!v.isTrue()) v = r.isTrue() ? r : makeInt(0); }
    return v;
  }

  private parseAnd(): ExprValue {
    let v = this.parseRel();
    while (this.peek() === '&') { this.pos++; const r = this.parseRel(); v = v.isTrue() && r.isTrue() ? v : makeInt(0); }
    return v;
  }

  private parseRel(): ExprValue {
    let v = this.parseAdd();
    while (this.isRel(this.peek())) {
      const op = this.tokens[this.pos++];
      const r = this.parseAdd();
      v = makeInt(this.cmp(v, op, r) ? 1 : 0);
    }
    return v;
  }

  private parseAdd(): ExprValue {
    let v = this.parseMul();
    while (this.peek() === '+' || this.peek() === '-') {
      const op = this.tokens[this.pos++];
      const r = this.parseMul();
      v = makeInt(op === '+' ? v.asInt() + r.asInt() : v.asInt() - r.asInt());
    }
    return v;
  }

  private parseMul(): ExprValue {
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

  private parseMatch(): ExprValue {
    let v = this.parseAtom();
    while (this.peek() === ':') {
      this.pos++;
      const pat = this.parseAtom().raw;
      v = makeStr(this.matchBre(v.raw, pat));
    }
    return v;
  }

  private parseAtom(): ExprValue {
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
      return makeInt(this.parseAtom().raw.length);
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
    if (t === '+') {
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

  private cmp(l: ExprValue, op: string, r: ExprValue): boolean {
    const isNum = /^-?\d+$/.test(l.raw) && /^-?\d+$/.test(r.raw);
    const a: number | string = isNum ? l.asInt() : l.raw;
    const b: number | string = isNum ? r.asInt() : r.raw;
    switch (op) {
      case '=': return a === b;
      case '!=': return a !== b;
      case '<': return a < b;
      case '<=': return a <= b;
      case '>': return a > b;
      case '>=': return a >= b;
    }
    return false;
  }

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

/**
 * `expr` — évalue une expression (arithmétique, comparaison, chaînes).
 * Commande **autonome** : l'évaluateur `ExprEvaluator` ci-dessus lui est
 * propre (aucun appel à un module hérité). Codes de sortie GNU conservés
 * (`0` vrai, `1` faux, `2` syntaxe, `3` erreur d'exécution).
 */
export class ExprCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'expr',
    summary: 'Évalue une expression',
    usage: 'expr EXPRESSION',
    args: [{ name: 'operands', type: 'string', required: false, variadic: true, description: 'jetons de l\'expression' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'texte',
    lenientOptions: true,
  };

  protected override validate(_args: ParsedArgs, _session: Session): void {
    // Les erreurs de `expr` (syntaxe → 2, exécution → 3, résultat faux → 1)
    // ont des codes de sortie propres à GNU rendus dans `execute`, pas via
    // `UsageError` (code 2 fixe).
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const operands = ctx.args.has('operands') ? ctx.args.get<string[]>('operands') : [];
    const { output, exitCode } = new ExprEvaluator().evaluate(operands);
    const body = output === '' ? '' : (output.endsWith('\n') ? output : output + '\n');
    await ctx.io.stdout.write(body);
    return exitCode as ExitCode;
  }
}
