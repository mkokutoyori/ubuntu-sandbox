import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { toFileSystemActor } from '@/command-kernel/machine/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { reportLegacyFsError } from './legacyFsError';

/** Parses `/i /v /c /c:"..." "quoted pattern" bareword...` — bareword
 *  tokens are OR'd literal patterns (real findstr semantics without `/r`). */
function parseFindstrArgs(tokens: string[]): { patterns: string[]; ignoreCase: boolean; invert: boolean; count: boolean; files: string[] } {
  let ignoreCase = false;
  let invert = false;
  let count = false;
  let cLiteral: string | null = null;
  const positional: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const lower = t.toLowerCase();
    if (lower === '/i') { ignoreCase = true; continue; }
    if (lower === '/v') { invert = true; continue; }
    if (lower === '/c') { count = true; continue; }
    if (/^\/c:/i.test(t)) { cLiteral = t.slice(3).replace(/^"|"$/g, ''); continue; }
    if (t.startsWith('"')) {
      let str = t.slice(1);
      while (i < tokens.length - 1 && !str.endsWith('"')) { i++; str += ' ' + tokens[i]; }
      if (str.endsWith('"')) str = str.slice(0, -1);
      positional.push(str);
      continue;
    }
    positional.push(t);
  }

  if (cLiteral !== null) return { patterns: [cLiteral], ignoreCase, invert, count, files: positional };
  const [pattern, ...files] = positional;
  return { patterns: pattern !== undefined ? [pattern] : [], ignoreCase, invert, count, files };
}

export class FindstrCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'findstr',
    summary: 'Recherche une chaîne dans des fichiers ou l\'entrée standard',
    usage: 'findstr [/i] [/v] [/n] [/c] <motif> [fichier...]',
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: 'options et motif' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'texte',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const tokens = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : [];
    const showLineNumbers = tokens.some((t) => t.toLowerCase() === '/n');
    const rest = tokens.filter((t) => t.toLowerCase() !== '/n');
    const { patterns, ignoreCase, invert, count, files } = parseFindstrArgs(rest);

    if (patterns.length === 0) {
      await ctx.io.stdout.write('FINDSTR: Wrong number of arguments\n');
      return 1;
    }

    const matches = (line: string): boolean => {
      const haystack = ignoreCase ? line.toLowerCase() : line;
      const found = patterns.some((p) => haystack.includes(ignoreCase ? p.toLowerCase() : p));
      return invert ? !found : found;
    };

    const actor = toFileSystemActor(ctx.session.user);
    const sources: Array<{ label: string; content: string }> = [];
    if (files.length === 0) {
      sources.push({ label: '', content: await ctx.io.stdin.readAll() });
    } else {
      for (const f of files) {
        const abs = ctx.machine.fs.resolve(ctx.session.cwd, f);
        try {
          sources.push({ label: f, content: await ctx.machine.fs.readFile(abs, actor) });
        } catch (err) {
          return reportLegacyFsError(ctx, err);
        }
      }
    }

    const lines: string[] = [];
    let anyMatch = false;
    for (const { label, content } of sources) {
      const contentLines = content.length === 0 ? [] : content.split('\n');
      let fileCount = 0;
      contentLines.forEach((line, i) => {
        if (!matches(line)) return;
        anyMatch = true;
        fileCount++;
        if (!count) {
          const prefix = [files.length > 1 ? `${label}:` : '', showLineNumbers ? `${i + 1}:` : ''].join('');
          lines.push(prefix + line);
        }
      });
      if (count) lines.push(files.length > 1 ? `${label}:${fileCount}` : String(fileCount));
    }

    await ctx.io.stdout.write(lines.join('\n') + (lines.length ? '\n' : ''));
    return anyMatch ? EXIT_OK : 1;
  }
}
