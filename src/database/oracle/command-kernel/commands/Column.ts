import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { ColumnFormat } from '../../commands/SQLPlusSession';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/**
 * `COLUMN [col [FORMAT fmt] [HEADING texte] [CLEAR]]` (alias `COL`) — nu,
 * liste les formats de colonne déjà définis (silencieux si aucun) ; avec un
 * nom de colonne, positionne/efface son format. Mutation déléguée à
 * `machine.oracle.setColumnFormat`/`clearColumnFormat` (partagée avec le
 * legacy `SQLPlusSession.handleColumn`).
 */
export class SqlPlusColumnCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'COLUMN',
    aliases: ['COL'],
    summary: 'Définit ou affiche un format de colonne',
    usage: 'COLUMN [col [FORMAT fmt] [HEADING texte] [CLEAR]]',
    args: [
      { name: 'rest', type: 'string', required: false, variadic: true, description: 'nom de colonne et options, vide pour tout lister' },
    ],
    options: [],
    privileges: ANY,
    category: 'sqlplus',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const oracle = ctx.machine.oracle!;
    const parts = ctx.args.get<string[] | undefined>('rest') ?? [];
    const args = parts.join(' ');

    if (!args) {
      const out: string[] = [];
      for (const [, fmt] of oracle.columnFormats()) {
        const line: string[] = [`COLUMN   ${fmt.name}`];
        if (fmt.format) line.push(`FORMAT   ${fmt.format}`);
        if (fmt.heading) line.push(`HEADING  '${fmt.heading}'`);
        out.push(line.join(' '));
      }
      if (out.length > 0) await ctx.io.stdout.write(out.join('\n') + '\n');
      return EXIT_OK;
    }

    const colName = parts[0].toUpperCase();
    const upper = args.toUpperCase();

    if (upper.includes(' CLEAR')) {
      oracle.clearColumnFormat(colName);
      return EXIT_OK;
    }

    const fmt: ColumnFormat = oracle.columnFormats().get(colName) ?? { name: colName };

    const fmtMatch = args.match(/FORMAT\s+(\S+)/i);
    if (fmtMatch) fmt.format = fmtMatch[1];

    const headMatch = args.match(/HEADING\s+'([^']+)'/i) || args.match(/HEADING\s+"([^"]+)"/i) || args.match(/HEADING\s+(\S+)/i);
    if (headMatch) fmt.heading = headMatch[1];

    if (/(^|\s)NOPRINT(\s|$)/i.test(args)) fmt.noprint = true;
    if (/(^|\s)PRINT(\s|$)/i.test(args)) fmt.noprint = false;

    if (fmt.format) {
      const aMatch = fmt.format.match(/^A(\d+)$/i);
      if (aMatch) {
        fmt.width = parseInt(aMatch[1]);
      } else if (/^[$]?[09,.]+$/.test(fmt.format)) {
        fmt.width = fmt.format.length;
      }
    }

    oracle.setColumnFormat(colName, fmt);
    return EXIT_OK;
  }
}
