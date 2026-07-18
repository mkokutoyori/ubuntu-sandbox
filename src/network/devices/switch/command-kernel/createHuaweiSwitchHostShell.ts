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
import { HuaweiSwitchDisplayInterfaceCommand } from './commands/huawei/display/Interface';
import { HuaweiSwitchDisplayCurrentConfigurationCommand } from './commands/huawei/display/CurrentConfiguration';
import { HuaweiSwitchStpRegionConfigurationRegionNameCommand } from './commands/huawei/mst-region-view/RegionName';
import { HuaweiSwitchStpRegionConfigurationActiveCommand } from './commands/huawei/mst-region-view/Active';
import { HuaweiSwitchIfStpCommand } from './commands/huawei/interface-view/Stp';
import { HuaweiSwitchIfPortSecurityCommand } from './commands/huawei/interface-view/PortSecurity';
import { HuaweiSwitchIfEthTrunkCommand } from './commands/huawei/interface-view/EthTrunk';
import { HuaweiSwitchIfVoiceVlanCommand } from './commands/huawei/interface-view/VoiceVlan';
import { HuaweiSwitchIfQinqCommand } from './commands/huawei/interface-view/Qinq';
import { HuaweiSwitchIfDot1xCommand } from './commands/huawei/interface-view/Dot1x';
import { HuaweiSwitchIfStormControlCommand } from './commands/huawei/interface-view/StormControl';
import { HuaweiSwitchSysIgmpSnoopingCommand } from './commands/huawei/system-view/IgmpSnooping';
import { HuaweiSwitchSysLldpCommand } from './commands/huawei/system-view/Lldp';
import { HuaweiSwitchSysEthTrunkCommand } from './commands/huawei/system-view/interface/Trunk';
import { HuaweiSwitchIfMacLimitCommand } from './commands/huawei/interface-view/MacLimit';
import { HuaweiSwitchIfPortIsolateCommand } from './commands/huawei/interface-view/PortIsolate';
import { HuaweiSwitchIfLoopbackDetectCommand } from './commands/huawei/interface-view/LoopbackDetect';
import { HuaweiSwitchIfBpduCommand } from './commands/huawei/interface-view/Bpdu';
import { HuaweiSwitchIfTrafficFilterCommand } from './commands/huawei/interface-view/TrafficFilter';
import { HuaweiSwitchIfTrafficSecureCommand } from './commands/huawei/interface-view/TrafficSecure';
import { HuaweiSwitchIfArpLimitCommand } from './commands/huawei/interface-view/ArpLimit';
import { HuaweiSwitchIfArpDetectCommand } from './commands/huawei/interface-view/ArpDetect';
import { HuaweiSwitchSysVoiceVlanCommand } from './commands/huawei/system-view/VoiceVlan';
import { HuaweiSwitchSysSuperVlanCommand } from './commands/huawei/system-view/SuperVlan';
import { HuaweiSwitchSysMuxVlanCommand } from './commands/huawei/system-view/MuxVlan';
import { HuaweiSwitchSysArpSecurityCommand } from './commands/huawei/system-view/ArpSecurity';
import { HuaweiSwitchSysDhcpCommand } from './commands/huawei/system-view/Dhcp';
import { HuaweiSwitchSysVlanBatchCommand } from './commands/huawei/system-view/VlanBatch';
import { HuaweiSwitchSysDtpCommand } from './commands/huawei/system-view/Dtp';
import { HuaweiSwitchSysGvrpCommand } from './commands/huawei/system-view/Gvrp';
import { HuaweiSwitchSysVtpCommand } from './commands/huawei/system-view/Vtp';
import { HuaweiSwitchSysCdpCommand } from './commands/huawei/system-view/Cdp';
import { HuaweiSwitchSysUdldCommand } from './commands/huawei/system-view/Udld';
import { HuaweiSwitchSysUserInterfaceCommand } from './commands/huawei/system-view/UserInterface';
import { HuaweiSwitchSysAaaCommand } from './commands/huawei/system-view/Aaa';
import { HuaweiSwitchSysInfoCenterCommand } from './commands/huawei/system-view/InfoCenter';
import { HuaweiSwitchSysSnmpAgentCommand } from './commands/huawei/system-view/SnmpAgent';
import { HuaweiSwitchSysNtpServiceCommand } from './commands/huawei/system-view/NtpService';
import { HuaweiSwitchSysAclCommand } from './commands/huawei/system-view/Acl';
import { HuaweiSwitchUserClockCommand } from './commands/huawei/user-view/Clock';
import { HuaweiSwitchUserRebootCommand } from './commands/huawei/user-view/Reboot';
import { HuaweiSwitchUserStartupCommand } from './commands/huawei/user-view/Startup';
// `HuaweiSwitchInterfaceVlanifCommand` est scaffoldé mais NON registered :
// le vrai VRP réutilise le composite `interface <name>` avec le pattern
// `Vlanif<id>` reconnu dans `HuaweiSwitchInterfaceCommand.prepare()`.
// La classe reste disponible pour un futur découplage.

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
  displaySub.register(() => new HuaweiSwitchDisplayInterfaceCommand());
  displaySub.register(() => new HuaweiSwitchDisplayCurrentConfigurationCommand());
  displaySub.register(() => new HuaweiDisplayClockCommand());

  const userViewRegistry = new CommandRegistry();
  const systemViewRegistry = new CommandRegistry();
  const interfaceViewRegistry = new CommandRegistry();
  const vlanViewRegistry = new CommandRegistry();
  const mstRegionViewRegistry = new CommandRegistry();
  const aaaViewRegistry = new CommandRegistry();

  userViewRegistry.register(() => createHuaweiDisplayCommand(displaySub));
  userViewRegistry.register(() => new HuaweiSystemViewCommand());
  userViewRegistry.register(() => new HuaweiSaveCommand());
  userViewRegistry.register(() => new HuaweiSwitchUserClockCommand());
  userViewRegistry.register(() => new HuaweiSwitchUserRebootCommand());
  userViewRegistry.register(() => new HuaweiSwitchUserStartupCommand());
  userViewRegistry.register(() => new PopModeCommand('quit', 'Exit from the current view'));

  systemViewRegistry.register(() => createHuaweiDisplayCommand(displaySub));
  systemViewRegistry.register(() => new HuaweiSaveCommand());
  systemViewRegistry.register(() => new HuaweiSwitchSysnameCommand());
  systemViewRegistry.register(() => new HuaweiSwitchInterfaceCommand());
  systemViewRegistry.register(() => new HuaweiSwitchVlanCommand());
  systemViewRegistry.register(() => new HuaweiSwitchSysStpCommand());
  systemViewRegistry.register(() => new HuaweiSwitchSysMacAddressCommand());
  systemViewRegistry.register(() => new HuaweiSwitchSysIgmpSnoopingCommand());
  systemViewRegistry.register(() => new HuaweiSwitchSysLldpCommand());
  systemViewRegistry.register(() => new HuaweiSwitchSysEthTrunkCommand());
  systemViewRegistry.register(() => new HuaweiSwitchSysVoiceVlanCommand());
  systemViewRegistry.register(() => new HuaweiSwitchSysSuperVlanCommand());
  systemViewRegistry.register(() => new HuaweiSwitchSysMuxVlanCommand());
  systemViewRegistry.register(() => new HuaweiSwitchSysArpSecurityCommand());
  systemViewRegistry.register(() => new HuaweiSwitchSysDhcpCommand());
  systemViewRegistry.register(() => new HuaweiSwitchSysVlanBatchCommand());
  systemViewRegistry.register(() => new HuaweiSwitchSysDtpCommand());
  systemViewRegistry.register(() => new HuaweiSwitchSysGvrpCommand());
  systemViewRegistry.register(() => new HuaweiSwitchSysVtpCommand());
  systemViewRegistry.register(() => new HuaweiSwitchSysCdpCommand());
  systemViewRegistry.register(() => new HuaweiSwitchSysUdldCommand());
  systemViewRegistry.register(() => new HuaweiSwitchSysUserInterfaceCommand());
  systemViewRegistry.register(() => new HuaweiSwitchSysAaaCommand());
  systemViewRegistry.register(() => new HuaweiSwitchSysInfoCenterCommand());
  systemViewRegistry.register(() => new HuaweiSwitchSysSnmpAgentCommand());
  systemViewRegistry.register(() => new HuaweiSwitchSysNtpServiceCommand());
  systemViewRegistry.register(() => new HuaweiSwitchSysAclCommand());
  systemViewRegistry.register(() => new HuaweiSwitchSysUndoCommand());
  systemViewRegistry.register(() => new PopModeCommand('quit', 'Exit from the current view'));
  systemViewRegistry.register(() => new EndCommand(['return']));

  interfaceViewRegistry.register(() => new HuaweiSwitchIfShutdownCommand());
  interfaceViewRegistry.register(() => new HuaweiSwitchIfDescriptionCommand());
  interfaceViewRegistry.register(() => new HuaweiSwitchIfPortCommand());
  interfaceViewRegistry.register(() => new HuaweiSwitchIfStpCommand());
  interfaceViewRegistry.register(() => new HuaweiSwitchIfPortSecurityCommand());
  interfaceViewRegistry.register(() => new HuaweiSwitchIfEthTrunkCommand());
  interfaceViewRegistry.register(() => new HuaweiSwitchIfVoiceVlanCommand());
  interfaceViewRegistry.register(() => new HuaweiSwitchIfQinqCommand());
  interfaceViewRegistry.register(() => new HuaweiSwitchIfDot1xCommand());
  interfaceViewRegistry.register(() => new HuaweiSwitchIfStormControlCommand());
  interfaceViewRegistry.register(() => new HuaweiSwitchIfMacLimitCommand());
  interfaceViewRegistry.register(() => new HuaweiSwitchIfPortIsolateCommand());
  interfaceViewRegistry.register(() => new HuaweiSwitchIfLoopbackDetectCommand());
  interfaceViewRegistry.register(() => new HuaweiSwitchIfBpduCommand());
  interfaceViewRegistry.register(() => new HuaweiSwitchIfTrafficFilterCommand());
  interfaceViewRegistry.register(() => new HuaweiSwitchIfTrafficSecureCommand());
  interfaceViewRegistry.register(() => new HuaweiSwitchIfArpLimitCommand());
  interfaceViewRegistry.register(() => new HuaweiSwitchIfArpDetectCommand());
  interfaceViewRegistry.register(() => new HuaweiSwitchIfUndoCommand());
  interfaceViewRegistry.register(() => new PopModeCommand('quit', 'Exit from the current view'));
  interfaceViewRegistry.register(() => new EndCommand(['return']));

  vlanViewRegistry.register(() => new HuaweiSwitchVlanNameCommand());
  vlanViewRegistry.register(() => new HuaweiSwitchVlanDescriptionCommand());
  vlanViewRegistry.register(() => new PopModeCommand('quit', 'Exit from the current view'));
  vlanViewRegistry.register(() => new EndCommand(['return']));

  mstRegionViewRegistry.register(() => new HuaweiSwitchStpRegionConfigurationRegionNameCommand());
  mstRegionViewRegistry.register(() => new HuaweiSwitchStpRegionConfigurationActiveCommand());
  mstRegionViewRegistry.register(() => new PopModeCommand('quit', 'Exit from the current view'));
  mstRegionViewRegistry.register(() => new EndCommand(['return']));

  aaaViewRegistry.register(() => new PopModeCommand('quit', 'Exit from the current view'));
  aaaViewRegistry.register(() => new EndCommand(['return']));

  const modes = new ModeRegistry([
    { name: 'user-view',      prompt: (_s, host) => `<${host}>`,                                                             parent: null,          registry: userViewRegistry },
    { name: 'system-view',    prompt: (_s, host) => `[${host}]`,                                                              parent: 'user-view',   registry: systemViewRegistry },
    { name: 'interface-view', prompt: (s, host) => `[${host}-${s.promptFields.get('selectedInterface') ?? ''}]`,              parent: 'system-view', registry: interfaceViewRegistry, clearOnExit: ['selectedInterface'] },
    { name: 'vlan-view',      prompt: (s, host) => `[${host}-vlan${s.promptFields.get('selectedVlan') ?? ''}]`,               parent: 'system-view', registry: vlanViewRegistry,      clearOnExit: ['selectedVlan'] },
    { name: 'mst-region-view', prompt: (_s, host) => `[${host}-mst-region]`,                                                    parent: 'system-view', registry: mstRegionViewRegistry },
    { name: 'aaa-view',        prompt: (_s, host) => `[${host}-aaa]`,                                                            parent: 'system-view', registry: aaaViewRegistry },
  ] satisfies CliMode[]);

  const machine = new SwitchMachineApi({ switch: sw, modes });
  const interpreter = new CliInterpreter(modes, machine, new PermissionGuard(), errorFormatter);
  const promptBuilder = new CliPromptBuilder(modes, () => machine.hostname);
  return { interpreter, machine, promptBuilder };
}
