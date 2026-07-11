import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

function sortedEnvLines(env: Map<string, string>, prefix = ''): string[] {
  return Array.from(env.entries())
    .filter(([key]) => key.toUpperCase().startsWith(prefix))
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, value]) => `${key}=${value}`);
}

export class SetCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'set',
    summary: 'Affiche ou définit une variable d\'environnement',
    usage: 'set [NAME=valeur]',
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: 'NAME=valeur ou préfixe' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'session',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const targets = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : [];
    if (targets.length === 0) {
      await ctx.io.stdout.write(sortedEnvLines(ctx.session.env).join('\n') + '\n');
      return EXIT_OK;
    }

    const full = targets.join(' ');
    const eqIndex = full.indexOf('=');
    if (eqIndex === -1) {
      const lines = sortedEnvLines(ctx.session.env, full.toUpperCase());
      if (lines.length === 0) {
        await ctx.io.stdout.write(`Environment variable ${full} not defined\n`);
        return 1;
      }
      await ctx.io.stdout.write(lines.join('\n') + '\n');
      return EXIT_OK;
    }

    const name = full.substring(0, eqIndex).trim();
    const value = full.substring(eqIndex + 1);
    ctx.session.env.set(name.toUpperCase(), value);
    return EXIT_OK;
  }
}
