import { ParsedArgs } from '@/command-kernel/args/parsed-args';
import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { toFileSystemActor } from '@/command-kernel/machine/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel, Session } from '@/command-kernel/session/types';

interface Hunk {
  aStart: number;
  aLines: string[];
  bStart: number;
  bLines: string[];
}

/**
 * `diff` — compare deux fichiers ligne à ligne (format « normal » GNU).
 * Commande **autonome** : l'algorithme (table LCS, calcul des hunks, rendu
 * `<`/`---`/`>`) est implémenté ici en méthodes privées, sans dépendance à
 * un module hérité. Codes de sortie GNU : 0 identiques, 1 différences,
 * 2 erreur (opérande manquant, fichier absent).
 */
export class DiffCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'diff',
    summary: 'Compare deux fichiers ligne à ligne',
    usage: 'diff FICHIER1 FICHIER2',
    args: [{ name: 'operands', type: 'string', required: false, variadic: true, description: 'fichiers à comparer' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'texte',
    lenientOptions: true,
  };

  protected override validate(_args: ParsedArgs, _session: Session): void {
    // `diff` renvoie ses erreurs d'opérande avec le code de sortie 2 propre
    // à GNU (opérande manquant, fichier introuvable) ; elles sont donc
    // rendues dans `execute` plutôt que via `UsageError`.
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const operands = ctx.args.has('operands') ? ctx.args.get<string[]>('operands') : [];
    const paths = operands.filter((a) => !a.startsWith('-'));
    if (paths.length !== 2) {
      await ctx.io.stdout.write('diff: missing operand\n');
      return 2;
    }

    const actor = toFileSystemActor(ctx.session.user);
    const contents: string[] = [];
    for (const p of paths) {
      const abs = ctx.machine.fs.resolve(ctx.session.cwd, p);
      try {
        contents.push(await ctx.machine.fs.readFile(abs, actor));
      } catch {
        await ctx.io.stdout.write(`diff: ${p}: No such file or directory\n`);
        return 2;
      }
    }

    const hunks = this.computeHunks(this.splitLines(contents[0]), this.splitLines(contents[1]));
    if (hunks.length === 0) return 0;
    await ctx.io.stdout.write(hunks.map((h) => this.renderHunk(h)).join('\n') + '\n');
    return 1;
  }

  private splitLines(content: string): string[] {
    const lines = content.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines;
  }

  private lcsTable(a: string[], b: string[]): number[][] {
    const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
      }
    }
    return table;
  }

  private computeHunks(a: string[], b: string[]): Hunk[] {
    const lcs = this.lcsTable(a, b);
    const hunks: Hunk[] = [];
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) { i++; j++; continue; }
      const hunk: Hunk = { aStart: i, aLines: [], bStart: j, bLines: [] };
      while (i < a.length && (j >= b.length || lcs[i + 1][j] >= lcs[i][j + 1]) && (j >= b.length || a[i] !== b[j])) {
        hunk.aLines.push(a[i]); i++;
      }
      while (j < b.length && (i >= a.length || lcs[i][j + 1] > lcs[i + 1][j]) && (i >= a.length || a[i] !== b[j])) {
        hunk.bLines.push(b[j]); j++;
      }
      if (hunk.aLines.length === 0 && hunk.bLines.length === 0) break;
      hunks.push(hunk);
    }
    return hunks;
  }

  private renderHunk(h: Hunk): string {
    const lines: string[] = [this.renderHeader(h)];
    for (const l of h.aLines) lines.push(`< ${l}`);
    if (h.aLines.length > 0 && h.bLines.length > 0) lines.push('---');
    for (const l of h.bLines) lines.push(`> ${l}`);
    return lines.join('\n');
  }

  private renderHeader(h: Hunk): string {
    const aRange = this.rangeLabel(h.aStart, h.aLines.length);
    const bRange = this.rangeLabel(h.bStart, h.bLines.length);
    const op = h.aLines.length === 0 ? 'a' : h.bLines.length === 0 ? 'd' : 'c';
    return `${aRange}${op}${bRange}`;
  }

  private rangeLabel(start: number, count: number): string {
    if (count === 0) return String(start);
    if (count === 1) return String(start + 1);
    return `${start + 1},${start + count}`;
  }
}
