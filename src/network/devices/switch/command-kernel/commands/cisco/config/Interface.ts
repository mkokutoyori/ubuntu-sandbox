import type { CommandContext, CommandDescriptor } from '@/command-kernel/command/types';
import { PushModeCommand } from '@/command-kernel/cli';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { CliSession } from '@/command-kernel/cli';
import type { SwitchMachineApi } from '../../../SwitchMachineApi';
import { CiscoSwitchInterfaceRangeCommand } from './InterfaceRange';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `interface <name>` (Cisco Catalyst, mode config) — push de mode
 * config-if avec pré-sélection. Contrairement au routeur, les
 * switches n'ont pas de création à la volée : l'interface doit
 * exister (pas de sous-interfaces routées sur switch d'accès L2).
 */
export class CiscoSwitchInterfaceCommand extends PushModeCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'interface',
    summary: 'Select an interface to configure',
    usage: 'interface <name> | interface range <spec>',
    args: [{ name: 'name', type: 'string', required: true, description: 'Interface name (e.g. FastEthernet0/1)' }],
    options: [],
    privileges: OP,
    category: 'cli-mode',
  };
  readonly allowedModes = ['config'];
  readonly subRegistry = new CommandRegistry();

  constructor() {
    super();
    // `interface range <spec>` est une SOUS-commande de `interface` —
    // l'interpréteur descend automatiquement quand `range` matche. Sinon
    // (interface Fa0/1) c'est le `execute` de PushModeCommand qui prend
    // le token comme nom d'interface via `prepare` ci-dessous.
    this.subRegistry.register(() => new CiscoSwitchInterfaceRangeCommand());
  }

  protected async prepare(ctx: CommandContext): Promise<boolean> {
    const machine = ctx.machine as SwitchMachineApi;
    const name = ctx.args.get<string>('name');
    if (!name) {
      await ctx.io.stderr.write('% Incomplete command.\n');
      return false;
    }
    if (!machine.switch.interface(name)) {
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
