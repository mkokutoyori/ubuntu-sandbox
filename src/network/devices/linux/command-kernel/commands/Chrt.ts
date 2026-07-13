import { ParsedArgs } from '@/command-kernel/args/parsed-args';
import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel, Session } from '@/command-kernel/session/types';

const SCHED_POLICIES: Record<string, string> = {
  '-f': 'SCHED_FIFO', '--fifo': 'SCHED_FIFO',
  '-r': 'SCHED_RR', '--rr': 'SCHED_RR',
  '-o': 'SCHED_OTHER', '--other': 'SCHED_OTHER',
  '-b': 'SCHED_BATCH', '--batch': 'SCHED_BATCH',
  '-i': 'SCHED_IDLE', '--idle': 'SCHED_IDLE',
};

/**
 * `chrt [-p pid]` / `chrt -f|-r|-o|-b|-i prio -p pid` / `chrt -m` —
 * consulte ou modifie la politique d'ordonnancement temps réel d'un
 * processus. Commande **autonome** : lit/écrit via
 * `ctx.machine.processControl` (get / setSchedPolicy).
 */
export class ChrtCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'chrt',
    summary: 'Consulte ou modifie la politique d\'ordonnancement temps réel',
    usage: 'chrt [options] [-p [priorité] pid]',
    args: [{ name: 'operands', type: 'string', required: false, variadic: true, description: '[options] [-p [prio] pid]' }],
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

    if (args.includes('-m') || args.includes('--max')) {
      await ctx.io.stdout.write([
        'SCHED_OTHER min/max priority\t: 0/0',
        'SCHED_FIFO min/max priority\t: 1/99',
        'SCHED_RR min/max priority\t: 1/99',
        'SCHED_BATCH min/max priority\t: 0/0',
        'SCHED_IDLE min/max priority\t: 0/0',
      ].join('\n') + '\n');
      return 0;
    }

    const pIdx = args.findIndex((a) => a === '-p' || a === '--pid');
    if (pIdx < 0) {
      await ctx.io.stdout.write('chrt: usage: chrt [options] [-p [priority] pid]\n');
      return 1;
    }
    const pidTok = args[pIdx + 1] ?? args[pIdx + 2];
    const pid = Number(pidTok);
    const control = ctx.machine.processControl;
    const p = control ? control.get(pid) : null;
    if (!p) {
      await ctx.io.stdout.write(`chrt: failed to get pid ${pidTok}'s policy: No such process\n`);
      return 1;
    }

    const policyFlag = args.find((a) => a in SCHED_POLICIES);
    if (policyFlag) {
      const rt = args.find((a) => /^\d+$/.test(a));
      control!.setSchedPolicy(pid, SCHED_POLICIES[policyFlag], rt ? Number(rt) : 0);
      return 0;
    }
    await ctx.io.stdout.write([
      `pid ${pid}'s current scheduling policy: ${p.schedPolicy ?? 'SCHED_OTHER'}`,
      `pid ${pid}'s current scheduling priority: ${p.rtPriority ?? 0}`,
    ].join('\n') + '\n');
    return 0;
  }
}
