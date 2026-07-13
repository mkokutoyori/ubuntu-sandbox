import { ParsedArgs } from '@/command-kernel/args/parsed-args';
import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel, Session } from '@/command-kernel/session/types';
import { parseSignalArg } from './signals';

/**
 * `pkill [-SIGNAL] motif` — envoie un signal (SIGTERM par défaut) à tous les
 * processus dont le nom court ou la ligne de commande contient `motif`.
 * Commande **autonome** : sélection sur `ctx.machine.processControl.list()`
 * puis `signal()`. Code de sortie 0 si au moins un signalé, sinon 1.
 */
export class PkillCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'pkill',
    summary: 'Envoie un signal aux processus correspondant à un motif',
    usage: 'pkill [-SIGNAL] motif',
    args: [{ name: 'operands', type: 'string', required: false, variadic: true, description: '[-SIGNAL] motif' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
    lenientOptions: true,
  };

  protected override validate(_args: ParsedArgs, _session: Session): void {
    // « no matching criteria specified » (code 2) et l'absence de cible
    // (code 1) sont des issues d'exécution, rendues dans `execute`.
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.has('operands') ? ctx.args.get<string[]>('operands') : [];
    let signal = 'SIGTERM';
    const positional: string[] = [];
    for (const a of args) {
      if (a.startsWith('-')) {
        const sig = parseSignalArg(a);
        if (sig) { signal = sig; continue; }
      }
      positional.push(a);
    }
    if (positional.length === 0) {
      await ctx.io.stdout.write('pkill: no matching criteria specified\n');
      return 2;
    }

    const control = ctx.machine.processControl;
    const pattern = positional[0];
    let count = 0;
    for (const p of control ? control.list() : []) {
      if (p.comm.includes(pattern) || p.command.includes(pattern)) {
        if (control!.signal(p.pid, signal)) count++;
      }
    }
    return count > 0 ? 0 : 1;
  }
}
