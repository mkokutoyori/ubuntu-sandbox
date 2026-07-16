import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { SwitchMachineApi, SwitchPortViolationMode } from '../../../../../../../SwitchMachineApi';
import { broadcastInterfaces } from '../../../selected-interfaces';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/** Feuille commune pour `violation {protect|restrict|shutdown}` — trois
 *  classes concrètes en réutilisent le corps via le champ `mode`. */
export abstract class CiscoSwitchPortSecurityViolationLeafBase extends BaseCommand {
  protected abstract readonly mode: SwitchPortViolationMode;

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as SwitchMachineApi;
    const ifaces = broadcastInterfaces(ctx.session);
    if (ifaces.length === 0) { await ctx.io.stderr.write('% No interface selected.\n'); return 1; }
    for (const iface of ifaces) {
      if (!machine.switch.setInterfacePortSecurityViolation(iface, this.mode)) {
        await ctx.io.stderr.write("% Invalid input detected at '^' marker.\n");
        return 1;
      }
    }
    return EXIT_OK;
  }
}

export class CiscoSwitchPortSecurityViolationShutdownCommand extends CiscoSwitchPortSecurityViolationLeafBase {
  protected readonly mode: SwitchPortViolationMode = 'shutdown';
  readonly descriptor: CommandDescriptor = {
    name: 'shutdown',
    summary: 'Shutdown port on violation',
    usage: 'switchport port-security violation shutdown',
    args: [], options: [],
    privileges: OP,
    category: 'switch',
  };
  readonly allowedModes = ['config-if'];
}

export class CiscoSwitchPortSecurityViolationRestrictCommand extends CiscoSwitchPortSecurityViolationLeafBase {
  protected readonly mode: SwitchPortViolationMode = 'restrict';
  readonly descriptor: CommandDescriptor = {
    name: 'restrict',
    summary: 'Drop offending frames and increment counter',
    usage: 'switchport port-security violation restrict',
    args: [], options: [],
    privileges: OP,
    category: 'switch',
  };
  readonly allowedModes = ['config-if'];
}

export class CiscoSwitchPortSecurityViolationProtectCommand extends CiscoSwitchPortSecurityViolationLeafBase {
  protected readonly mode: SwitchPortViolationMode = 'protect';
  readonly descriptor: CommandDescriptor = {
    name: 'protect',
    summary: 'Drop offending frames silently',
    usage: 'switchport port-security violation protect',
    args: [], options: [],
    privileges: OP,
    category: 'switch',
  };
  readonly allowedModes = ['config-if'];
}
