import type { CommandContext, CommandDescriptor } from '@/command-kernel/command/types';
import { PushModeCommand } from '@/command-kernel/cli';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { CliSession } from '@/command-kernel/cli';
import type { RouterMachineApi } from '../../../RouterMachineApi';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `interface <name>` (Cisco IOS, mode config) — commande de PUSH de
 * mode : entre en config-if et pré-sélectionne l'interface.
 *
 * L'interface est stockée dans `session.promptFields['selectedInterface']`
 * — le mode `config-if` définit `clearOnExit: ['selectedInterface']`
 * donc l'`exit` la nettoie automatiquement.
 *
 * Si l'interface n'existe pas, refuse la transition avec le message
 * vendeur Cisco.
 */
export class CiscoRouterInterfaceCommand extends PushModeCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'interface',
    summary: 'Select an interface to configure',
    usage: 'interface <name>',
    args: [{ name: 'name', type: 'string', required: true, description: 'Interface name (e.g. GigabitEthernet0/0)' }],
    options: [],
    privileges: OP,
    category: 'cli-mode',
  };
  readonly allowedModes = ['config'];

  protected async prepare(ctx: CommandContext): Promise<boolean> {
    const machine = ctx.machine as RouterMachineApi;
    const name = ctx.args.get<string>('name');
    if (!name) {
      await ctx.io.stderr.write('% Incomplete command.\n');
      return false;
    }
    if (!machine.router.interface(name)) {
      await ctx.io.stderr.write("% Invalid input detected at '^' marker.\n");
      return false;
    }
    (ctx.session as CliSession).promptFields.set('selectedInterface', name);
    return true;
  }

  protected targetMode(): string {
    return 'config-if';
  }
}
