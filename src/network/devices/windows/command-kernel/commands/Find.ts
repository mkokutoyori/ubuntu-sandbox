import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { toFileSystemActor } from '@/command-kernel/machine/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

function parseFindArgs(tokens: string[]): { searchString: string; ignoreCase: boolean; countOnly: boolean; invertMatch: boolean; showLineNumbers: boolean; files: string[] } {
  let ignoreCase = false;
  let countOnly = false;
  let invertMatch = false;
  let showLineNumbers = false;
  let searchString = '';
  const files: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const lower = tokens[i].toLowerCase();
    if (lower === '/i') { ignoreCase = true; continue; }
    if (lower === '/c') { countOnly = true; continue; }
    if (lower === '/v') { invertMatch = true; continue; }
    if (lower === '/n') { showLineNumbers = true; continue; }
    if (!searchString && tokens[i].startsWith('"')) {
      let str = tokens[i].substring(1);
      while (i < tokens.length - 1 && !str.endsWith('"')) { i++; str += ' ' + tokens[i]; }
      if (str.endsWith('"')) str = str.slice(0, -1);
      searchString = str;
      continue;
    }
    if (!searchString) { searchString = tokens[i]; continue; }
    files.push(tokens[i]);
  }

  return { searchString, ignoreCase, countOnly, invertMatch, showLineNumbers, files };
}

export class FindCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'find',
    summary: 'Recherche une chaîne littérale dans des fichiers',
    usage: 'find [/i] [/v] [/c] [/n] "chaîne" fichier...',
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: 'options, motif et fichiers' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'texte',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const tokens = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : [];
    const { searchString, ignoreCase, countOnly, invertMatch, showLineNumbers, files } = parseFindArgs(tokens);

    if (!searchString || files.length === 0) {
      await ctx.io.stdout.write('FIND: Parameter format not correct\n');
      return 1;
    }

    const actor = toFileSystemActor(ctx.session.user);
    const lines: string[] = [];
    let found = false;

    for (const fp of files) {
      const abs = ctx.machine.fs.resolve(ctx.session.cwd, fp);
      let content: string;
      try {
        content = await ctx.machine.fs.readFile(abs, actor);
      } catch {
        lines.push(`File not found - ${fp}`);
        continue;
      }

      lines.push(`---------- ${fp.toUpperCase()}`);
      const fileLines = content.split('\n');
      let count = 0;
      for (let n = 0; n < fileLines.length; n++) {
        const line = fileLines[n];
        const haystack = ignoreCase ? line.toLowerCase() : line;
        const needle = ignoreCase ? searchString.toLowerCase() : searchString;
        const match = invertMatch ? !haystack.includes(needle) : haystack.includes(needle);
        if (match) {
          found = true;
          count++;
          if (!countOnly) lines.push(showLineNumbers ? `[${n + 1}]${line}` : line);
        }
      }
      if (countOnly) lines.push(`---------- ${fp.toUpperCase()}: ${count}`);
    }

    await ctx.io.stdout.write(lines.join('\n') + '\n');
    return found ? EXIT_OK : 1;
  }
}
