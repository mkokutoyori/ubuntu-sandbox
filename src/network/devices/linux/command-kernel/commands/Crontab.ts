import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/**
 * `crontab [-l|-r|-e|-u USER] [fichier]` — délègue à
 * `machine.cronTab.crontab` (`handleCrontab`, déjà public — porte lui-même
 * la validation `cron.allow`/`cron.deny`, la résolution d'utilisateur cible
 * et la synchronisation spool VFS/syslog). `-u AUTRE_UTILISATEUR` par un
 * non-root est refusé ici (message vendeur exact) — cette règle vit dans
 * la couche déclarative legacy, pas dans `handleCrontab` lui-même.
 */
export class CrontabCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'crontab',
    summary: 'Gère les tâches planifiées cron de l\'utilisateur',
    usage: 'crontab [-l|-r|-e|-u USER] [fichier]',
    args: [
      { name: 'rest', type: 'string', required: false, variadic: true, description: '-l/-r/-e/-u USER, fichier' },
    ],
    options: [],
    privileges: ANY,
    category: 'linux',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.get<string[] | undefined>('rest') ?? [];
    const uFlag = args.indexOf('-u');
    if (uFlag >= 0 && (args[uFlag + 1] ?? '') !== ctx.session.user.name && !ctx.session.user.isRoot()) {
      await ctx.io.stdout.write('crontab: must be privileged to use -u\n');
      return 1;
    }
    const stdin = args.includes('-') ? await ctx.io.stdin.readAll() : undefined;
    const { output, exitCode } = ctx.machine.cronTab!.crontab(args, stdin);
    if (output) await ctx.io.stdout.write(output + '\n');
    return exitCode;
  }
}
