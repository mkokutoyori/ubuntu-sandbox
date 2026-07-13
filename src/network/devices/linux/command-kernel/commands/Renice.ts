import { ParsedArgs } from '@/command-kernel/args/parsed-args';
import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel, Session } from '@/command-kernel/session/types';

/**
 * `renice [-n] priorité [-p|-u|-g] cible...` — change la gentillesse de
 * processus vivants. Commande **autonome** : agit via
 * `ctx.machine.processControl` (le `renice` sous-jacent publie
 * `linux.process.priority-changed`). Respecte les règles POSIX :
 * seul root peut fixer une priorité négative ou toucher un processus
 * d'un autre utilisateur.
 */
export class ReniceCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'renice',
    summary: 'Change la gentillesse de processus en cours',
    usage: 'renice [-n] priorité [-p|-u|-g] cible...',
    args: [{ name: 'operands', type: 'string', required: false, variadic: true, description: '[-n] priorité cible...' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
    lenientOptions: true,
  };

  protected override validate(_args: ParsedArgs, _session: Session): void {
    // Priorité invalide / cible manquante sont des erreurs d'exécution
    // (code 1) rendues dans `execute` avec les messages GNU exacts.
  }

  private static resolvePids(tokens: string[]): number[] {
    return tokens
      .flatMap((t) => t.split(','))
      .map((t) => Number(t))
      .filter((n) => Number.isInteger(n) && n > 0);
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.has('operands') ? ctx.args.get<string[]>('operands') : [];
    const usage = 'renice: usage: renice [-n] priority [-p|--pid] pid...';
    if (args.length === 0) {
      await ctx.io.stdout.write(usage + '\n');
      return 1;
    }

    let idx = 0;
    if (args[0] === '-n' || args[0] === '--priority') idx = 1;
    const prioTok = args[idx];
    const prio = Number(prioTok);
    if (prioTok === undefined || Number.isNaN(prio)) {
      await ctx.io.stdout.write(`renice: invalid priority '${prioTok ?? ''}'\n`);
      return 1;
    }
    idx++;

    const rest = args.slice(idx);
    let mode: 'pid' | 'user' = 'pid';
    const targets: string[] = [];
    for (const tok of rest) {
      if (tok === '-p' || tok === '--pid') { mode = 'pid'; continue; }
      if (tok === '-u' || tok === '--user') { mode = 'user'; continue; }
      if (tok === '-g' || tok === '--pgrp') { mode = 'pid'; continue; }
      targets.push(tok);
    }
    if (targets.length === 0) {
      await ctx.io.stdout.write(usage + '\n');
      return 1;
    }

    const control = ctx.machine.processControl;
    if (!control) {
      await ctx.io.stdout.write('renice: process control unavailable\n');
      return 1;
    }

    const callerIsRoot = ctx.session.user.uid === 0;
    const currentUser = ctx.session.user.name;
    if (!callerIsRoot && prio < 0) {
      await ctx.io.stdout.write('renice: failed to set priority: Permission denied\n');
      return 1;
    }

    const lines: string[] = [];
    let exitCode = 0;
    if (mode === 'user') {
      for (const user of targets) {
        if (!callerIsRoot && user !== currentUser) {
          lines.push(`renice: failed to set priority for user ${user}: Permission denied`);
          exitCode = 1;
          continue;
        }
        for (const p of control.list().filter((e) => e.user === user)) {
          const old = p.nice;
          control.renice(p.pid, prio);
          lines.push(`${p.pid} (process ID) old priority ${old}, new priority ${prio}`);
        }
      }
    } else {
      for (const pid of ReniceCommand.resolvePids(targets)) {
        const p = control.get(pid);
        if (!p) {
          lines.push(`renice: failed to set priority for ${pid} (process ID): No such process`);
          exitCode = 1;
          continue;
        }
        if (!callerIsRoot && p.user !== currentUser) {
          lines.push(`renice: failed to set priority for ${pid} (process ID): Permission denied`);
          exitCode = 1;
          continue;
        }
        const old = p.nice;
        control.renice(pid, prio);
        lines.push(`${pid} (process ID) old priority ${old}, new priority ${prio}`);
      }
    }
    if (lines.length > 0) await ctx.io.stdout.write(lines.join('\n') + '\n');
    return exitCode as ExitCode;
  }
}
