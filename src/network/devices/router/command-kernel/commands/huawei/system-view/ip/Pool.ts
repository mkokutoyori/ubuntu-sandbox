import type { CommandContext, CommandDescriptor } from '@/command-kernel/command/types';
import { PushModeCommand } from '@/command-kernel/cli/commands/mode-transition';
import type { CliSession } from '@/command-kernel/cli';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { RouterMachineApi } from '../../../../RouterMachineApi';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `ip pool <name>` (Huawei VRP, system-view) — push mode vers
 * `dhcp-pool-view`. Le pool est identifié par son nom, stocké dans
 * `promptFields['selectedPool']` (utilisé par le prompt et par les
 * feuilles `network`, `gateway-list`, `dns-list`, `domain-name`).
 * L'existence effective du pool côté MachineApi sera synchronisée
 * quand un setter `createDhcpPool` sera ajouté — pour l'instant on
 * accepte le push (le vrai VRP crée le pool à l'entrée dans la vue).
 */
export class HuaweiRouterSysIpPoolCommand extends PushModeCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'pool',
    summary: 'Enter or create a DHCP address pool',
    usage: 'ip pool <name>',
    args: [
      { name: 'poolName', type: 'string', required: true, description: 'pool name' },
    ],
    options: [],
    privileges: OP,
    category: 'cli-mode',
  };
  readonly allowedModes = ['system-view'];

  protected async prepare(ctx: CommandContext): Promise<boolean> {
    const name = ctx.args.get<string>('poolName');
    if (!name) {
      await ctx.io.stderr.write("Error: Incomplete command found at '^' position.\n");
      return false;
    }
    (ctx.machine as RouterMachineApi).ensureDhcpPool(name);
    (ctx.session as CliSession).promptFields.set('selectedPool', name);
    return true;
  }

  protected targetMode(_ctx: CommandContext): string {
    return 'dhcp-pool-view';
  }
}
