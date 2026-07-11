import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

export class AuditpolCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'auditpol',
    aliases: ['auditpol.exe'],
    summary: 'Affiche ou modifie la politique d\'audit de sécurité',
    usage: 'auditpol /get|/set [options]',
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: 'sous-commande auditpol' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : [];
    if (!ctx.machine.auditPolicy) {
      await ctx.io.stdout.write('AUDITPOL: not supported on this device\n');
      return 1;
    }
    const output = await ctx.machine.auditPolicy.execute(args);
    await ctx.io.stdout.write(output + '\n');
    return EXIT_OK;
  }
}
