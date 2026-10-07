import { CliInterpreter, CliPromptBuilder, EndCommand, ModeRegistry, PopModeCommand } from '@/command-kernel/cli';
import type { CliMode, KernelErrorFormatter } from '@/command-kernel/cli';
import { PermissionGuard } from '@/command-kernel/exec/permission-guard';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import type { Router } from '../../Router';
import {
  CiscoConfigureCommand,
  CiscoDisableCommand,
  CiscoEnableCommand,
  createCiscoShowCommand,
} from '../../vendor-cli';
import { RouterMachineApi } from './RouterMachineApi';
// ─── show ───────────────────────────────────────────────────────────
import { CiscoRouterShowArpCommand } from './commands/cisco/show/Arp';
import { CiscoRouterShowCdpCommand } from './commands/cisco/show/Cdp';
import { CiscoRouterShowClockCommand } from './commands/cisco/show/Clock';
import { CiscoRouterShowEnvironmentCommand } from './commands/cisco/show/Environment';
import { CiscoRouterShowFlashCommand } from './commands/cisco/show/Flash';
import { CiscoRouterShowInterfacesCommand } from './commands/cisco/show/Interfaces';
import { CiscoRouterShowAccessListsCommand } from './commands/cisco/show/AccessLists';
import { CiscoRouterShowBootCommand } from './commands/cisco/show/Boot';
import { CiscoRouterShowBuffersCommand } from './commands/cisco/show/Buffers';
import { CiscoRouterShowControllersCommand } from './commands/cisco/show/Controllers';
import { CiscoRouterShowSshCommand } from './commands/cisco/show/Ssh';
import { CiscoRouterShowClassMapCommand } from './commands/cisco/show/ClassMap';
import { CiscoRouterShowHistoryCommand } from './commands/cisco/show/History';
import { CiscoRouterShowInventoryCommand } from './commands/cisco/show/Inventory';
import { CiscoRouterShowLineCommand } from './commands/cisco/show/Line';
import { CiscoRouterShowPolicyMapCommand } from './commands/cisco/show/PolicyMap';
import { CiscoRouterShowRouteMapCommand } from './commands/cisco/show/RouteMap';
import { CiscoRouterShowSessionsCommand } from './commands/cisco/show/Sessions';
import { CiscoRouterShowSnmpCommand } from './commands/cisco/show/Snmp';
import { CiscoRouterShowStartupConfigCommand } from './commands/cisco/show/StartupConfig';
import { CiscoRouterShowVrfCommand } from './commands/cisco/show/Vrf';
import { CiscoRouterShowTechSupportCommand } from './commands/cisco/show/TechSupport';
import { CiscoRouterShowIpCommand } from './commands/cisco/show/Ip';
import { CiscoRouterShowLldpCommand } from './commands/cisco/show/Lldp';
import { CiscoRouterShowLoggingCommand } from './commands/cisco/show/Logging';
import { CiscoRouterShowMemoryCommand } from './commands/cisco/show/Memory';
import { CiscoRouterShowNtpCommand } from './commands/cisco/show/Ntp';
import { CiscoRouterShowProcessesCommand } from './commands/cisco/show/Processes';
import { CiscoRouterShowRunningConfigCommand } from './commands/cisco/show/RunningConfig';
import { CiscoRouterShowUsersCommand } from './commands/cisco/show/Users';
import { CiscoRouterShowVersionCommand } from './commands/cisco/show/Version';
// ─── config ─────────────────────────────────────────────────────────
import { CiscoRouterConfigAaaCommand } from './commands/cisco/config/Aaa';
import { CiscoRouterConfigAccessListCommand } from './commands/cisco/config/AccessList';
import { CiscoRouterConfigAliasCommand } from './commands/cisco/config/Alias';
import { CiscoRouterConfigBootCommand } from './commands/cisco/config/Boot';
import { CiscoRouterConfigClockCommand } from './commands/cisco/config/Clock';
import { CiscoRouterConfigCryptoCommand } from './commands/cisco/config/Crypto';
import { CiscoRouterConfigDomainCommand } from './commands/cisco/config/Domain';
import { CiscoRouterConfigTftpServerCommand } from './commands/cisco/config/TftpServer';
import { CiscoRouterConfigBannerCommand } from './commands/cisco/config/Banner';
import { CiscoRouterGlobalCdpCommand } from './commands/cisco/config/Cdp';
import { CiscoRouterConfigEnableCommand } from './commands/cisco/config/Enable';
import { CiscoRouterConfigServiceCommand } from './commands/cisco/config/Service';
import { CiscoRouterConfigSnmpServerCommand } from './commands/cisco/config/SnmpServer';
import { CiscoRouterHostnameCommand } from './commands/cisco/config/Hostname';
import { CiscoRouterInterfaceCommand } from './commands/cisco/config/Interface';
import { CiscoRouterConfigIpCommand } from './commands/cisco/config/Ip';
import { CiscoRouterConfigLineCommand } from './commands/cisco/config/Line';
import { CiscoRouterConfigLldpCommand } from './commands/cisco/config/Lldp';
import { CiscoRouterConfigLoggingCommand } from './commands/cisco/config/Logging';
import { CiscoRouterConfigNoCommand } from './commands/cisco/config/No';
import { CiscoRouterConfigNtpCommand } from './commands/cisco/config/Ntp';
import { CiscoRouterConfigRouterCommand } from './commands/cisco/config/Router';
import { CiscoRouterConfigUsernameCommand } from './commands/cisco/config/Username';
// ─── privileged (exec) ──────────────────────────────────────────────
import { CiscoRouterClearCommand } from './commands/cisco/privileged/Clear';
import { CiscoRouterCopyCommand } from './commands/cisco/privileged/Copy';
import { CiscoRouterPingCommand } from './commands/cisco/privileged/Ping';
import { CiscoRouterReloadCommand } from './commands/cisco/privileged/Reload';
import { CiscoRouterTerminalCommand } from './commands/cisco/privileged/Terminal';
import { CiscoRouterWriteCommand } from './commands/cisco/privileged/Write';
// ─── config-if ──────────────────────────────────────────────────────
import { CiscoRouterConfigIfArpCommand } from './commands/cisco/config/config-if/Arp';
import { CiscoRouterConfigIfBandwidthCommand } from './commands/cisco/config/config-if/Bandwidth';
import { CiscoRouterConfigIfChannelGroupCommand } from './commands/cisco/config/config-if/ChannelGroup';
import { CiscoRouterConfigIfCryptoCommand } from './commands/cisco/config/config-if/Crypto';
import { CiscoRouterConfigIfStandbyCommand } from './commands/cisco/config/config-if/Standby';
import { CiscoRouterConfigIfCdpCommand } from './commands/cisco/config/config-if/Cdp';
import { CiscoRouterConfigIfDelayCommand } from './commands/cisco/config/config-if/Delay';
import { CiscoRouterDescriptionCommand } from './commands/cisco/config/config-if/Description';
import { CiscoRouterConfigIfDuplexCommand } from './commands/cisco/config/config-if/Duplex';
import { CiscoRouterEncapsulationCommand } from './commands/cisco/config/config-if/Encapsulation';
import { CiscoRouterConfigIfHoldQueueCommand } from './commands/cisco/config/config-if/HoldQueue';
import { CiscoRouterConfigIfIpCommand } from './commands/cisco/config/config-if/Ip';
import { CiscoRouterConfigIfKeepaliveCommand } from './commands/cisco/config/config-if/Keepalive';
import { CiscoRouterConfigIfMtuCommand } from './commands/cisco/config/config-if/Mtu';
import { CiscoRouterConfigIfNoCommand } from './commands/cisco/config/config-if/No';
import { CiscoRouterShutdownCommand } from './commands/cisco/config/config-if/Shutdown';
import { CiscoRouterConfigIfSpeedCommand } from './commands/cisco/config/config-if/Speed';
// ─── config-router ──────────────────────────────────────────────────
import { CiscoRouterConfigRouterAreaCommand } from './commands/cisco/config/config-router/Area';
import { CiscoRouterConfigRouterAutoSummaryCommand } from './commands/cisco/config/config-router/AutoSummary';
import { CiscoRouterConfigRouterDefaultInformationCommand } from './commands/cisco/config/config-router/DefaultInformation';
import { CiscoRouterConfigRouterRedistributeCommand } from './commands/cisco/config/config-router/Redistribute';
import { CiscoRouterConfigRouterDistanceCommand } from './commands/cisco/config/config-router/Distance';
import { CiscoRouterConfigRouterMaximumPathsCommand } from './commands/cisco/config/config-router/MaximumPaths';
import { CiscoRouterConfigRouterNeighborCommand } from './commands/cisco/config/config-router/Neighbor';
import { CiscoRouterConfigRouterNetworkCommand } from './commands/cisco/config/config-router/Network';
import { CiscoRouterConfigRouterPassiveInterfaceCommand } from './commands/cisco/config/config-router/PassiveInterface';
import { CiscoRouterConfigRouterRouterIdCommand } from './commands/cisco/config/config-router/RouterId';
import { CiscoRouterConfigRouterTimersCommand } from './commands/cisco/config/config-router/Timers';
// ─── config-line ────────────────────────────────────────────────────
import { CiscoRouterConfigLineExecTimeoutCommand } from './commands/cisco/config/config-line/ExecTimeout';
import { CiscoRouterConfigLineHistoryCommand } from './commands/cisco/config/config-line/History';
import { CiscoRouterConfigLineLoggingCommand } from './commands/cisco/config/config-line/Logging';
import { CiscoRouterConfigLineLoginCommand } from './commands/cisco/config/config-line/Login';
import { CiscoRouterConfigLinePasswordCommand } from './commands/cisco/config/config-line/Password';
import { CiscoRouterConfigLinePrivilegeCommand } from './commands/cisco/config/config-line/Privilege';
import { CiscoRouterConfigLineTransportCommand } from './commands/cisco/config/config-line/Transport';

export function createCiscoRouterHostShell(
  router: Router,
  errorFormatter?: KernelErrorFormatter,
): {
  interpreter: CliInterpreter;
  machine: RouterMachineApi;
  promptBuilder: CliPromptBuilder;
} {
  const showSub = new CommandRegistry();
  showSub.register(() => new CiscoRouterShowVersionCommand());
  showSub.register(() => new CiscoRouterShowIpCommand());
  showSub.register(() => new CiscoRouterShowRunningConfigCommand());
  showSub.register(() => new CiscoRouterShowArpCommand());
  showSub.register(() => new CiscoRouterShowInterfacesCommand());
  showSub.register(() => new CiscoRouterShowClockCommand());
  showSub.register(() => new CiscoRouterShowCdpCommand());
  showSub.register(() => new CiscoRouterShowUsersCommand());
  showSub.register(() => new CiscoRouterShowMemoryCommand());
  showSub.register(() => new CiscoRouterShowProcessesCommand());
  showSub.register(() => new CiscoRouterShowLoggingCommand());
  showSub.register(() => new CiscoRouterShowNtpCommand());
  showSub.register(() => new CiscoRouterShowFlashCommand());
  showSub.register(() => new CiscoRouterShowEnvironmentCommand());
  showSub.register(() => new CiscoRouterShowInventoryCommand());
  showSub.register(() => new CiscoRouterShowTechSupportCommand());
  showSub.register(() => new CiscoRouterShowSnmpCommand());
  showSub.register(() => new CiscoRouterShowLineCommand());
  showSub.register(() => new CiscoRouterShowSessionsCommand());
  showSub.register(() => new CiscoRouterShowHistoryCommand());
  showSub.register(() => new CiscoRouterShowStartupConfigCommand());
  showSub.register(() => new CiscoRouterShowVrfCommand());
  showSub.register(() => new CiscoRouterShowPolicyMapCommand());
  showSub.register(() => new CiscoRouterShowClassMapCommand());
  showSub.register(() => new CiscoRouterShowAccessListsCommand());
  showSub.register(() => new CiscoRouterShowRouteMapCommand());
  showSub.register(() => new CiscoRouterShowBuffersCommand());
  showSub.register(() => new CiscoRouterShowControllersCommand());
  showSub.register(() => new CiscoRouterShowSshCommand());
  showSub.register(() => new CiscoRouterShowBootCommand());
  showSub.register(() => new CiscoRouterShowLldpCommand());

  const userRegistry = new CommandRegistry();
  const privilegedRegistry = new CommandRegistry();
  const configRegistry = new CommandRegistry();
  const configIfRegistry = new CommandRegistry();
  const configRouterRegistry = new CommandRegistry();
  const configLineRegistry = new CommandRegistry();

  userRegistry.register(() => new CiscoEnableCommand());
  userRegistry.register(() => createCiscoShowCommand(showSub));
  userRegistry.register(() => new PopModeCommand('exit', 'Exit from the current mode'));
  userRegistry.register(() => new PopModeCommand('logout', 'Exit from the EXEC'));

  privilegedRegistry.register(() => new CiscoDisableCommand());
  privilegedRegistry.register(() => new CiscoConfigureCommand());
  privilegedRegistry.register(() => createCiscoShowCommand(showSub));
  privilegedRegistry.register(() => new CiscoRouterTerminalCommand());
  privilegedRegistry.register(() => new CiscoRouterClearCommand());
  privilegedRegistry.register(() => new CiscoRouterWriteCommand());
  privilegedRegistry.register(() => new CiscoRouterReloadCommand());
  privilegedRegistry.register(() => new CiscoRouterCopyCommand());
  privilegedRegistry.register(() => new CiscoRouterPingCommand());
  privilegedRegistry.register(() => new PopModeCommand('exit', 'Exit from the current mode'));
  privilegedRegistry.register(() => new PopModeCommand('logout', 'Exit from the EXEC'));

  configRegistry.register(() => new CiscoRouterHostnameCommand());
  configRegistry.register(() => new CiscoRouterInterfaceCommand());
  configRegistry.register(() => new CiscoRouterConfigIpCommand());
  configRegistry.register(() => new CiscoRouterConfigNoCommand());
  configRegistry.register(() => new CiscoRouterConfigRouterCommand());
  configRegistry.register(() => new CiscoRouterConfigLineCommand());
  configRegistry.register(() => new CiscoRouterConfigNtpCommand());
  configRegistry.register(() => new CiscoRouterConfigLoggingCommand());
  configRegistry.register(() => new CiscoRouterConfigUsernameCommand());
  configRegistry.register(() => new CiscoRouterGlobalCdpCommand());
  configRegistry.register(() => new CiscoRouterConfigBannerCommand());
  configRegistry.register(() => new CiscoRouterConfigEnableCommand());
  configRegistry.register(() => new CiscoRouterConfigServiceCommand());
  configRegistry.register(() => new CiscoRouterConfigSnmpServerCommand());
  configRegistry.register(() => new CiscoRouterConfigAaaCommand());
  configRegistry.register(() => new CiscoRouterConfigTftpServerCommand());
  configRegistry.register(() => new CiscoRouterConfigBootCommand());
  configRegistry.register(() => new CiscoRouterConfigClockCommand());
  configRegistry.register(() => new CiscoRouterConfigCryptoCommand());
  configRegistry.register(() => new CiscoRouterConfigAccessListCommand());
  configRegistry.register(() => new CiscoRouterConfigAliasCommand());
  configRegistry.register(() => new CiscoRouterConfigDomainCommand());
  configRegistry.register(() => new CiscoRouterConfigLldpCommand());
  configRegistry.register(() => new PopModeCommand('exit', 'Exit from the current mode'));
  configRegistry.register(() => new EndCommand());

  configIfRegistry.register(() => new CiscoRouterShutdownCommand());
  configIfRegistry.register(() => new CiscoRouterConfigIfIpCommand());
  configIfRegistry.register(() => new CiscoRouterConfigIfNoCommand());
  configIfRegistry.register(() => new CiscoRouterDescriptionCommand());
  configIfRegistry.register(() => new CiscoRouterEncapsulationCommand());
  configIfRegistry.register(() => new CiscoRouterConfigIfMtuCommand());
  configIfRegistry.register(() => new CiscoRouterConfigIfBandwidthCommand());
  configIfRegistry.register(() => new CiscoRouterConfigIfDelayCommand());
  configIfRegistry.register(() => new CiscoRouterConfigIfKeepaliveCommand());
  configIfRegistry.register(() => new CiscoRouterConfigIfCdpCommand());
  configIfRegistry.register(() => new CiscoRouterConfigIfDuplexCommand());
  configIfRegistry.register(() => new CiscoRouterConfigIfSpeedCommand());
  configIfRegistry.register(() => new CiscoRouterConfigIfHoldQueueCommand());
  configIfRegistry.register(() => new CiscoRouterConfigIfArpCommand());
  configIfRegistry.register(() => new CiscoRouterConfigIfStandbyCommand());
  configIfRegistry.register(() => new CiscoRouterConfigIfChannelGroupCommand());
  configIfRegistry.register(() => new CiscoRouterConfigIfCryptoCommand());
  configIfRegistry.register(() => new PopModeCommand('exit', 'Exit from the current mode'));
  configIfRegistry.register(() => new EndCommand());

  configRouterRegistry.register(() => new CiscoRouterConfigRouterNetworkCommand());
  configRouterRegistry.register(() => new CiscoRouterConfigRouterRouterIdCommand());
  configRouterRegistry.register(() => new CiscoRouterConfigRouterPassiveInterfaceCommand());
  configRouterRegistry.register(() => new CiscoRouterConfigRouterNeighborCommand());
  configRouterRegistry.register(() => new CiscoRouterConfigRouterAutoSummaryCommand());
  configRouterRegistry.register(() => new CiscoRouterConfigRouterMaximumPathsCommand());
  configRouterRegistry.register(() => new CiscoRouterConfigRouterDefaultInformationCommand());
  configRouterRegistry.register(() => new CiscoRouterConfigRouterDistanceCommand());
  configRouterRegistry.register(() => new CiscoRouterConfigRouterTimersCommand());
  configRouterRegistry.register(() => new CiscoRouterConfigRouterAreaCommand());
  configRouterRegistry.register(() => new CiscoRouterConfigRouterRedistributeCommand());
  configRouterRegistry.register(() => new PopModeCommand('exit', 'Exit from the current mode'));
  configRouterRegistry.register(() => new EndCommand());

  configLineRegistry.register(() => new CiscoRouterConfigLinePasswordCommand());
  configLineRegistry.register(() => new CiscoRouterConfigLineLoginCommand());
  configLineRegistry.register(() => new CiscoRouterConfigLineTransportCommand());
  configLineRegistry.register(() => new CiscoRouterConfigLineExecTimeoutCommand());
  configLineRegistry.register(() => new CiscoRouterConfigLineHistoryCommand());
  configLineRegistry.register(() => new CiscoRouterConfigLineLoggingCommand());
  configLineRegistry.register(() => new CiscoRouterConfigLinePrivilegeCommand());
  configLineRegistry.register(() => new PopModeCommand('exit', 'Exit from the current mode'));
  configLineRegistry.register(() => new EndCommand());

  const modes = new ModeRegistry([
    { name: 'user',           prompt: (_s, host) => `${host}>`,                parent: null,         registry: userRegistry },
    { name: 'privileged',     prompt: (_s, host) => `${host}#`,                parent: 'user',       registry: privilegedRegistry },
    { name: 'config',         prompt: (_s, host) => `${host}(config)#`,        parent: 'privileged', registry: configRegistry },
    { name: 'config-if',      prompt: (_s, host) => `${host}(config-if)#`,     parent: 'config',     registry: configIfRegistry, clearOnExit: ['selectedInterface'] },
    { name: 'config-router',  prompt: (_s, host) => `${host}(config-router)#`, parent: 'config',     registry: configRouterRegistry, clearOnExit: ['routerProto', 'routerId'] },
    { name: 'config-line',    prompt: (_s, host) => `${host}(config-line)#`,   parent: 'config',     registry: configLineRegistry, clearOnExit: ['lineType'] },
  ] satisfies CliMode[], { execLevel: 'privileged' });

  const machine = new RouterMachineApi({ router, modes });
  const interpreter = new CliInterpreter(modes, machine, new PermissionGuard(), errorFormatter);
  const promptBuilder = new CliPromptBuilder(modes, () => machine.hostname);
  return { interpreter, machine, promptBuilder };
}
