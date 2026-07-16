import type { CommandContext, CommandDescriptor } from '@/command-kernel/command/types';
import type { CliSession } from '@/command-kernel/cli';
import { PushModeCommand } from '@/command-kernel/cli/commands/mode-transition';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `Vlanif` — transition de mode (push vers `interface-view`).
 * `prepare()` peut refuser la transition (retourner false après avoir
 * écrit un message sur ctx.io.stderr) ou positionner des promptFields
 * (ex: interface sélectionnée) avant le push.
 */
export class HuaweiSwitchInterfaceVlanifCommand extends PushModeCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'Vlanif',
    summary: 'Enter or create the Vlanif <id> SVI',
    usage: 'interface Vlanif <id>',
    args: [
      { name: 'id', type: 'int', required: true, description: 'VLAN id' },
    ],
    options: [],
    privileges: OP,
    category: 'cli-mode',
  };
  readonly allowedModes = ['system-view'];

  protected async prepare(ctx: CommandContext): Promise<boolean> {
    const id = ctx.args.get<number>('id');
    if (!Number.isInteger(id) || id < 1 || id > 4094) {
      await ctx.io.stderr.write("Error: Wrong parameter found at '^' position.\n");
      return false;
    }
    // Le vrai VRP crée l'SVI à l'entrée si absente ; on stocke juste
    // le nom canonique `Vlanif<id>` — un futur setter switch.createSvi
    // matérialisera le port associé au VLAN correspondant.
    (ctx.session as CliSession).promptFields.set('selectedInterface', `Vlanif${id}`);
    return true;
  }

  protected targetMode(_ctx: CommandContext): string {
    return 'interface-view';
  }
}
