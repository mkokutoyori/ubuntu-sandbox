import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { RouterMachineApi } from '../../../../RouterMachineApi';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/**
 * `pool` — TODO: une ligne d'intention métier.
 * Commande feuille standalone : `ctx.machine` est l'unique source de données, formatage inline.
 */
export class HuaweiRouterDisplayIpPoolCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'pool',
    summary: 'Display DHCP pool(s)',
    usage: 'display ip pool [<name>]',
    args: [
      { name: 'poolName', type: 'string', required: false, description: 'optional pool name' },
    ],
    options: [],
    privileges: ANY,
    category: 'router',
  };
  readonly allowedModes = ['user-view', 'system-view'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as RouterMachineApi;
    const filter = ctx.args.get<string | undefined>('poolName');
    const names = machine.dhcpPoolNames().filter((n) => !filter || n === filter);
    if (names.length === 0) {
      await ctx.io.stderr.write(
        filter ? `Error: The pool does not exist.\n` : `No IP pool configured.\n`,
      );
      return filter ? 1 : 0;
    }
    const lines: string[] = [];
    for (const n of names) {
      lines.push(`  Pool-name        : ${n}`);
      lines.push(`  Pool-No          : 0`);
      lines.push(`  Position         : Local`);
      lines.push(`  Status           : Unlocked`);
      lines.push('');
    }
    await ctx.io.stdout.write(lines.join('\n'));
    return EXIT_OK;
  }
}
