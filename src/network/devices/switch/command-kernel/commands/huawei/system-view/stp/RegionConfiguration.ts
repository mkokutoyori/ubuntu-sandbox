import type { CommandContext, CommandDescriptor } from '@/command-kernel/command/types';
import { PushModeCommand } from '@/command-kernel/cli/commands/mode-transition';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `region-configuration` — transition de mode (push vers `mst-region-view`).
 * `prepare()` peut refuser la transition (retourner false après avoir
 * écrit un message sur ctx.io.stderr) ou positionner des promptFields
 * (ex: interface sélectionnée) avant le push.
 */
export class HuaweiSwitchSysStpRegionConfigurationCommand extends PushModeCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'region-configuration',
    summary: 'Enter MSTP region configuration view',
    usage: 'stp region-configuration',
    args: [],
    options: [],
    privileges: OP,
    category: 'cli-mode',
  };
  readonly allowedModes = ['system-view'];

  protected targetMode(_ctx: CommandContext): string {
    return 'mst-region-view';
  }
}
