import { ParsedArgs } from '@/command-kernel/args/parsed-args';
import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel, Session } from '@/command-kernel/session/types';

const IO_CLASSES = ['none', 'realtime', 'best-effort', 'idle'];

/**
 * `ionice [-c classe] [-n niveau] [-p pid]` — consulte ou modifie la
 * classe d'ordonnancement d'E/S d'un processus. Commande **autonome** :
 * lit/écrit via `ctx.machine.processControl` (get / setIoClass).
 */
export class IoniceCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'ionice',
    summary: 'Consulte ou modifie la classe d\'ordonnancement d\'E/S',
    usage: 'ionice [-c classe] [-n niveau] [-p pid]',
    args: [{ name: 'operands', type: 'string', required: false, variadic: true, description: '[-c classe] [-n niveau] [-p pid]' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
    lenientOptions: true,
  };

  protected override validate(_args: ParsedArgs, _session: Session): void {
    // Classe invalide / PID inexistant : erreurs d'exécution (code 1).
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.has('operands') ? ctx.args.get<string[]>('operands') : [];
    const pIdx = args.findIndex((a) => a === '-p');
    const cIdx = args.findIndex((a) => a === '-c');
    const nIdx = args.findIndex((a) => a === '-n');
    const control = ctx.machine.processControl;

    if (cIdx >= 0) {
      const c = Number(args[cIdx + 1]);
      if (!Number.isInteger(c) || c < 0 || c > 3) {
        await ctx.io.stdout.write(`ionice: invalid class: ${args[cIdx + 1]}\n`);
        return 1;
      }
      if (pIdx >= 0) {
        const pid = Number(args[pIdx + 1]);
        const p = control ? control.get(pid) : null;
        if (!p) {
          await ctx.io.stdout.write('ionice: ioprio_set failed: No such process\n');
          return 1;
        }
        control!.setIoClass(pid, IO_CLASSES[c], nIdx >= 0 ? Number(args[nIdx + 1]) : 4);
      }
      return 0;
    }

    if (pIdx >= 0) {
      const pid = Number(args[pIdx + 1]);
      const p = control ? control.get(pid) : null;
      if (!p) {
        await ctx.io.stdout.write('ionice: ioprio_get failed: No such process\n');
        return 1;
      }
      const cls = p.ioClass ?? 'best-effort';
      const line = cls === 'none' || cls === 'idle' ? cls : `${cls}: prio ${p.ioClassData ?? 4}`;
      await ctx.io.stdout.write(line + '\n');
      return 0;
    }
    await ctx.io.stdout.write('best-effort: prio 4\n');
    return 0;
  }
}
