import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { readPerFileInputs, splitLines } from './textInput';

export class GrepCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'grep',
    summary: 'Recherche un motif dans des fichiers ou l\'entrée standard',
    usage: 'grep [-i] [-v] [-n] [-c] [-E] <motif> [fichier...]',
    args: [
      { name: 'pattern', type: 'string', required: true, description: 'motif recherché' },
      { name: 'files', type: 'path', required: false, variadic: true, description: 'fichiers à parcourir' },
    ],
    options: [
      { long: 'ignore-case', short: 'i', takesValue: false, description: 'insensible à la casse' },
      { long: 'invert-match', short: 'v', takesValue: false, description: 'lignes ne correspondant pas' },
      { long: 'line-number', short: 'n', takesValue: false, description: 'préfixe le numéro de ligne' },
      { long: 'count', short: 'c', takesValue: false, description: 'affiche uniquement le nombre de correspondances' },
      { long: 'extended-regexp', short: 'E', takesValue: false, description: 'expression régulière étendue' },
    ],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'texte',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const pattern = ctx.args.get<string>('pattern');
    const files = ctx.args.has('files') ? ctx.args.get<string[]>('files') : [];
    const ignoreCase = ctx.args.flag('ignore-case');
    const invert = ctx.args.flag('invert-match');
    const lineNumbers = ctx.args.flag('line-number');
    const countOnly = ctx.args.flag('count');

    const regex = new RegExp(pattern, ignoreCase ? 'i' : undefined);
    const inputs = await readPerFileInputs(ctx, files);
    const multi = inputs.length > 1;
    let anyMatch = false;

    const lines: string[] = [];
    for (const { label, content } of inputs) {
      const contentLines = content.length === 0 ? [] : splitLines(content).lines;
      let count = 0;
      for (let i = 0; i < contentLines.length; i++) {
        const isMatch = regex.test(contentLines[i]);
        if (isMatch !== invert) {
          count++;
          anyMatch = true;
          if (!countOnly) {
            const prefix = [multi ? `${label}:` : '', lineNumbers ? `${i + 1}:` : ''].join('');
            lines.push(prefix + contentLines[i]);
          }
        }
      }
      if (countOnly) {
        lines.push(multi ? `${label}:${count}` : String(count));
      }
    }

    await ctx.io.stdout.write(lines.join('\n') + (lines.length ? '\n' : ''));
    return anyMatch ? 0 : 1;
  }
}
