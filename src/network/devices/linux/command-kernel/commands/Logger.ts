import { ParsedArgs } from '@/command-kernel/args/parsed-args';
import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { toFileSystemActor } from '@/command-kernel/machine/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel, Session } from '@/command-kernel/session/types';

/**
 * `logger [-t tag] [-p prio] [-i] [-s] [-e] [-f fichier] [message]` — ajoute
 * un enregistrement syslog. Commande **autonome** : parse ses options
 * elle-même puis écrit via la primitive `ctx.machine.logging.writeSyslog`
 * (qui possède le journal, le ring buffer noyau et les fichiers
 * `/var/log/*`). `-s` réémet la ligne syslog formatée renvoyée par la
 * primitive.
 */
export class LoggerCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'logger',
    summary: 'Ajoute une entrée au journal système (syslog)',
    usage: 'logger [-t tag] [-p prio] [-i] [-s] [-e] [-f fichier] [message]',
    args: [{ name: 'operands', type: 'string', required: false, variadic: true, description: '[options] [message]' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
    lenientOptions: true,
  };

  protected override validate(_args: ParsedArgs, _session: Session): void {
    // Priorité inconnue / fichier absent / usage sont des issues d'exécution
    // (code 1), rendues dans `execute` avec le message exact.
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.has('operands') ? ctx.args.get<string[]>('operands') : [];
    let tag = ctx.session.user.name;
    let priority = 'user.notice';
    let includePid = false;
    let toStderr = false;
    let expandNewlines = false;
    let fromFile: string | null = null;
    const msgParts: string[] = [];

    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-t' || a === '--tag') { tag = args[++i] ?? tag; }
      else if (a === '-p' || a === '--priority') { priority = args[++i] ?? priority; }
      else if (a === '-i' || a === '--id') { includePid = true; }
      else if (a === '-s' || a === '--stderr') { toStderr = true; }
      else if (a === '-e') { expandNewlines = true; }
      else if (a === '-f' || a === '--file') { fromFile = args[++i] ?? null; }
      else { msgParts.push(a); }
    }

    const logging = ctx.machine.logging;
    if (!logging) return 1;

    let messages: string[];
    if (fromFile !== null) {
      const actor = toFileSystemActor(ctx.session.user);
      const path = ctx.machine.fs.resolve(ctx.session.cwd, fromFile);
      let content: string;
      try {
        content = await ctx.machine.fs.readFile(path, actor);
      } catch {
        await ctx.io.stdout.write(`logger: ${fromFile}: No such file or directory\n`);
        return 1;
      }
      messages = content.split('\n').filter((l) => l.length > 0);
    } else {
      if (args.length === 0) {
        await ctx.io.stdout.write('Usage: logger [options] [<message>]\n');
        return 1;
      }
      let msg = msgParts.join(' ');
      if (expandNewlines) msg = msg.replace(/\\n/g, '\n');
      if (msg.length > 2048) msg = msg.slice(0, 2048);
      messages = [msg];
    }

    const safeTag = tag.length > 255 ? tag.slice(0, 255) : tag;
    const echoed: string[] = [];
    for (const message of messages) {
      const result = logging.writeSyslog(priority, safeTag, message, includePid);
      if (!result.ok) {
        await ctx.io.stdout.write(`logger: unknown priority name: ${priority}\n`);
        return 1;
      }
      if (toStderr) echoed.push(result.line);
    }

    if (echoed.length > 0) await ctx.io.stdout.write(echoed.join('\n') + '\n');
    return 0;
  }
}
