import type { CommandContext, CommandDescriptor } from '@/command-kernel/command/types';
import { PushModeCommand } from '@/command-kernel/cli/commands/mode-transition';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `aaa` — transition de mode (push vers `aaa-view`).
 * `prepare()` peut refuser la transition (retourner false après avoir
 * écrit un message sur ctx.io.stderr) ou positionner des promptFields
 * (ex: interface sélectionnée) avant le push.
 */
export class HuaweiSwitchSysAaaCommand extends PushModeCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'aaa',
    summary: 'Enter AAA view (switch)',
    usage: 'aaa',
    args: [],
    options: [],
    privileges: OP,
    category: 'cli-mode',
  };
  readonly allowedModes = ['system-view'];

  protected async prepare(_ctx: CommandContext): Promise<boolean> {
    // TODO: valider les arguments / positionner ctx.session.promptFields.
    return true;
  }

  protected targetMode(_ctx: CommandContext): string {
    return 'aaa-view';
  }
}
