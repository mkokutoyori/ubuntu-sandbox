import type { CommandContext, CommandDescriptor } from '@/command-kernel/command/types';
import { PushModeCommand } from '@/command-kernel/cli/commands/mode-transition';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { CliSession } from '@/command-kernel/cli';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `router {ospf <pid>|rip|eigrp <as>|bgp <as>}` (Cisco IOS, config).
 * Push vers config-router. Protocole et id stockés dans promptFields.
 */
export class CiscoRouterConfigRouterCommand extends PushModeCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'router', summary: 'Enable a dynamic routing protocol',
    usage: 'router {ospf <pid>|rip|eigrp <as>|bgp <as>}',
    args: [
      { name: 'proto', type: 'string', required: true, description: 'Protocol (ospf|rip|eigrp|bgp)' },
      { name: 'id', type: 'int', required: false, description: 'Process/AS id' },
    ],
    options: [], privileges: OP, category: 'cli-mode',
  };
  readonly allowedModes = ['config'];

  protected async prepare(ctx: CommandContext): Promise<boolean> {
    const proto = (ctx.args.get<string>('proto') ?? '').toLowerCase();
    const id = ctx.args.get<number | undefined>('id');
    if (!['ospf', 'rip', 'eigrp', 'bgp'].includes(proto)) {
      await ctx.io.stderr.write("% Invalid input detected at '^' marker.\n");
      return false;
    }
    if (proto !== 'rip' && (id === undefined || !Number.isInteger(id) || id < 1)) {
      await ctx.io.stderr.write("% Invalid input detected at '^' marker.\n");
      return false;
    }
    const fields = (ctx.session as CliSession).promptFields;
    fields.set('routerProto', proto);
    fields.set('routerId', id !== undefined ? String(id) : '');
    return true;
  }

  protected targetMode(): string { return 'config-router'; }
}
