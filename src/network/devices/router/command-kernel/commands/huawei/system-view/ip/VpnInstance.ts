import type { CommandContext, CommandDescriptor } from '@/command-kernel/command/types';
import type { CliSession } from '@/command-kernel/cli';
import { PushModeCommand } from '@/command-kernel/cli/commands/mode-transition';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `vpn-instance` — transition de mode (push vers `vpn-instance-view`).
 * `prepare()` peut refuser la transition (retourner false après avoir
 * écrit un message sur ctx.io.stderr) ou positionner des promptFields
 * (ex: interface sélectionnée) avant le push.
 */
export class HuaweiRouterSysIpVpnInstanceCommand extends PushModeCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'vpn-instance',
    summary: 'Enter or create an IP VPN instance (VRF)',
    usage: 'ip vpn-instance <name>',
    args: [
      { name: 'name', type: 'string', required: true, description: 'VRF name' },
    ],
    options: [],
    privileges: OP,
    category: 'cli-mode',
  };
  readonly allowedModes = ['system-view'];

    protected async prepare(ctx: CommandContext): Promise<boolean> {
    const value = ctx.args.get<string>('name');
    if (value === undefined || value === null || value === '') {
      await ctx.io.stderr.write("Error: Incomplete command found at '^' position.\n");
      return false;
    }
    (ctx.session as CliSession).promptFields.set('selectedVpnInstance', String(value));
    return true;
  }

  protected targetMode(_ctx: CommandContext): string {
    return 'vpn-instance-view';
  }
}
