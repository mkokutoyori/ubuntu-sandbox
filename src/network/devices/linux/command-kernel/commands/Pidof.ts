import { ParsedArgs } from '@/command-kernel/args/parsed-args';
import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel, Session } from '@/command-kernel/session/types';

/**
 * `pidof` — affiche les PID des processus dont le nom court (`comm`) est
 * exactement l'un des noms donnés, du plus récent au plus ancien. Commande
 * **autonome** : la sélection est faite ici sur l'instantané fourni par la
 * capacité `ctx.machine.processControl`. Code de sortie 1 si aucun PID.
 */
export class PidofCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'pidof',
    summary: 'Affiche les PID d\'un programme nommé',
    usage: 'pidof NOM...',
    args: [{ name: 'names', type: 'string', required: false, variadic: true, description: 'noms de programmes' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
    lenientOptions: true,
  };

  protected override validate(_args: ParsedArgs, _session: Session): void {
    // Absence de nom ou aucun PID trouvé → code de sortie 1 (rendu dans
    // `execute`, sémantique GNU `pidof`), pas via `UsageError`.
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const names = ctx.args.has('names') ? ctx.args.get<string[]>('names') : [];
    const control = ctx.machine.processControl;
    if (names.length === 0 || !control) return 1;

    const procs = control.list();
    const pids: number[] = [];
    for (const name of names) {
      for (const p of procs) if (p.comm === name) pids.push(p.pid);
    }
    if (pids.length === 0) return 1;

    await ctx.io.stdout.write(pids.sort((a, b) => b - a).join(' ') + '\n');
    return 0;
  }
}
