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
import { CiscoRouterShowInterfacesCommand } from './commands/cisco/show/Interfaces';
import { CiscoRouterShowIpCommand } from './commands/cisco/show/Ip';
import { CiscoRouterShowRunningConfigCommand } from './commands/cisco/show/RunningConfig';
import { CiscoRouterShowVersionCommand } from './commands/cisco/show/Version';
// ─── config ─────────────────────────────────────────────────────────
import { CiscoRouterGlobalCdpCommand } from './commands/cisco/config/Cdp';
import { CiscoRouterHostnameCommand } from './commands/cisco/config/Hostname';
import { CiscoRouterInterfaceCommand } from './commands/cisco/config/Interface';
import { CiscoRouterConfigIpCommand } from './commands/cisco/config/Ip';
import { CiscoRouterConfigLineCommand } from './commands/cisco/config/Line';
import { CiscoRouterConfigLoggingCommand } from './commands/cisco/config/Logging';
import { CiscoRouterConfigNoCommand } from './commands/cisco/config/No';
import { CiscoRouterConfigNtpCommand } from './commands/cisco/config/Ntp';
import { CiscoRouterConfigRouterCommand } from './commands/cisco/config/Router';
import { CiscoRouterConfigUsernameCommand } from './commands/cisco/config/Username';
// ─── config-if ──────────────────────────────────────────────────────
import { CiscoRouterConfigIfBandwidthCommand } from './commands/cisco/config/config-if/Bandwidth';
import { CiscoRouterConfigIfCdpCommand } from './commands/cisco/config/config-if/Cdp';
import { CiscoRouterConfigIfDelayCommand } from './commands/cisco/config/config-if/Delay';
import { CiscoRouterDescriptionCommand } from './commands/cisco/config/config-if/Description';
import { CiscoRouterEncapsulationCommand } from './commands/cisco/config/config-if/Encapsulation';
import { CiscoRouterConfigIfIpCommand } from './commands/cisco/config/config-if/Ip';
import { CiscoRouterConfigIfKeepaliveCommand } from './commands/cisco/config/config-if/Keepalive';
import { CiscoRouterConfigIfMtuCommand } from './commands/cisco/config/config-if/Mtu';
import { CiscoRouterConfigIfNoCommand } from './commands/cisco/config/config-if/No';
import { CiscoRouterShutdownCommand } from './commands/cisco/config/config-if/Shutdown';
// ─── config-router ──────────────────────────────────────────────────
import { CiscoRouterConfigRouterNeighborCommand } from './commands/cisco/config/config-router/Neighbor';
import { CiscoRouterConfigRouterNetworkCommand } from './commands/cisco/config/config-router/Network';
import { CiscoRouterConfigRouterPassiveInterfaceCommand } from './commands/cisco/config/config-router/PassiveInterface';
import { CiscoRouterConfigRouterRouterIdCommand } from './commands/cisco/config/config-router/RouterId';
// ─── config-line ────────────────────────────────────────────────────
import { CiscoRouterConfigLineLoginCommand } from './commands/cisco/config/config-line/Login';
import { CiscoRouterConfigLinePasswordCommand } from './commands/cisco/config/config-line/Password';
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
  configIfRegistry.register(() => new PopModeCommand('exit', 'Exit from the current mode'));
  configIfRegistry.register(() => new EndCommand());

  configRouterRegistry.register(() => new CiscoRouterConfigRouterNetworkCommand());
  configRouterRegistry.register(() => new CiscoRouterConfigRouterRouterIdCommand());
  configRouterRegistry.register(() => new CiscoRouterConfigRouterPassiveInterfaceCommand());
  configRouterRegistry.register(() => new CiscoRouterConfigRouterNeighborCommand());
  configRouterRegistry.register(() => new PopModeCommand('exit', 'Exit from the current mode'));
  configRouterRegistry.register(() => new EndCommand());

  configLineRegistry.register(() => new CiscoRouterConfigLinePasswordCommand());
  configLineRegistry.register(() => new CiscoRouterConfigLineLoginCommand());
  configLineRegistry.register(() => new CiscoRouterConfigLineTransportCommand());
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
