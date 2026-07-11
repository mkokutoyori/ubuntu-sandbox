import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { readTextInput, splitLines } from './textInput';

function comparisonKey(line: string, skipFields: number, ignoreCase: boolean): string {
  const withoutFields = skipFields > 0 ? line.split(/\s+/).slice(skipFields).join(' ') : line;
  return ignoreCase ? withoutFields.toLowerCase() : withoutFields;
}

export class UniqCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'uniq',
    summary: 'Supprime les lignes dupliquées consécutives',
    usage: 'uniq [-c] [-d] [-u] [-i] [-f N] [fichier]',
    args: [{ name: 'files', type: 'path', required: false, variadic: true, description: 'fichier à traiter' }],
    options: [
      { long: 'count', short: 'c', takesValue: false, description: 'préfixe chaque ligne par son nombre d\'occurrences' },
      { long: 'repeated', short: 'd', takesValue: false, description: 'affiche uniquement les lignes dupliquées' },
      { long: 'unique', short: 'u', takesValue: false, description: 'affiche uniquement les lignes non dupliquées' },
      { long: 'ignore-case', short: 'i', takesValue: false, description: 'compare sans tenir compte de la casse' },
      { long: 'skip-fields', short: 'f', takesValue: true, type: 'int', defaultValue: 0, description: 'ignore les N premiers champs pour la comparaison' },
    ],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'texte',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const files = ctx.args.has('files') ? [ctx.args.get<string[]>('files')[0]] : [];
    const countMode = ctx.args.flag('count');
    const onlyDup = ctx.args.flag('repeated');
    const onlyUniq = ctx.args.flag('unique');
    const ignoreCase = ctx.args.flag('ignore-case');
    const skipFields = ctx.args.get<number>('skip-fields');

    const content = await readTextInput(ctx, files);
    const { lines } = splitLines(content);

    const groups: Array<{ line: string; count: number }> = [];
    for (const line of lines) {
      const key = comparisonKey(line, skipFields, ignoreCase);
      const last = groups[groups.length - 1];
      if (last && comparisonKey(last.line, skipFields, ignoreCase) === key) last.count++;
      else groups.push({ line, count: 1 });
    }

    const filtered = groups.filter((g) => (onlyDup ? g.count > 1 : onlyUniq ? g.count === 1 : true));
    const output = filtered.map((g) => (countMode ? `${String(g.count).padStart(7)} ${g.line}` : g.line));

    await ctx.io.stdout.write(output.length ? output.join('\n') + '\n' : '');
    return EXIT_OK;
  }
}
