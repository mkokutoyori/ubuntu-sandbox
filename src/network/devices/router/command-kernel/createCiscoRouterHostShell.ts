import { CliInterpreter, CliPromptBuilder, EndCommand, ModeRegistry, PopModeCommand } from '@/command-kernel/cli';
import type { CliMode } from '@/command-kernel/cli';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import type { Router } from '../../Router';
import {
  CiscoConfigureCommand,
  CiscoDisableCommand,
  CiscoEnableCommand,
  createCiscoShowCommand,
} from '../../vendor-cli';
import { RouterMachineApi } from './RouterMachineApi';
import { CiscoRouterShowIpCommand } from './commands/cisco/show/Ip';
import { CiscoRouterShowVersionCommand } from './commands/cisco/show/Version';
import { CiscoRouterHostnameCommand } from './commands/cisco/config/Hostname';
import { CiscoRouterInterfaceCommand } from './commands/cisco/config/Interface';
import { CiscoRouterConfigIpCommand } from './commands/cisco/config/Ip';
import { CiscoRouterConfigNoCommand } from './commands/cisco/config/No';
import { CiscoRouterDescriptionCommand } from './commands/cisco/config/config-if/Description';
import { CiscoRouterConfigIfIpCommand } from './commands/cisco/config/config-if/Ip';
import { CiscoRouterConfigIfNoCommand } from './commands/cisco/config/config-if/No';
import { CiscoRouterShutdownCommand } from './commands/cisco/config/config-if/Shutdown';

/**
 * =====================================================================
 *  Bootstrap CLI vendeur Cisco IOS pour routeur — modes, registres,
 *  interpréteur
 * =====================================================================
 *
 *  Structure des modes Cisco IOS (routeur) :
 *
 *    user (racine, prompt `>`)
 *      └── privileged (prompt `#`, exec-level)
 *            └── config (prompt `(config)#`)
 *                  ├── config-if, config-router, config-line, …
 *                        (à ajouter au fil des migrations)
 *
 *  Les commandes de transition (`enable`, `disable`, `configure
 *  terminal`) viennent de `vendor-cli/cisco/` — IDENTIQUES sur routeur
 *  et switch, jamais dupliquées.
 *
 *  Les sous-commandes de `show` sont routeur-spécifiques (`show
 *  version` avec bannière ISR2911, `show ip route`…) — enregistrées ici
 *  dans le sous-registre passé à `createCiscoShowCommand()`.
 */
export function createCiscoRouterHostShell(router: Router): {
  interpreter: CliInterpreter;
  machine: RouterMachineApi;
  promptBuilder: CliPromptBuilder;
} {
  // Sous-registre `show` — routeur-spécifique : sous-commandes L3
  // (routing, ACL, NAT, running-config, …). Chaque sous-commande
  // migrée s'y ajoute.
  const showSub = new CommandRegistry();
  showSub.register(() => new CiscoRouterShowVersionCommand());
  showSub.register(() => new CiscoRouterShowIpCommand());

  const userRegistry = new CommandRegistry();
  const privilegedRegistry = new CommandRegistry();
  const configRegistry = new CommandRegistry();
  const configIfRegistry = new CommandRegistry();

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
  configRegistry.register(() => new PopModeCommand('exit', 'Exit from the current mode'));
  configRegistry.register(() => new EndCommand());

  configIfRegistry.register(() => new CiscoRouterShutdownCommand());
  configIfRegistry.register(() => new CiscoRouterConfigIfIpCommand());
  configIfRegistry.register(() => new CiscoRouterConfigIfNoCommand());
  configIfRegistry.register(() => new CiscoRouterDescriptionCommand());
  configIfRegistry.register(() => new PopModeCommand('exit', 'Exit from the current mode'));
  configIfRegistry.register(() => new EndCommand());

  const modes = new ModeRegistry([
    { name: 'user',       prompt: (_s, host) => `${host}>`,             parent: null,         registry: userRegistry },
    { name: 'privileged', prompt: (_s, host) => `${host}#`,             parent: 'user',       registry: privilegedRegistry },
    { name: 'config',     prompt: (_s, host) => `${host}(config)#`,     parent: 'privileged', registry: configRegistry },
    { name: 'config-if',  prompt: (_s, host) => `${host}(config-if)#`,  parent: 'config',     registry: configIfRegistry, clearOnExit: ['selectedInterface'] },
  ] satisfies CliMode[], { execLevel: 'privileged' });

  const machine = new RouterMachineApi({ router, modes });
  const interpreter = new CliInterpreter(modes, machine);
  const promptBuilder = new CliPromptBuilder(modes, () => machine.hostname);
  return { interpreter, machine, promptBuilder };
}
