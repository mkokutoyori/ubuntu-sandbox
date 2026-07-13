import { ParsedArgs } from '@/command-kernel/args/parsed-args';
import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel, Session } from '@/command-kernel/session/types';

/**
 * `pgrep [-l] [-u user] motif` — affiche les PID des processus dont le nom
 * court ou la ligne de commande contient `motif`. Commande **autonome** :
 * la sélection et le filtrage (`-u`), le format (`-l`) sont faits ici sur
 * l'instantané `ctx.machine.processControl.list()`.
 */
export class PgrepCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'pgrep',
    summary: 'Recherche des processus par motif',
    usage: 'pgrep [-l] [-u utilisateur] motif',
    args: [{ name: 'operands', type: 'string', required: false, variadic: true, description: 'options et motif' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
    lenientOptions: true,
  };

  protected override validate(_args: ParsedArgs, _session: Session): void {
    // « no matching criteria specified » (code 2) et « aucun résultat »
    // (code 1) sont des issues d'exécution GNU, rendues dans `execute`.
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.has('operands') ? ctx.args.get<string[]>('operands') : [];
    let listLong = false;
    let user: string | null = null;
    const patterns: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-l') listLong = true;
      else if (a === '-u') user = args[++i] ?? null;
      else patterns.push(a);
    }
    if (patterns.length === 0) {
      await ctx.io.stdout.write('pgrep: no matching criteria specified\n');
      return 2;
    }

    const control = ctx.machine.processControl;
    const pattern = patterns[0];
    const matched = (control ? control.list() : [])
      .filter((p) => p.comm.includes(pattern) || p.command.includes(pattern))
      .filter((p) => (user ? p.user === user : true));
    if (matched.length === 0) return 1;

    const lines = matched.map((p) => (listLong ? `${p.pid} ${p.comm}` : String(p.pid)));
    await ctx.io.stdout.write(lines.join('\n') + '\n');
    return 0;
  }
}
