import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { FileAttributes, toFileSystemActor } from '@/command-kernel/machine/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const ATTR_KEY: Record<string, keyof FileAttributes> = { r: 'readOnly', a: 'archive', h: 'hidden', s: 'system' };

function formatAttrLine(attrs: FileAttributes, path: string): string {
  const a = attrs.archive ? 'A' : ' ';
  const s = attrs.system ? 'S' : ' ';
  const h = attrs.hidden ? 'H' : ' ';
  const r = attrs.readOnly ? 'R' : ' ';
  return `${a}  ${s}${h}${r}        ${path}`;
}

export class AttribCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'attrib',
    summary: "Affiche ou modifie les attributs de fichier",
    usage: 'attrib [+r|-r|+a|-a|+h|-h|+s|-s] [fichier]',
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: 'attributs et cible' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'fichiers',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const tokens = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : [];
    const actor = toFileSystemActor(ctx.session.user);
    const fs = ctx.machine.fs;
    if (!fs.getAttributes || !fs.setAttributes) {
      await ctx.io.stdout.write('ATTRIB: not supported on this device\n');
      return 1;
    }

    const changes: { -readonly [K in keyof FileAttributes]?: boolean } = {};
    const pathParts: string[] = [];
    for (const t of tokens) {
      const lower = t.toLowerCase();
      if (lower === '/s' || lower === '/d') continue;
      const setMatch = t.match(/^\+([rahsRAHS])$/);
      if (setMatch) { changes[ATTR_KEY[setMatch[1].toLowerCase()]] = true; continue; }
      const clearMatch = t.match(/^-([rahsRAHS])$/);
      if (clearMatch) { changes[ATTR_KEY[clearMatch[1].toLowerCase()]] = false; continue; }
      pathParts.push(t);
    }
    const target = pathParts.join(' ');

    if (Object.keys(changes).length === 0) {
      const abs = target ? ctx.machine.fs.resolve(ctx.session.cwd, target) : ctx.session.cwd;
      const stat = await ctx.machine.fs.stat(abs, actor).catch(() => null);
      if (!stat) {
        await ctx.io.stdout.write(`File not found - ${target}\n`);
        return 1;
      }
      if (stat.type === 'directory') {
        const entries = await ctx.machine.fs.list(abs, actor);
        const lines: string[] = [];
        for (const entry of entries) {
          const attrs = await fs.getAttributes(entry.path, actor);
          lines.push(formatAttrLine(attrs, entry.path));
        }
        await ctx.io.stdout.write(lines.join('\n') + '\n');
        return EXIT_OK;
      }
      const attrs = await fs.getAttributes(abs, actor);
      await ctx.io.stdout.write(formatAttrLine(attrs, abs) + '\n');
      return EXIT_OK;
    }

    if (!target) {
      await ctx.io.stdout.write('The syntax of the command is incorrect.\n');
      return 1;
    }
    const abs = ctx.machine.fs.resolve(ctx.session.cwd, target);
    if (!(await ctx.machine.fs.exists(abs, actor))) {
      await ctx.io.stdout.write(`File not found - ${target}\n`);
      return 1;
    }
    await fs.setAttributes(abs, changes, actor);
    return EXIT_OK;
  }
}
