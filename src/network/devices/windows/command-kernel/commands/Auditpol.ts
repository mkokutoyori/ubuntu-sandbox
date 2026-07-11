import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

/** Parse `/flag:"value"` and `/flag` tokens (auditpol's own CLI syntax). */
function parseAuditpolArgs(args: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const arg of args) {
    const m = /^\/(\w+):?"?([^"]*)"?$/.exec(arg);
    if (m) out[m[1].toLowerCase()] = m[2];
  }
  return out;
}

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
    if (args.length === 0) {
      await ctx.io.stdout.write('AuditPol.exe command not recognized. Use AuditPol /? for usage.\n');
      return 1;
    }

    const sub = args[0].toLowerCase();
    const opts = parseAuditpolArgs(args.slice(1));

    if (sub === '/set') {
      const subcategory = opts['subcategory'];
      if (!subcategory) {
        await ctx.io.stdout.write('The subcategory was not found.\n');
        return 1;
      }
      const changes: { success?: boolean; failure?: boolean } = {};
      if (opts['success'] !== undefined) changes.success = opts['success'].toLowerCase() === 'enable';
      if (opts['failure'] !== undefined) changes.failure = opts['failure'].toLowerCase() === 'enable';
      ctx.machine.auditPolicy.set(subcategory, changes);
      await ctx.io.stdout.write('The command was successfully executed.\n');
      return EXIT_OK;
    }

    if (sub === '/get') {
      const subcategory = opts['subcategory'];
      if (!subcategory) {
        await ctx.io.stdout.write('The category was not found.\n');
        return 1;
      }
      const setting = ctx.machine.auditPolicy.get(subcategory);
      if (!setting) {
        await ctx.io.stdout.write(`The subcategory "${subcategory}" was not found.\n`);
        return 1;
      }
      const label = setting.success && setting.failure ? 'Success and Failure'
        : setting.success ? 'Success' : setting.failure ? 'Failure' : 'No Auditing';
      await ctx.io.stdout.write([
        'System audit policy',
        'Category/Subcategory                     Setting',
        `  ${subcategory.padEnd(40)}${label}`,
      ].join('\n') + '\n');
      return EXIT_OK;
    }

    await ctx.io.stdout.write('AuditPol.exe command not recognized. Use AuditPol /? for usage.\n');
    return 1;
  }
}
