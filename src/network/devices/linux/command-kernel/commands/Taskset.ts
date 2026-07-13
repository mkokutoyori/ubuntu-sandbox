import { ParsedArgs } from '@/command-kernel/args/parsed-args';
import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel, Session } from '@/command-kernel/session/types';

/**
 * `taskset -p [mask] pid` / `taskset -pc pid` — consulte l'affinité CPU
 * d'un processus, en masque hexadécimal ou en liste (`-c`). Commande
 * **autonome** : lit via `ctx.machine.processControl.get`.
 */
export class TasksetCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'taskset',
    summary: 'Consulte ou modifie l\'affinité CPU d\'un processus',
    usage: 'taskset [options] -p [mask] pid',
    args: [{ name: 'operands', type: 'string', required: false, variadic: true, description: '[options] -p [mask] pid' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
    lenientOptions: true,
  };

  protected override validate(_args: ParsedArgs, _session: Session): void {
    // Absence de cible / PID inexistant : erreurs d'exécution (code 1).
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.has('operands') ? ctx.args.get<string[]>('operands') : [];
    const asList = args.some((a) => a.startsWith('-') && a.includes('c'));
    const pIdx = args.findIndex((a) => a.startsWith('-') && a.includes('p'));
    if (pIdx < 0) {
      await ctx.io.stdout.write('taskset: usage: taskset [options] -p [mask] pid\n');
      return 1;
    }
    const pidTok = args[pIdx + 1];
    const pid = Number(pidTok);
    const control = ctx.machine.processControl;
    const p = control ? control.get(pid) : null;
    if (!p) {
      await ctx.io.stdout.write(`taskset: failed to get pid ${pidTok}'s affinity: No such process\n`);
      return 1;
    }
    const cpus = p.cpuAffinity ?? [0, 1, 2, 3];
    if (asList) {
      await ctx.io.stdout.write(`pid ${pid}'s current affinity list: ${cpus[0]}-${cpus[cpus.length - 1]}\n`);
      return 0;
    }
    const mask = cpus.reduce((m, c) => m | (1 << c), 0).toString(16);
    await ctx.io.stdout.write(`pid ${pid}'s current affinity mask: ${mask}\n`);
    return 0;
  }
}
