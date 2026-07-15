import { CliInterpreter, CliPromptBuilder, EndCommand, ModeRegistry, PopModeCommand } from '@/command-kernel/cli';
import type { CliMode } from '@/command-kernel/cli';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import type { Router } from '../../Router';
import { RouterMachineApi } from './RouterMachineApi';
import { CiscoConfigureCommand } from './commands/cisco/ConfigureTerminal';
import { CiscoDisableCommand } from './commands/cisco/Disable';
import { CiscoEnableCommand } from './commands/cisco/Enable';
import { CiscoShowCommand } from './commands/cisco/Show';

/**
 * =====================================================================
 *  Bootstrap CLI vendeur Cisco IOS — modes, registres, interpréteur
 * =====================================================================
 *
 *  Structure des modes Cisco IOS (miroir de `CISCO_IOS_MODES` legacy) :
 *
 *    user (racine, prompt `>`)
 *      └── privileged (prompt `#`)
 *            └── config (prompt `(config)#`)
 *                  ├── config-if
 *                  ├── config-line
 *                  ├── config-router
 *                  └── … (tous les config-* migrés au fur et à mesure)
 *
 *  Chaque mode a son propre `CommandRegistry`. Les commandes qui vivent
 *  dans plusieurs modes (`show`, `exit`, `end`…) sont enregistrées dans
 *  chacun — la mécanique `allowedModes` sert de filtre supplémentaire
 *  quand une commande partagée doit refuser un mode précis.
 *
 *  Ce fichier n'importe RIEN du legacy — ni `CiscoIOSShell`, ni
 *  `CiscoShowCommands`, ni `CommandTrie`. Les commandes réutilisent le
 *  socle CLI et lisent leurs données via `RouterMachineApi`.
 */
export function createCiscoRouterHostShell(router: Router): {
  interpreter: CliInterpreter;
  machine: RouterMachineApi;
  promptBuilder: CliPromptBuilder;
} {
  // Registres par mode — construits vides, puis peuplés ci-dessous.
  // Chaque registre reçoit UNIQUEMENT les commandes valides dans son
  // mode (le mécanisme `allowedModes` est un contrôle supplémentaire,
  // pas un remplacement de la ségrégation par registre).
  const userRegistry = new CommandRegistry();
  const privilegedRegistry = new CommandRegistry();
  const configRegistry = new CommandRegistry();

  // Commandes universelles CLI (partagées entre modes).
  userRegistry.register(() => new CiscoEnableCommand());
  userRegistry.register(() => new CiscoShowCommand());
  userRegistry.register(() => new PopModeCommand('exit', 'Exit from the current mode'));
  userRegistry.register(() => new PopModeCommand('logout', 'Exit from the EXEC'));

  privilegedRegistry.register(() => new CiscoDisableCommand());
  privilegedRegistry.register(() => new CiscoConfigureCommand());
  privilegedRegistry.register(() => new CiscoShowCommand());
  privilegedRegistry.register(() => new PopModeCommand('exit', 'Exit from the current mode'));
  privilegedRegistry.register(() => new PopModeCommand('logout', 'Exit from the EXEC'));

  configRegistry.register(() => new PopModeCommand('exit', 'Exit from the current mode'));
  configRegistry.register(() => new EndCommand());

  // Table des modes — mêmes noms que `CISCO_IOS_MODES` legacy pour
  // garder la parité des prompts.
  const modes = new ModeRegistry([
    { name: 'user',       prompt: (_s, host) => `${host}>`,          parent: null,         registry: userRegistry },
    { name: 'privileged', prompt: (_s, host) => `${host}#`,          parent: 'user',       registry: privilegedRegistry },
    { name: 'config',     prompt: (_s, host) => `${host}(config)#`,  parent: 'privileged', registry: configRegistry },
  ] satisfies CliMode[], { execLevel: 'privileged' });

  const machine = new RouterMachineApi({ router, modes });
  const interpreter = new CliInterpreter(modes, machine);
  const promptBuilder = new CliPromptBuilder(modes, () => machine.hostname);
  return { interpreter, machine, promptBuilder };
}
