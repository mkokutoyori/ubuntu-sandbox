import { ParsedArgs } from '@/command-kernel/args/parsed-args';
import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel, Session } from '@/command-kernel/session/types';
import { parseSignalArg } from './signals';

/**
 * `killall [-SIGNAL] NOM...` — envoie un signal à tout processus dont le nom
 * court (`comm`) correspond **exactement**. Commande **autonome** :
 * sélection sur `ctx.machine.processControl.list()` puis `signal()`. Le PID 1
 * (init/systemd) est protégé, comme sur un hôte réel.
 */
export class KillallCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'killall',
    summary: 'Termine des processus par nom',
    usage: 'killall [-SIGNAL] NOM...',
    args: [{ name: 'operands', type: 'string', required: false, variadic: true, description: '[-SIGNAL] NOM...' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
    lenientOptions: true,
  };

  protected override validate(_args: ParsedArgs, _session: Session): void {
    // Usage manquant (code 1) et « no process found » sont rendus dans
    // `execute` (sémantique GNU `killall`).
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.has('operands') ? ctx.args.get<string[]>('operands') : [];
    let signal = 'SIGTERM';
    const names: string[] = [];
    for (const a of args) {
      if (a.startsWith('-')) {
        const sig = parseSignalArg(a);
        if (sig) signal = sig;
        continue; // autres options ignorées (-q -v -w -e -I…)
      }
      names.push(a);
    }
    if (names.length === 0) {
      await ctx.io.stdout.write('killall: usage: killall [OPTION]... [--] NAME...\n');
      return 1;
    }

    const control = ctx.machine.processControl;
    const procs = control ? control.list() : [];
    const out: string[] = [];
    let signalled = 0;
    for (const name of names) {
      const pids = procs.filter((p) => p.comm === name).map((p) => p.pid);
      if (pids.length === 0) { out.push(`${name}: no process found`); continue; }
      for (const pid of pids) {
        if (pid === 1) { out.push(`${name}(1): Operation not permitted`); continue; }
        control!.signal(pid, signal);
        signalled++;
      }
    }
    await ctx.io.stdout.write(out.length ? out.join('\n') + '\n' : '');
    return signalled === 0 ? 1 : 0;
  }
}
