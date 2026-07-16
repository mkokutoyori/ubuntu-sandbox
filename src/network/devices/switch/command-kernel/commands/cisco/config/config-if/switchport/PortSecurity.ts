import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { SwitchMachineApi } from '../../../../../SwitchMachineApi';
import { broadcastInterfaces } from '../selected-interfaces';
import { CiscoSwitchPortSecurityMacAddressCommand } from './port-security/MacAddress';
import { CiscoSwitchPortSecurityMaximumCommand } from './port-security/Maximum';
import { CiscoSwitchPortSecurityViolationCommand } from './port-security/Violation';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `switchport port-security` (Cisco Catalyst, mode config-if).
 *
 * Dual-role : commande racine ET composite.
 *  - Sans arg → active port-security sur les interfaces sélectionnées.
 *  - Avec sous-mot (`maximum <n>`, `violation …`, `mac-address …`) →
 *    l'interpréteur descend dans le sous-registre.
 *
 * Ce pattern reflète le vrai IOS où `switchport port-security` seul
 * signifie « enable » — le socle command-kernel supporte cette
 * ambiguïté naturellement : quand aucun mot ne matche dans le
 * sous-registre, `execute` est appelé et fait le enable.
 */
export class CiscoSwitchportPortSecurityCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'port-security',
    summary: 'Enable/configure port-based security',
    usage: 'switchport port-security [maximum <n> | violation <mode> | mac-address sticky]',
    args: [], options: [],
    privileges: OP,
    category: 'switch',
  };
  readonly allowedModes = ['config-if'];
  readonly subRegistry = new CommandRegistry();

  constructor() {
    super();
    this.subRegistry.register(() => new CiscoSwitchPortSecurityMaximumCommand());
    this.subRegistry.register(() => new CiscoSwitchPortSecurityViolationCommand());
    this.subRegistry.register(() => new CiscoSwitchPortSecurityMacAddressCommand());
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as SwitchMachineApi;
    const ifaces = broadcastInterfaces(ctx.session);
    if (ifaces.length === 0) { await ctx.io.stderr.write('% No interface selected.\n'); return 1; }
    for (const iface of ifaces) {
      if (!machine.switch.setInterfacePortSecurityEnabled(iface, true)) {
        await ctx.io.stderr.write("% Invalid input detected at '^' marker.\n");
        return 1;
      }
    }
    return EXIT_OK;
  }
}
