import { ParsedArgs } from '@/command-kernel/args/parsed-args';
import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { UsageError } from '@/command-kernel/errors';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { readTextInput, splitLines } from './textInput';

function parseRanges(spec: string, max: number): number[] {
  const indices = new Set<number>();
  for (const part of spec.split(',')) {
    const range = /^(\d*)-(\d*)$/.exec(part);
    if (range) {
      const start = range[1] ? parseInt(range[1], 10) : 1;
      const end = range[2] ? parseInt(range[2], 10) : max;
      for (let i = start; i <= end; i++) indices.add(i);
    } else {
      const n = parseInt(part, 10);
      if (Number.isNaN(n)) throw new UsageError(`sélection invalide : ${part}`);
      indices.add(n);
    }
  }
  return [...indices].sort((a, b) => a - b);
}

export class CutCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'cut',
    summary: 'Extrait des colonnes d\'un fichier ou de l\'entrée standard',
    usage: 'cut -d DELIM -f CHAMPS | -c PLAGE | -b PLAGE [-s] [--complement] [--output-delimiter=D] [fichier...]',
    args: [{ name: 'files', type: 'path', required: false, variadic: true, description: 'fichiers à traiter' }],
    options: [
      { long: 'delimiter', short: 'd', takesValue: true, type: 'string', defaultValue: '\t', description: 'délimiteur de champ' },
      { long: 'fields', short: 'f', takesValue: true, type: 'string', description: 'champs à extraire, ex: 1,3 ou 1-3' },
      { long: 'characters', short: 'c', takesValue: true, type: 'string', description: 'caractères à extraire' },
      { long: 'bytes', short: 'b', takesValue: true, type: 'string', description: 'octets à extraire' },
      { long: 'only-delimited', short: 's', takesValue: false, description: 'ignore les lignes sans délimiteur' },
      { long: 'complement', takesValue: false, description: 'inverse la sélection' },
      { long: 'output-delimiter', takesValue: true, type: 'string', description: 'délimiteur de sortie' },
    ],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'texte',
  };

  protected override validate(args: ParsedArgs): void {
    if (!args.has('fields') && !args.has('characters') && !args.has('bytes')) {
      throw new UsageError('une option -f, -c ou -b est requise');
    }
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const files = ctx.args.has('files') ? ctx.args.get<string[]>('files') : [];
    const delimiter = ctx.args.get<string>('delimiter') || '\t';
    const onlyDelimited = ctx.args.flag('only-delimited');
    const complement = ctx.args.flag('complement');
    const outputDelimiter = ctx.args.has('output-delimiter') ? ctx.args.get<string>('output-delimiter') : delimiter;

    const mode: 'field' | 'char' = ctx.args.has('fields') ? 'field' : 'char';
    const rangeSpec = ctx.args.has('fields')
      ? ctx.args.get<string>('fields')
      : ctx.args.has('characters')
        ? ctx.args.get<string>('characters')
        : ctx.args.get<string>('bytes');

    const content = await readTextInput(ctx, files);
    const { lines } = splitLines(content);
    const output: string[] = [];
    for (const line of lines) {
      if (mode === 'field') {
        if (!line.includes(delimiter)) {
          if (onlyDelimited) continue;
          output.push(line);
          continue;
        }
        const columns = line.split(delimiter);
        const ranges = parseRanges(rangeSpec, columns.length);
        const keep = complement
          ? columns.map((_, i) => i + 1).filter((n) => !ranges.includes(n))
          : ranges.filter((n) => n <= columns.length);
        output.push(keep.map((i) => columns[i - 1] ?? '').join(outputDelimiter));
      } else {
        const ranges = parseRanges(rangeSpec, line.length);
        const keep = complement
          ? Array.from({ length: line.length }, (_, i) => i + 1).filter((n) => !ranges.includes(n))
          : ranges;
        output.push(keep.map((i) => line.charAt(i - 1) ?? '').join(''));
      }
    }

    await ctx.io.stdout.write(output.length ? output.join('\n') + '\n' : '');
    return EXIT_OK;
  }
}
