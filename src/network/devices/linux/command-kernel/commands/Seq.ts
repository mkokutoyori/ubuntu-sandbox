import { ParsedArgs } from '@/command-kernel/args/parsed-args';
import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel, Session } from '@/command-kernel/session/types';

interface SeqParsed {
  separator: string;
  terminator: string | null;
  equalWidth: boolean;
  format: string | null;
  operands: string[];
}

/**
 * `seq` — génère une suite arithmétique. Commande **autonome** : l'analyse
 * des options (`-s`/`-t`/`-w`/`-f`, formes longues) et le rendu GNU
 * (précision décimale, pas négatif, largeur égale, format printf) sont
 * implémentés ici, sans dépendance à un module hérité.
 */
export class SeqCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'seq',
    summary: 'Génère une suite de nombres',
    usage: 'seq [-w] [-s CHAÎNE] [-f FORMAT] DERNIER\n   ou : seq [OPTION]... PREMIER [PAS] DERNIER',
    args: [{ name: 'operands', type: 'string', required: false, variadic: true, description: 'PREMIER [PAS] DERNIER' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'texte',
    lenientOptions: true,
  };

  protected override validate(_args: ParsedArgs, _session: Session): void {
    // Les erreurs d'opérande de `seq` (nombre d'opérandes, argument non
    // numérique, pas nul) sortent avec le code GNU 1 ; elles sont donc
    // rendues dans `execute` plutôt que via `UsageError` (code 2).
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const argv = ctx.args.has('operands') ? ctx.args.get<string[]>('operands') : [];
    const { output, exitCode } = this.generate(argv);
    // GNU `seq` termine la sortie par un saut de ligne dès qu'elle est non
    // vide (séparateur newline par défaut) — indispensable en pipeline.
    const body = output === '' ? '' : (output.endsWith('\n') ? output : output + '\n');
    await ctx.io.stdout.write(body);
    return exitCode as ExitCode;
  }

  private generate(argv: readonly string[]): { output: string; exitCode: number } {
    let parsed: SeqParsed;
    try {
      parsed = this.parseArgs(argv);
    } catch (e) {
      return { output: `seq: ${e instanceof Error ? e.message : 'error'}`, exitCode: 1 };
    }

    const { operands, separator, format, equalWidth } = parsed;
    if (operands.length < 1 || operands.length > 3) {
      return { output: 'seq: missing operand', exitCode: 1 };
    }
    for (const o of operands) {
      if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(o)) {
        return { output: `seq: invalid floating point argument: ${o}`, exitCode: 1 };
      }
    }

    let first = 1, increment = 1, last: number;
    let precision = 0;
    if (operands.length === 1) {
      last = Number.parseFloat(operands[0]);
    } else if (operands.length === 2) {
      first = Number.parseFloat(operands[0]);
      last = Number.parseFloat(operands[1]);
      precision = Math.max(this.decimalPlaces(operands[0]), this.decimalPlaces(operands[1]));
    } else {
      first = Number.parseFloat(operands[0]);
      increment = Number.parseFloat(operands[1]);
      last = Number.parseFloat(operands[2]);
      precision = Math.max(...operands.map((o) => this.decimalPlaces(o)));
    }
    if (increment === 0) return { output: 'seq: invalid Zero increment value: 0', exitCode: 1 };
    const ascending = increment > 0;

    const nums: number[] = [];
    for (let v = first; ascending ? v <= last + 1e-12 : v >= last - 1e-12; v += increment) {
      nums.push(precision === 0 ? Math.round(v) : Number.parseFloat(v.toFixed(precision + 6)));
    }
    if (nums.length === 0) return { output: '', exitCode: 0 };

    const widest = equalWidth ? Math.max(...nums.map((n) => this.intWidth(n, precision))) : 0;
    const rendered = nums.map((n) => this.renderOne(n, format, precision, equalWidth, widest));
    return { output: rendered.join(separator) + (parsed.terminator ?? ''), exitCode: 0 };
  }

  private parseArgs(argv: readonly string[]): SeqParsed {
    const out: SeqParsed = { separator: '\n', terminator: null, equalWidth: false, format: null, operands: [] };
    let i = 0;
    const take = (opt: string): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`option '${opt}' requires an argument`);
      return v;
    };
    while (i < argv.length) {
      const a = argv[i];
      if (a === '--') { out.operands.push(...argv.slice(i + 1)); break; }
      else if (a === '-s' || a === '--separator') { out.separator = take(a); }
      else if (a === '-t' || a === '--terminator') { out.terminator = take(a); }
      else if (a === '-f' || a === '--format') { out.format = take(a); }
      else if (a === '-w' || a === '--equal-width') { out.equalWidth = true; }
      else if (a.startsWith('--separator=')) { out.separator = a.slice('--separator='.length); }
      else if (a.startsWith('--terminator=')) { out.terminator = a.slice('--terminator='.length); }
      else if (a.startsWith('--format=')) { out.format = a.slice('--format='.length); }
      else { out.operands.push(a); }
      i++;
    }
    return out;
  }

  /** Nombre de décimales dans un littéral (0 pour un entier). */
  private decimalPlaces(token: string): number {
    const m = /\.([0-9]+)/.exec(token);
    return m ? m[1].length : 0;
  }

  /** Largeur de la partie entière (signe « - » inclus). */
  private intWidth(n: number, precision: number): number {
    const s = n.toFixed(precision);
    const dot = s.indexOf('.');
    return dot < 0 ? s.length : dot;
  }

  private renderOne(n: number, format: string | null, precision: number, equalWidth: boolean, widest: number): string {
    if (format) return this.applyFormat(format, n);
    let body = precision === 0 ? String(Math.trunc(n)) : n.toFixed(precision);
    if (equalWidth) {
      const neg = body.startsWith('-');
      const stem = neg ? body.slice(1) : body;
      const dot = stem.indexOf('.');
      const intLen = dot < 0 ? stem.length : dot;
      if (intLen < widest) {
        body = (neg ? '-' : '') + '0'.repeat(widest - intLen) + stem;
      }
    }
    return body;
  }

  /** printf minimal couvrant `%f %g %e %d %s`. */
  private applyFormat(fmt: string, value: number): string {
    return fmt.replace(/%%|%([-0+ #]*)(\d+)?(?:\.(\d+))?([efgds])/g, (m, flags, widthStr, precStr, spec) => {
      if (m === '%%') return '%';
      const width = widthStr ? Number.parseInt(widthStr, 10) : 0;
      const prec = precStr !== undefined ? Number.parseInt(precStr, 10) : 6;
      const left = flags.includes('-');
      const zero = flags.includes('0') && !left;
      let body: string;
      switch (spec) {
        case 'd': body = String(Math.trunc(value)); break;
        case 's': body = String(value); break;
        case 'f': body = value.toFixed(prec); break;
        case 'e': body = value.toExponential(prec); break;
        case 'g': body = value.toPrecision(prec).replace(/\.?0+$/, ''); break;
        default: body = String(value);
      }
      if (body.length >= width) return body;
      const pad = (zero ? '0' : ' ').repeat(width - body.length);
      if (left) return body + pad;
      if (zero && body.startsWith('-')) return '-' + pad + body.slice(1);
      return pad + body;
    });
  }
}
