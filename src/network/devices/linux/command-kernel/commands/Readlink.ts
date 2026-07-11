import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { FileSystemError } from '@/command-kernel/errors';
import { toFileSystemActor } from '@/command-kernel/machine/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

export class ReadlinkCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'readlink',
    summary: 'Affiche la cible d\'un lien symbolique',
    usage: 'readlink [-f|-e|-m] <cible...>',
    args: [
      { name: 'targets', type: 'path', required: true, variadic: true, description: 'liens symboliques' },
    ],
    options: [
      { long: 'canonicalize', short: 'f', takesValue: false, description: 'résout tous les liens rencontrés' },
      { long: 'canonicalize-existing', short: 'e', takesValue: false, description: 'comme -f, la cible finale doit exister' },
      { long: 'canonicalize-missing', short: 'm', takesValue: false, description: 'comme -f, sans exiger l\'existence' },
    ],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'fichiers',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const targets = ctx.args.get<string[]>('targets');
    const canonicalize = ctx.args.flag('canonicalize') || ctx.args.flag('canonicalize-existing') || ctx.args.flag('canonicalize-missing');
    const requireFinal = ctx.args.flag('canonicalize-existing');
    const actor = toFileSystemActor(ctx.session.user);

    const out: string[] = [];
    let failed = false;
    for (const target of targets) {
      const path = ctx.machine.fs.resolve(ctx.session.cwd, target);
      if (canonicalize) {
        const resolved = await ctx.machine.fs.realpath?.(path, actor, requireFinal);
        if (!resolved) { failed = true; continue; }
        out.push(resolved);
        continue;
      }
      try {
        out.push(await ctx.machine.fs.readlink(path, actor));
      } catch (err) {
        if (err instanceof FileSystemError) { failed = true; continue; }
        throw err;
      }
    }

    await ctx.io.stdout.write(out.length ? `${out.join('\n')}\n` : '');
    return failed && out.length === 0 ? 1 : 0;
  }
}
