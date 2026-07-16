import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/**
 * `USERACT [utilisateur]` — inspecte le `UserActivityTracker` : sans
 * argument, liste tous les utilisateurs suivis ; avec un nom, filtre sur
 * cet utilisateur. Lecture pure via `machine.oracle.userActivityStats`
 * (partagée avec le legacy `handleUserAct`).
 */
export class SqlPlusUseractCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'USERACT',
    summary: 'Inspecte les statistiques d\'activité utilisateur',
    usage: 'USERACT [utilisateur]',
    args: [
      { name: 'rest', type: 'string', required: false, variadic: true, description: 'utilisateur à filtrer, vide pour tous' },
    ],
    options: [],
    privileges: ANY,
    category: 'sqlplus',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const oracle = ctx.machine.oracle!;
    const arg = (ctx.args.get<string[] | undefined>('rest') ?? []).join(' ').replace(/;\s*$/, '').trim().toUpperCase();

    const all = oracle.userActivityStats();
    const rows = arg ? all.filter((s) => s.username === arg) : all;

    if (rows.length === 0) {
      await ctx.io.stdout.write((arg ? `No activity recorded for ${arg}.` : 'No user activity recorded yet.') + '\n');
      return EXIT_OK;
    }

    const out: string[] = ['USER       LOGONS  FAILED  PWD_CHG  LOCKS  LAST_LOGON               LAST_LOGOFF             TOTAL_SECS'];
    out.push('---------- ------- ------- -------- ------ ------------------------ ------------------------ ----------');
    const fmt = (d: Date | null) => (d ? d.toISOString().slice(0, 19).replace('T', ' ') : '                   ');
    for (const s of rows) {
      out.push(
        `${s.username.padEnd(10)} ${String(s.logonCount).padStart(7)} ${String(s.failedLogonCount).padStart(7)} ${String(s.passwordChangeCount).padStart(8)} ${String(s.lockEvents).padStart(6)} ${fmt(s.lastLogonAt).padEnd(24)} ${fmt(s.lastLogoffAt).padEnd(24)} ${String(s.totalSessionSeconds).padStart(10)}`,
      );
    }
    await ctx.io.stdout.write(out.join('\n') + '\n');
    return EXIT_OK;
  }
}
