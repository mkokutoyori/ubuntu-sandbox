import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

export class UmaskCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'umask',
    summary: 'Affiche ou modifie le masque de permissions par défaut',
    usage: 'umask [masque octal]',
    args: [
      { name: 'mask', type: 'string', required: false, description: 'nouveau masque en octal' },
    ],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'fichiers',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    if (!ctx.machine.permissions) return EXIT_OK;
    if (!ctx.args.has('mask')) {
      const current = await ctx.machine.permissions.getUmask();
      await ctx.io.stdout.write(current.toString(8).padStart(4, '0') + '\n');
      return EXIT_OK;
    }
    const raw = ctx.args.get<string>('mask');
    const newMask = parseInt(raw, 8);
    if (isNaN(newMask)) {
      await ctx.io.stdout.write(`umask: ${raw}: invalid octal number\n`);
      return EXIT_OK;
    }
    await ctx.machine.permissions.setUmask(newMask);
    return EXIT_OK;
  }
}
