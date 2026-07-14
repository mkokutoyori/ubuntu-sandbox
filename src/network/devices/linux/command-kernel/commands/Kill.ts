import { ParsedArgs } from '@/command-kernel/args/parsed-args';
import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel, Session } from '@/command-kernel/session/types';
import { SIGNAL_NUMBERS, parseSignalArg } from './signals';

/**
 * `kill [-s sig | -n num | -SIG] pid...` / `kill -l` — envoie un signal
 * (SIGTERM par défaut) à des processus par PID. Commande **autonome** :
 * signalisation via `ctx.machine.processControl`.
 *
 * Auto-signalement (`kill $$`) : viser le shell de connexion avec un signal
 * terminant renvoie directement `128+signal` (le shell interactif/distant
 * n'a pas de superviseur de script) ; viser le shell d'un script signale le
 * processus normalement, et c'est `runScriptProcess` qui traduit sa
 * disparition en `128+signal` et interrompt le script. Les jobspecs `%N`
 * restent gérés en amont par les builtins de contrôle de tâche
 * (`runJobBuiltinIfMatching`), au même titre que `fg`/`bg`/`wait`.
 */
export class KillCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'kill',
    summary: 'Envoie un signal à des processus par PID',
    usage: 'kill [-s sigspec | -n signum | -sigspec] pid... | kill -l',
    args: [{ name: 'operands', type: 'string', required: false, variadic: true, description: '[-SIGNAL] pid...' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
    lenientOptions: true,
  };

  private static readonly TERMINATING = new Set(['SIGTERM', 'SIGINT', 'SIGQUIT', 'SIGKILL', 'SIGHUP', 'SIGPIPE']);

  protected override validate(_args: ParsedArgs, _session: Session): void {
    // Usage manquant / signal invalide / PID inexistant sont des issues
    // d'exécution, rendues dans `execute` avec le code de sortie exact.
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.has('operands') ? ctx.args.get<string[]>('operands') : [];
    // Le syscall kill(2) est tracé dès l'invocation, indépendamment de
    // l'existence de la cible (auditd trace un `kill -9 <pid inexistant>`),
    // à l'identique du `publishSyscall('kill')` inconditionnel du legacy.
    ctx.machine.audit?.syscall('kill');
    if (args.length === 0) {
      await ctx.io.stdout.write('kill: usage: kill [-s sigspec | -n signum | -sigspec] pid | jobspec ... or kill -l [sigspec]\n');
      return 2;
    }

    if (args[0] === '-l') {
      const list = Object.entries(SIGNAL_NUMBERS)
        .sort((a, b) => a[1] - b[1])
        .map(([name, num]) => `${num}) ${name}`);
      await ctx.io.stdout.write(list.join('\n') + '\n');
      return 0;
    }

    let signal = 'SIGTERM';
    const pidArgs: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-s' || a === '-n') {
        const sig = parseSignalArg(args[++i] ?? '');
        if (!sig) { await ctx.io.stdout.write(`kill: ${args[i]}: invalid signal specification\n`); return 1; }
        signal = sig;
      } else if (a.startsWith('-') && a.length > 1) {
        const sig = parseSignalArg(a);
        if (!sig) { await ctx.io.stdout.write(`kill: ${a.slice(1)}: invalid signal specification\n`); return 1; }
        signal = sig;
      } else {
        pidArgs.push(a);
      }
    }

    if (pidArgs.length === 0) {
      await ctx.io.stdout.write('kill: not enough arguments\n');
      return 2;
    }

    // Auto-signalement du shell de connexion avec un signal terminant : le
    // shell interactif (ou la session distante) n'a pas de superviseur de
    // script pour convertir la disparition du processus en code de sortie,
    // donc bash sort directement avec `128+signal` (SIGINT → 130). Un shell
    // de script est un `proc.pid` distinct du shell de connexion, non
    // concerné : sa disparition est bien convertie par `runScriptProcess`.
    const loginPid = ctx.session.shellPid;
    if (loginPid !== undefined && KillCommand.TERMINATING.has(signal)) {
      for (const pidArg of pidArgs) {
        if (Number.parseInt(pidArg, 10) === loginPid) {
          return (128 + (SIGNAL_NUMBERS[signal] ?? 15)) as ExitCode;
        }
      }
    }

    const control = ctx.machine.processControl;
    const errors: string[] = [];
    let exitCode = 0;
    for (const pidArg of pidArgs) {
      const pid = Number.parseInt(pidArg, 10);
      if (Number.isNaN(pid)) {
        errors.push(`kill: ${pidArg}: arguments must be process or job IDs`);
        exitCode = 1;
        continue;
      }
      if (!control || !control.get(pid)) {
        errors.push(`kill: (${pid}) - No such process`);
        exitCode = 1;
        continue;
      }
      if (!control.signal(pid, signal)) {
        errors.push(`kill: (${pid}) - Operation not permitted`);
        exitCode = 1;
        continue;
      }
    }
    if (errors.length > 0) await ctx.io.stdout.write(errors.join('\n') + '\n');
    return exitCode as ExitCode;
  }
}
