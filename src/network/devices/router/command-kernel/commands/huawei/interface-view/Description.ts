import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { CliSession } from '@/command-kernel/cli';
import type { RouterMachineApi } from '../../../RouterMachineApi';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `description <text...>` (Huawei VRP, mode interface-view) — commande
 * FEUILLE standalone. Pose une description libre sur l'interface
 * sélectionnée. Tout le reste de la ligne est capturé comme description
 * (le VRP autorise les espaces). Silence VRP en cas de succès. `undo
 * description` retire la description (voir `undo/Description.ts`).
 */
export class HuaweiRouterIfDescriptionCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'description',
    summary: 'Set the interface description',
    usage: 'description <text>',
    args: [{ name: 'text', type: 'string', required: true, variadic: true, description: 'Description text (may include spaces)' }],
    options: [],
    privileges: OP,
    category: 'router',
  };
  readonly allowedModes = ['interface-view'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as RouterMachineApi;
    const iface = (ctx.session as CliSession).promptFields.get('selectedInterface');
    if (!iface) {
      await ctx.io.stderr.write("Error: No interface selected.\n");
      return 1;
    }
    const parts = ctx.args.get<string[]>('text') ?? [];
    if (parts.length === 0) {
      await ctx.io.stderr.write("Error: Incomplete command found at '^' position.\n");
      return 1;
    }
    const text = parts.join(' ');
    if (!machine.router.setInterfaceDescription(iface, text)) {
      await ctx.io.stderr.write("Error: Wrong parameter found at '^' position.\n");
      return 1;
    }
    return EXIT_OK;
  }
}
