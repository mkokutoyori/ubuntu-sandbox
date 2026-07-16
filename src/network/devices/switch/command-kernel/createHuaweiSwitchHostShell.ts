import { CliInterpreter, CliPromptBuilder, EndCommand, ModeRegistry, PopModeCommand } from '@/command-kernel/cli';
import type { CliMode, KernelErrorFormatter } from '@/command-kernel/cli';
import { PermissionGuard } from '@/command-kernel/exec/permission-guard';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import type { Switch } from '../../Switch';
import { createHuaweiDisplayCommand, HuaweiDisplayClockCommand, HuaweiSaveCommand, HuaweiSystemViewCommand } from '../../vendor-cli';
import { SwitchMachineApi } from './SwitchMachineApi';
import { HuaweiSwitchDisplayVersionCommand } from './commands/huawei/display/Version';
import { HuaweiSwitchDisplayVlanCommand } from './commands/huawei/display/Vlan';
import { HuaweiSwitchDisplayMacAddressCommand } from './commands/huawei/display/MacAddress';
import { HuaweiSwitchSysnameCommand } from './commands/huawei/system-view/Sysname';
import { HuaweiSwitchInterfaceCommand } from './commands/huawei/system-view/Interface';
import { HuaweiSwitchVlanCommand } from './commands/huawei/system-view/Vlan';
import { HuaweiSwitchSysUndoCommand } from './commands/huawei/system-view/Undo';
import { HuaweiSwitchIfShutdownCommand } from './commands/huawei/interface-view/Shutdown';
import { HuaweiSwitchIfDescriptionCommand } from './commands/huawei/interface-view/Description';
import { HuaweiSwitchIfPortCommand } from './commands/huawei/interface-view/Port';
import { HuaweiSwitchIfUndoCommand } from './commands/huawei/interface-view/Undo';
import { HuaweiSwitchVlanDescriptionCommand } from './commands/huawei/vlan-view/Description';
import { HuaweiSwitchVlanNameCommand } from './commands/huawei/vlan-view/Name';
import { HuaweiSwitchSysStpCommand } from './commands/huawei/system-view/Stp';
import { HuaweiSwitchSysMacAddressCommand } from './commands/huawei/system-view/MacAddress';
import { HuaweiSwitchDisplayStpCommand } from './commands/huawei/display/Stp';

/**
 * =====================================================================
 *  Bootstrap CLI vendeur Huawei VRP pour switch — modes, registres,
 *  interpréteur
 * =====================================================================
 *
 *  Structure VRP (switch) :
 *
 *    user-view (racine, prompt `<host>`, exec-level)
 *      └── system-view (prompt `[host]`)
 *            ├── interface-view (prompt `[host-<iface>]`)
 *            └── vlan-view      (prompt `[host-vlan<id>]`)
 *            └── stp / mstp     (à venir)
 *
 *  `system-view`/`quit` viennent de `vendor-cli/huawei/` — IDENTIQUES
 *  à celles du routeur. Sous-registre `display` propre au switch
 *  (S5720) — enrichi ici avec `vlan` et `mac-address`. La couverture
 *  suit un miroir strict de la vague router : sysname, interface,
 *  vlan, port link-type / port default vlan, description, shutdown,
 *  et toutes les négations `undo` correspondantes.
 */
export function createHuaweiSwitchHostShell(
  sw: Switch,
  errorFormatter?: KernelErrorFormatter,
): {
  interpreter: CliInterpreter;
  machine: SwitchMachineApi;
  promptBuilder: CliPromptBuilder;
} {
  const displaySub = new CommandRegistry();
  displaySub.register(() => new HuaweiSwitchDisplayVersionCommand());
  displaySub.register(() => new HuaweiSwitchDisplayVlanCommand());
  displaySub.register(() => new HuaweiSwitchDisplayMacAddressCommand());
  displaySub.register(() => new HuaweiSwitchDisplayStpCommand());
  displaySub.register(() => new HuaweiDisplayClockCommand());

  const userViewRegistry = new CommandRegistry();
  const systemViewRegistry = new CommandRegistry();
  const interfaceViewRegistry = new CommandRegistry();
  const vlanViewRegistry = new CommandRegistry();

  userViewRegistry.register(() => createHuaweiDisplayCommand(displaySub));
  userViewRegistry.register(() => new HuaweiSystemViewCommand());
  userViewRegistry.register(() => new HuaweiSaveCommand());
  userViewRegistry.register(() => new PopModeCommand('quit', 'Exit from the current view'));

  systemViewRegistry.register(() => createHuaweiDisplayCommand(displaySub));
  systemViewRegistry.register(() => new HuaweiSaveCommand());
  systemViewRegistry.register(() => new HuaweiSwitchSysnameCommand());
  systemViewRegistry.register(() => new HuaweiSwitchInterfaceCommand());
  systemViewRegistry.register(() => new HuaweiSwitchVlanCommand());
  systemViewRegistry.register(() => new HuaweiSwitchSysStpCommand());
  systemViewRegistry.register(() => new HuaweiSwitchSysMacAddressCommand());
  systemViewRegistry.register(() => new HuaweiSwitchSysUndoCommand());
  systemViewRegistry.register(() => new PopModeCommand('quit', 'Exit from the current view'));
  systemViewRegistry.register(() => new EndCommand(['return']));

  interfaceViewRegistry.register(() => new HuaweiSwitchIfShutdownCommand());
  interfaceViewRegistry.register(() => new HuaweiSwitchIfDescriptionCommand());
  interfaceViewRegistry.register(() => new HuaweiSwitchIfPortCommand());
  interfaceViewRegistry.register(() => new HuaweiSwitchIfUndoCommand());
  interfaceViewRegistry.register(() => new PopModeCommand('quit', 'Exit from the current view'));
  interfaceViewRegistry.register(() => new EndCommand(['return']));

  vlanViewRegistry.register(() => new HuaweiSwitchVlanNameCommand());
  vlanViewRegistry.register(() => new HuaweiSwitchVlanDescriptionCommand());
  vlanViewRegistry.register(() => new PopModeCommand('quit', 'Exit from the current view'));
  vlanViewRegistry.register(() => new EndCommand(['return']));

  const modes = new ModeRegistry([
    { name: 'user-view',      prompt: (_s, host) => `<${host}>`,                                                             parent: null,          registry: userViewRegistry },
    { name: 'system-view',    prompt: (_s, host) => `[${host}]`,                                                              parent: 'user-view',   registry: systemViewRegistry },
    { name: 'interface-view', prompt: (s, host) => `[${host}-${s.promptFields.get('selectedInterface') ?? ''}]`,              parent: 'system-view', registry: interfaceViewRegistry, clearOnExit: ['selectedInterface'] },
    { name: 'vlan-view',      prompt: (s, host) => `[${host}-vlan${s.promptFields.get('selectedVlan') ?? ''}]`,               parent: 'system-view', registry: vlanViewRegistry,      clearOnExit: ['selectedVlan'] },
  ] satisfies CliMode[]);

  const machine = new SwitchMachineApi({ switch: sw, modes });
  const interpreter = new CliInterpreter(modes, machine, new PermissionGuard(), errorFormatter);
  const promptBuilder = new CliPromptBuilder(modes, () => machine.hostname);
  return { interpreter, machine, promptBuilder };
}
