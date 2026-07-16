import { CliInterpreter, CliPromptBuilder, EndCommand, ModeRegistry, PopModeCommand } from '@/command-kernel/cli';
import type { CliMode, KernelErrorFormatter } from '@/command-kernel/cli';
import { PermissionGuard } from '@/command-kernel/exec/permission-guard';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import type { Router } from '../../Router';
import { createHuaweiDisplayCommand, HuaweiDisplayClockCommand, HuaweiSaveCommand, HuaweiSystemViewCommand } from '../../vendor-cli';
import { RouterMachineApi } from './RouterMachineApi';
import { HuaweiRouterDisplayVersionCommand } from './commands/huawei/display/Version';
import { HuaweiRouterDisplayIpCommand } from './commands/huawei/display/Ip';
import { HuaweiRouterDisplayCurrentConfigurationCommand } from './commands/huawei/display/CurrentConfiguration';
import { HuaweiRouterDisplayArpCommand } from './commands/huawei/display/Arp';
import { HuaweiRouterSysnameCommand } from './commands/huawei/system-view/Sysname';
import { HuaweiRouterInterfaceCommand } from './commands/huawei/system-view/Interface';
import { HuaweiRouterSysIpCommand } from './commands/huawei/system-view/Ip';
import { HuaweiRouterSysArpCommand } from './commands/huawei/system-view/Arp';
import { HuaweiRouterSysDhcpCommand } from './commands/huawei/system-view/Dhcp';
import { HuaweiRouterHeaderCommand } from './commands/huawei/system-view/Header';
import { HuaweiRouterStartupCommand } from './commands/huawei/user-view/Startup';
import { HuaweiRouterDisplaySavedConfigurationCommand } from './commands/huawei/display/SavedConfiguration';
import { HuaweiRouterIfMtuCommand } from './commands/huawei/interface-view/Mtu';
import { HuaweiRouterIfBandwidthCommand } from './commands/huawei/interface-view/Bandwidth';
import { HuaweiRouterIfSpeedCommand } from './commands/huawei/interface-view/Speed';
import { HuaweiRouterIfDuplexCommand } from './commands/huawei/interface-view/Duplex';
import { HuaweiRouterSysUndoCommand } from './commands/huawei/system-view/Undo';
import { HuaweiRouterIfIpCommand } from './commands/huawei/interface-view/Ip';
import { HuaweiRouterIfShutdownCommand } from './commands/huawei/interface-view/Shutdown';
import { HuaweiRouterIfDescriptionCommand } from './commands/huawei/interface-view/Description';
import { HuaweiRouterIfUndoCommand } from './commands/huawei/interface-view/Undo';

/**
 * =====================================================================
 *  Bootstrap CLI vendeur Huawei VRP pour routeur — modes, registres,
 *  interpréteur
 * =====================================================================
 *
 *  Structure VRP (routeur) :
 *
 *    user-view (racine, prompt `<host>`, exec-level)
 *      └── system-view (prompt `[host]`)
 *            └── interface-view (prompt `[host-<iface>]`)
 *                  └── ospf, bgp, ipsec-policy, dhcp-pool, …
 *                      (à ajouter au fil des migrations)
 *
 *  `system-view`/`quit` viennent de `vendor-cli/huawei/` — IDENTIQUES
 *  sur routeur et switch, jamais dupliquées. Les sous-commandes de
 *  `display` sont routeur-spécifiques.
 */
export function createHuaweiRouterHostShell(
  router: Router,
  errorFormatter?: KernelErrorFormatter,
): {
  interpreter: CliInterpreter;
  machine: RouterMachineApi;
  promptBuilder: CliPromptBuilder;
} {
  const displaySub = new CommandRegistry();
  displaySub.register(() => new HuaweiRouterDisplayVersionCommand());
  displaySub.register(() => new HuaweiRouterDisplayIpCommand());
  displaySub.register(() => new HuaweiDisplayClockCommand());
  displaySub.register(() => new HuaweiRouterDisplayCurrentConfigurationCommand());
  displaySub.register(() => new HuaweiRouterDisplaySavedConfigurationCommand());
  displaySub.register(() => new HuaweiRouterDisplayArpCommand());

  const userViewRegistry = new CommandRegistry();
  const systemViewRegistry = new CommandRegistry();
  const interfaceViewRegistry = new CommandRegistry();

  userViewRegistry.register(() => createHuaweiDisplayCommand(displaySub));
  userViewRegistry.register(() => new HuaweiSystemViewCommand());
  userViewRegistry.register(() => new HuaweiSaveCommand());
  userViewRegistry.register(() => new HuaweiRouterStartupCommand());
  userViewRegistry.register(() => new PopModeCommand('quit', 'Exit from the current view'));

  systemViewRegistry.register(() => createHuaweiDisplayCommand(displaySub));
  systemViewRegistry.register(() => new HuaweiSaveCommand());
  systemViewRegistry.register(() => new HuaweiRouterSysnameCommand());
  systemViewRegistry.register(() => new HuaweiRouterInterfaceCommand());
  systemViewRegistry.register(() => new HuaweiRouterSysIpCommand());
  systemViewRegistry.register(() => new HuaweiRouterSysArpCommand());
  systemViewRegistry.register(() => new HuaweiRouterSysDhcpCommand());
  systemViewRegistry.register(() => new HuaweiRouterHeaderCommand());
  systemViewRegistry.register(() => new HuaweiRouterSysUndoCommand());
  systemViewRegistry.register(() => new PopModeCommand('quit', 'Exit from the current view'));
  systemViewRegistry.register(() => new EndCommand(['return']));

  interfaceViewRegistry.register(() => new HuaweiRouterIfIpCommand());
  interfaceViewRegistry.register(() => new HuaweiRouterIfShutdownCommand());
  interfaceViewRegistry.register(() => new HuaweiRouterIfDescriptionCommand());
  interfaceViewRegistry.register(() => new HuaweiRouterIfMtuCommand());
  interfaceViewRegistry.register(() => new HuaweiRouterIfBandwidthCommand());
  interfaceViewRegistry.register(() => new HuaweiRouterIfSpeedCommand());
  interfaceViewRegistry.register(() => new HuaweiRouterIfDuplexCommand());
  interfaceViewRegistry.register(() => new HuaweiRouterIfUndoCommand());
  interfaceViewRegistry.register(() => new PopModeCommand('quit', 'Exit from the current view'));
  interfaceViewRegistry.register(() => new EndCommand(['return']));

  const modes = new ModeRegistry([
    { name: 'user-view',      prompt: (_s, host) => `<${host}>`,                                                            parent: null,           registry: userViewRegistry },
    { name: 'system-view',    prompt: (_s, host) => `[${host}]`,                                                             parent: 'user-view',    registry: systemViewRegistry },
    { name: 'interface-view', prompt: (s, host) => `[${host}-${s.promptFields.get('selectedInterface') ?? ''}]`,             parent: 'system-view',  registry: interfaceViewRegistry, clearOnExit: ['selectedInterface'] },
  ] satisfies CliMode[]);

  const machine = new RouterMachineApi({ router, modes });
  const interpreter = new CliInterpreter(modes, machine, new PermissionGuard(), errorFormatter);
  const promptBuilder = new CliPromptBuilder(modes, () => machine.hostname);
  return { interpreter, machine, promptBuilder };
}
