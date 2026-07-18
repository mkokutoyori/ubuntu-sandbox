import { CliInterpreter, CliPromptBuilder, EndCommand, ModeRegistry, PopModeCommand } from '@/command-kernel/cli';
import type { CliMode, KernelErrorFormatter } from '@/command-kernel/cli';
import { PermissionGuard } from '@/command-kernel/exec/permission-guard';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import type { Switch } from '../../Switch';
import {
  CiscoConfigureCommand,
  CiscoDisableCommand,
  CiscoEnableCommand,
  createCiscoShowCommand,
} from '../../vendor-cli';
import { SwitchMachineApi } from './SwitchMachineApi';
import { CiscoSwitchShowCdpCommand } from './commands/cisco/show/Cdp';
import { CiscoSwitchShowClockCommand } from './commands/cisco/show/Clock';
import { CiscoSwitchShowDtpCommand } from './commands/cisco/show/Dtp';
import { CiscoSwitchShowFlashCommand } from './commands/cisco/show/Flash';
import { CiscoSwitchShowHistoryCommand } from './commands/cisco/show/History';
import { CiscoSwitchShowInventoryCommand } from './commands/cisco/show/Inventory';
import { CiscoSwitchShowLineCommand } from './commands/cisco/show/Line';
import { CiscoSwitchShowLoggingCommand } from './commands/cisco/show/Logging';
import { CiscoSwitchShowMemoryCommand } from './commands/cisco/show/Memory';
import { CiscoSwitchShowProcessesCommand } from './commands/cisco/show/Processes';
import { CiscoSwitchShowSnmpCommand } from './commands/cisco/show/Snmp';
import { CiscoSwitchShowStartupConfigCommand } from './commands/cisco/show/StartupConfig';
import { CiscoSwitchShowStandbyCommand } from './commands/cisco/show/Standby';
import { CiscoSwitchShowEtherchannelCommand } from './commands/cisco/show/Etherchannel';
import { CiscoSwitchShowInterfacesCommand } from './commands/cisco/show/Interfaces';
import { CiscoSwitchShowMacCommand } from './commands/cisco/show/Mac';
import { CiscoSwitchShowPortSecurityCommand } from './commands/cisco/show/PortSecurity';
import { CiscoSwitchShowRunningConfigCommand } from './commands/cisco/show/RunningConfig';
import { CiscoSwitchShowSpanningTreeCommand } from './commands/cisco/show/SpanningTree';
import { CiscoSwitchShowVlanCommand } from './commands/cisco/show/Vlan';
import { CiscoSwitchShowVersionCommand } from './commands/cisco/show/Version';
import { CiscoSwitchConfigAaaCommand } from './commands/cisco/config/Aaa';
import { CiscoSwitchConfigAccessListCommand } from './commands/cisco/config/AccessList';
import { CiscoSwitchConfigAliasCommand } from './commands/cisco/config/Alias';
import { CiscoSwitchConfigBootCommand } from './commands/cisco/config/Boot';
import { CiscoSwitchConfigClockCommand } from './commands/cisco/config/Clock';
import { CiscoSwitchConfigBannerCommand } from './commands/cisco/config/Banner';
import { CiscoSwitchConfigSnmpServerCommand } from './commands/cisco/config/SnmpServer';
import { CiscoSwitchConfigEnableCommand } from './commands/cisco/config/Enable';
import { CiscoSwitchConfigErrdisableCommand } from './commands/cisco/config/Errdisable';
import { CiscoSwitchHostnameCommand } from './commands/cisco/config/Hostname';
import { CiscoSwitchInterfaceCommand } from './commands/cisco/config/Interface';
import { CiscoSwitchGlobalIpCommand } from './commands/cisco/config/Ip';
import { CiscoSwitchConfigLoggingCommand } from './commands/cisco/config/Logging';
import { CiscoSwitchConfigMacCommand } from './commands/cisco/config/Mac';
import { CiscoSwitchConfigNoCommand } from './commands/cisco/config/No';
import { CiscoSwitchConfigNtpCommand } from './commands/cisco/config/Ntp';
import { CiscoSwitchGlobalSpanningTreeCommand } from './commands/cisco/config/SpanningTree';
import { CiscoSwitchVlanCommand } from './commands/cisco/config/Vlan';
import { CiscoSwitchConfigVtpCommand } from './commands/cisco/config/Vtp';
import { CiscoSwitchChannelGroupCommand } from './commands/cisco/config/config-if/ChannelGroup';
import { CiscoSwitchDescriptionCommand } from './commands/cisco/config/config-if/Description';
import { CiscoSwitchConfigIfDuplexCommand } from './commands/cisco/config/config-if/Duplex';
import { CiscoSwitchConfigIfMtuCommand } from './commands/cisco/config/config-if/Mtu';
import { CiscoSwitchConfigIfNoCommand } from './commands/cisco/config/config-if/No';
import { CiscoSwitchShutdownCommand } from './commands/cisco/config/config-if/Shutdown';
import { CiscoSwitchConfigIfSpanningTreeCommand } from './commands/cisco/config/config-if/SpanningTree';
import { CiscoSwitchConfigIfMlsCommand } from './commands/cisco/config/config-if/Mls';
import { CiscoSwitchConfigIfServicePolicyCommand } from './commands/cisco/config/config-if/ServicePolicy';
import { CiscoSwitchConfigIfSpeedCommand } from './commands/cisco/config/config-if/Speed';
import { CiscoSwitchConfigIfStormControlCommand } from './commands/cisco/config/config-if/StormControl';
import { CiscoSwitchportCommand } from './commands/cisco/config/config-if/Switchport';
import { CiscoSwitchVlanNameCommand } from './commands/cisco/config/config-vlan/Name';

/**
 * =====================================================================
 *  Bootstrap CLI vendeur Cisco IOS pour switch — modes, registres,
 *  interpréteur
 * =====================================================================
 *
 *  Structure des modes Cisco IOS (switch, miroir de `CISCO_SWITCH_MODES`
 *  legacy) :
 *
 *    user (racine, prompt `>`)
 *      └── privileged (prompt `#`, exec-level)
 *            └── config (prompt `(config)#`)
 *                  ├── config-vlan  (config-vlan)#      (à venir)
 *                  ├── config-if    (config-if)#        (à venir)
 *                  ├── config-mst   (config-mst)#       (à venir)
 *                  ├── config-line  (config-line)#      (à venir)
 *                  ├── config-acl   (config-ext-nacl)#  (à venir)
 *                  └── config-dhcp  (dhcp-config)#      (à venir)
 *
 *  Les commandes de transition (`enable`, `disable`, `configure
 *  terminal`) sont IDENTIQUES à celles du routeur Cisco — d'où
 *  l'import depuis `vendor-cli/cisco/`. Seul le sous-registre de `show`
 *  diffère : le switch enregistre ses propres sous-commandes L2 (VLAN,
 *  MAC table, port-security…). Ici, seul `show version` est migré ;
 *  le reste tombera à travers le nouveau pipeline avec une erreur —
 *  c'est le signal explicite pour la migration future.
 */
export function createCiscoSwitchHostShell(
  sw: Switch,
  errorFormatter?: KernelErrorFormatter,
): {
  interpreter: CliInterpreter;
  machine: SwitchMachineApi;
  promptBuilder: CliPromptBuilder;
} {
  // Sous-registre `show` — switch-spécifique. `version` est présente en
  // preuve d'architecture ; `vlan`, `mac-address-table`, `interfaces`,
  // `spanning-tree`, `port-security`, `interfaces status`, … seront
  // ajoutés au fil des pushes de migration.
  const showSub = new CommandRegistry();
  showSub.register(() => new CiscoSwitchShowVersionCommand());
  showSub.register(() => new CiscoSwitchShowVlanCommand());
  showSub.register(() => new CiscoSwitchShowMacCommand());
  showSub.register(() => new CiscoSwitchShowInterfacesCommand());
  showSub.register(() => new CiscoSwitchShowRunningConfigCommand());
  showSub.register(() => new CiscoSwitchShowEtherchannelCommand());
  showSub.register(() => new CiscoSwitchShowClockCommand());
  showSub.register(() => new CiscoSwitchShowCdpCommand());
  showSub.register(() => new CiscoSwitchShowPortSecurityCommand());
  showSub.register(() => new CiscoSwitchShowSpanningTreeCommand());
  showSub.register(() => new CiscoSwitchShowDtpCommand());
  showSub.register(() => new CiscoSwitchShowStandbyCommand());
  showSub.register(() => new CiscoSwitchShowInventoryCommand());
  showSub.register(() => new CiscoSwitchShowFlashCommand());
  showSub.register(() => new CiscoSwitchShowSnmpCommand());
  showSub.register(() => new CiscoSwitchShowLineCommand());
  showSub.register(() => new CiscoSwitchShowHistoryCommand());
  showSub.register(() => new CiscoSwitchShowStartupConfigCommand());
  showSub.register(() => new CiscoSwitchShowLoggingCommand());
  showSub.register(() => new CiscoSwitchShowProcessesCommand());
  showSub.register(() => new CiscoSwitchShowMemoryCommand());

  const userRegistry = new CommandRegistry();
  const privilegedRegistry = new CommandRegistry();
  const configRegistry = new CommandRegistry();
  const configIfRegistry = new CommandRegistry();
  const configVlanRegistry = new CommandRegistry();

  userRegistry.register(() => new CiscoEnableCommand());
  userRegistry.register(() => createCiscoShowCommand(showSub));
  userRegistry.register(() => new PopModeCommand('exit', 'Exit from the current mode'));
  userRegistry.register(() => new PopModeCommand('logout', 'Exit from the EXEC'));

  privilegedRegistry.register(() => new CiscoDisableCommand());
  privilegedRegistry.register(() => new CiscoConfigureCommand());
  privilegedRegistry.register(() => createCiscoShowCommand(showSub));
  privilegedRegistry.register(() => new PopModeCommand('exit', 'Exit from the current mode'));
  privilegedRegistry.register(() => new PopModeCommand('logout', 'Exit from the EXEC'));

  configRegistry.register(() => new CiscoSwitchHostnameCommand());
  configRegistry.register(() => new CiscoSwitchInterfaceCommand());
  configRegistry.register(() => new CiscoSwitchVlanCommand());
  configRegistry.register(() => new CiscoSwitchConfigNoCommand());
  configRegistry.register(() => new CiscoSwitchGlobalSpanningTreeCommand());
  configRegistry.register(() => new CiscoSwitchGlobalIpCommand());
  configRegistry.register(() => new CiscoSwitchConfigBannerCommand());
  configRegistry.register(() => new CiscoSwitchConfigEnableCommand());
  configRegistry.register(() => new CiscoSwitchConfigErrdisableCommand());
  configRegistry.register(() => new CiscoSwitchConfigLoggingCommand());
  configRegistry.register(() => new CiscoSwitchConfigVtpCommand());
  configRegistry.register(() => new CiscoSwitchConfigNtpCommand());
  configRegistry.register(() => new CiscoSwitchConfigMacCommand());
  configRegistry.register(() => new CiscoSwitchConfigSnmpServerCommand());
  configRegistry.register(() => new CiscoSwitchConfigAaaCommand());
  configRegistry.register(() => new CiscoSwitchConfigBootCommand());
  configRegistry.register(() => new CiscoSwitchConfigClockCommand());
  configRegistry.register(() => new CiscoSwitchConfigAccessListCommand());
  configRegistry.register(() => new CiscoSwitchConfigAliasCommand());
  configRegistry.register(() => new PopModeCommand('exit', 'Exit from the current mode'));
  configRegistry.register(() => new EndCommand());

  configIfRegistry.register(() => new CiscoSwitchShutdownCommand());
  configIfRegistry.register(() => new CiscoSwitchDescriptionCommand());
  configIfRegistry.register(() => new CiscoSwitchConfigIfNoCommand());
  configIfRegistry.register(() => new CiscoSwitchportCommand());
  configIfRegistry.register(() => new CiscoSwitchChannelGroupCommand());
  configIfRegistry.register(() => new CiscoSwitchConfigIfMtuCommand());
  configIfRegistry.register(() => new CiscoSwitchConfigIfSpeedCommand());
  configIfRegistry.register(() => new CiscoSwitchConfigIfDuplexCommand());
  configIfRegistry.register(() => new CiscoSwitchConfigIfSpanningTreeCommand());
  configIfRegistry.register(() => new CiscoSwitchConfigIfStormControlCommand());
  configIfRegistry.register(() => new CiscoSwitchConfigIfMlsCommand());
  configIfRegistry.register(() => new CiscoSwitchConfigIfServicePolicyCommand());
  configIfRegistry.register(() => new PopModeCommand('exit', 'Exit from the current mode'));
  configIfRegistry.register(() => new EndCommand());

  configVlanRegistry.register(() => new CiscoSwitchVlanNameCommand());
  configVlanRegistry.register(() => new PopModeCommand('exit', 'Exit from the current mode'));
  configVlanRegistry.register(() => new EndCommand());

  const modes = new ModeRegistry([
    { name: 'user',        prompt: (_s, host) => `${host}>`,             parent: null,         registry: userRegistry },
    { name: 'privileged',  prompt: (_s, host) => `${host}#`,             parent: 'user',       registry: privilegedRegistry },
    { name: 'config',      prompt: (_s, host) => `${host}(config)#`,     parent: 'privileged', registry: configRegistry },
    { name: 'config-if',   prompt: (_s, host) => `${host}(config-if)#`,  parent: 'config',     registry: configIfRegistry, clearOnExit: ['selectedInterface', 'selectedInterfaces'] },
    { name: 'config-vlan', prompt: (_s, host) => `${host}(config-vlan)#`, parent: 'config',    registry: configVlanRegistry, clearOnExit: ['selectedVlan'] },
  ] satisfies CliMode[], { execLevel: 'privileged' });

  const machine = new SwitchMachineApi({ switch: sw, modes });
  const interpreter = new CliInterpreter(modes, machine, new PermissionGuard(), errorFormatter);
  const promptBuilder = new CliPromptBuilder(modes, () => machine.hostname);
  return { interpreter, machine, promptBuilder };
}
