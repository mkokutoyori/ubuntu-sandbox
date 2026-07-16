import type { CommandContext, CommandDescriptor } from '@/command-kernel/command/types';
import { PushModeCommand } from '@/command-kernel/cli';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { CliSession } from '@/command-kernel/cli';
import type { SwitchMachineApi } from '../../../SwitchMachineApi';
import { parseInterfaceRange } from './interface-range/parse';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `interface range <plage>` (Cisco Catalyst, config) — push config-if
 * en mode multi-interfaces. La liste est stockée sérialisée dans
 * `session.promptFields['selectedInterfaces']` (CSV) — chaque commande
 * config-if déjà migrée (shutdown, description, switchport …) lit
 * `selectedInterfaces` avant `selectedInterface` et broadcaste.
 *
 * Toutes les interfaces citées DOIVENT exister (via la MachineApi) —
 * sinon la transition est refusée avec le message vendeur. `interface
 * range` prend le reste de la ligne en argument variadique pour
 * accepter les virgules et espaces (`Fa0/1 - 3, Fa0/10`).
 */
export class CiscoSwitchInterfaceRangeCommand extends PushModeCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'range',
    summary: 'Select a range of interfaces to configure',
    usage: 'interface range <first>[-<last>][, <first>[-<last>]]...',
    args: [{ name: 'range', type: 'string', required: true, variadic: true, description: 'Interface range spec (e.g. Fa0/1-4)' }],
    options: [],
    privileges: OP,
    category: 'cli-mode',
  };
  readonly allowedModes = ['config'];

  protected async prepare(ctx: CommandContext): Promise<boolean> {
    const machine = ctx.machine as SwitchMachineApi;
    const words = ctx.args.get<string[]>('range') ?? [];
    if (words.length === 0) {
      await ctx.io.stderr.write('% Incomplete command.\n');
      return false;
    }
    // Recombine sans espaces pour ré-appliquer notre parseur
    // (`Fa0/1 - 3, Fa0/10` → `Fa0/1-3,Fa0/10`).
    const raw = words.join('').replace(/\s+/g, '');
    const parsed = parseInterfaceRange(raw);
    if (!parsed || parsed.length === 0) {
      await ctx.io.stderr.write("% Invalid input detected at '^' marker.\n");
      return false;
    }
    // Chaque interface doit exister via MachineApi.
    for (const name of parsed) {
      if (!machine.switch.interface(name)) {
        await ctx.io.stderr.write("% Invalid input detected at '^' marker.\n");
        return false;
      }
    }
    (ctx.session as CliSession).promptFields.set('selectedInterfaces', parsed.join(','));
    return true;
  }

  protected targetMode(): string {
    return 'config-if';
  }
}
