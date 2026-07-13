import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

/**
 * `locale` — affiche les paramètres régionaux actifs, dérivés de
 * l'environnement de la session (`LANG`/`LC_ALL`/`LC_*`). Chaque catégorie
 * non définie retombe sur la locale effective (`LC_ALL` sinon `LANG` sinon
 * `C`), comme le legacy.
 */
export class LocaleCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'locale',
    summary: 'Affiche les paramètres régionaux',
    usage: 'locale [OPTION...]',
    args: [{ name: 'operands', type: 'string', required: false, variadic: true, description: 'ignoré' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const e = ctx.session.env;
    const lang = e.get('LANG') ?? '';
    const lcAll = e.get('LC_ALL') ?? '';
    const effective = lcAll || lang || 'C';
    const cat = (name: string) => `${name}="${e.get(name) ?? effective}"`;

    const lines = [
      `LANG=${lang}`,
      `LANGUAGE=${e.get('LANGUAGE') ?? ''}`,
      cat('LC_CTYPE'),
      cat('LC_NUMERIC'),
      cat('LC_TIME'),
      cat('LC_COLLATE'),
      cat('LC_MONETARY'),
      cat('LC_MESSAGES'),
      cat('LC_PAPER'),
      cat('LC_NAME'),
      cat('LC_ADDRESS'),
      cat('LC_TELEPHONE'),
      cat('LC_MEASUREMENT'),
      cat('LC_IDENTIFICATION'),
      `LC_ALL=${lcAll}`,
    ];
    await ctx.io.stdout.write(lines.join('\n') + '\n');
    return EXIT_OK;
  }
}
