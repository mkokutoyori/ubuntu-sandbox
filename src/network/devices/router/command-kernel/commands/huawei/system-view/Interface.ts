import type { CommandContext, CommandDescriptor } from '@/command-kernel/command/types';
import { PushModeCommand } from '@/command-kernel/cli';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { CliSession } from '@/command-kernel/cli';
import { resolveHuaweiInterfaceName } from '../../../../../shells/cli-utils';
import type { RouterMachineApi } from '../../../RouterMachineApi';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `interface <name>` (Huawei VRP, mode system-view) — commande de PUSH
 * de mode : entre en `interface-view` et pré-sélectionne l'interface.
 *
 * L'interface est stockée dans `session.promptFields['selectedInterface']`
 * — le mode `interface-view` définit `clearOnExit: ['selectedInterface']`
 * donc `quit` la nettoie automatiquement.
 *
 * Résolution VRP : accepte les alias vendeur (`gi0/0/0`, `ge0/0/0`,
 * `GigabitEthernet0/0/0`) via `resolveHuaweiInterfaceName` — util pur
 * partagé, pas un formateur legacy. Refuse la transition avec le message
 * VRP exact si l'interface n'existe pas.
 */
export class HuaweiRouterInterfaceCommand extends PushModeCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'interface',
    summary: 'Enter interface view',
    usage: 'interface <name>',
    args: [{ name: 'name', type: 'string', required: true, description: 'Interface name (e.g. GigabitEthernet0/0/0)' }],
    options: [],
    privileges: OP,
    category: 'cli-mode',
  };
  readonly allowedModes = ['system-view'];

  protected async prepare(ctx: CommandContext): Promise<boolean> {
    const machine = ctx.machine as RouterMachineApi;
    const name = ctx.args.get<string>('name');
    if (!name) {
      await ctx.io.stderr.write("Error: Incomplete command found at '^' position.\n");
      return false;
    }
    const portNames = machine.router.interfaces().map((info) => info.name);
    const resolved = resolveHuaweiInterfaceName(portNames, name);
    if (!resolved) {
      await ctx.io.stderr.write("Error: Wrong parameter found at '^' position.\n");
      return false;
    }
    (ctx.session as CliSession).promptFields.set('selectedInterface', resolved);
    return true;
  }

  protected targetMode(): string {
    return 'interface-view';
  }
}
