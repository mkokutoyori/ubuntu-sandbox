import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/**
 * `ARCHIVE LOG LIST` — affiche le mode d'archivage et les journaux de
 * redo. Le verbe reconnu par `recognizeSqlPlusKernelVerb` est `ARCHIVE`
 * (premier mot) ; ce descripteur garde donc `name: 'ARCHIVE'` — seule la
 * forme `ARCHIVE LOG LIST` est reconnue (voir `VERB_FAMILIES.ARCHIVE`),
 * le reste absorbé par l'argument variadique ignoré. Lecture pure via
 * `machine.oracle.archiveLogInfo`/`allParameters` (partagée avec le
 * legacy `handleArchiveLogList`).
 */
export class SqlPlusArchiveLogListCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'ARCHIVE',
    summary: 'Affiche le mode d\'archivage et les journaux de redo',
    usage: 'ARCHIVE LOG LIST',
    args: [
      { name: 'rest', type: 'string', required: false, variadic: true, description: 'toujours "LOG LIST" (parité vendeur)' },
    ],
    options: [],
    privileges: ANY,
    category: 'sqlplus',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const oracle = ctx.machine.oracle!;
    const params = oracle.allParameters();
    const dest = params?.get('log_archive_dest') ?? params?.get('log_archive_dest_1') ?? 'USE_DB_RECOVERY_FILE_DEST';
    const format = params?.get('log_archive_format') ?? 'arch_%t_%s_%r.arc';

    const { archiveLogMode, redoLogGroups } = oracle.archiveLogInfo();
    const current = redoLogGroups.find((g) => g.status === 'CURRENT') ?? redoLogGroups[0];
    const currentSeq = current?.sequence ?? 1;

    const lines = [
      `Database log mode              ${archiveLogMode ? 'Archive Mode' : 'No Archive Mode'}`,
      `Automatic archival             ${archiveLogMode ? 'Enabled' : 'Disabled'}`,
      `Archive destination            ${dest}`,
      `Archive format                 ${format}`,
      `Oldest online log sequence     ${Math.max(1, currentSeq - redoLogGroups.length + 1)}`,
    ];
    if (archiveLogMode) {
      lines.push(`Next log sequence to archive   ${currentSeq}`);
    }
    lines.push(`Current log sequence           ${currentSeq}`);

    await ctx.io.stdout.write(lines.join('\n') + '\n');
    return EXIT_OK;
  }
}
