import { CliInterpreter, CliPromptBuilder, EndCommand, ModeRegistry, PopModeCommand } from '@/command-kernel/cli';
import type { CliMode } from '@/command-kernel/cli';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import type { Switch } from '../../Switch';
import {
  CiscoConfigureCommand,
  CiscoDisableCommand,
  CiscoEnableCommand,
  createCiscoShowCommand,
} from '../../vendor-cli';
import { SwitchMachineApi } from './SwitchMachineApi';
import { CiscoSwitchShowVersionCommand } from './commands/cisco/show/Version';

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
export function createCiscoSwitchHostShell(sw: Switch): {
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

  const userRegistry = new CommandRegistry();
  const privilegedRegistry = new CommandRegistry();
  const configRegistry = new CommandRegistry();

  userRegistry.register(() => new CiscoEnableCommand());
  userRegistry.register(() => createCiscoShowCommand(showSub));
  userRegistry.register(() => new PopModeCommand('exit', 'Exit from the current mode'));
  userRegistry.register(() => new PopModeCommand('logout', 'Exit from the EXEC'));

  privilegedRegistry.register(() => new CiscoDisableCommand());
  privilegedRegistry.register(() => new CiscoConfigureCommand());
  privilegedRegistry.register(() => createCiscoShowCommand(showSub));
  privilegedRegistry.register(() => new PopModeCommand('exit', 'Exit from the current mode'));
  privilegedRegistry.register(() => new PopModeCommand('logout', 'Exit from the EXEC'));

  configRegistry.register(() => new PopModeCommand('exit', 'Exit from the current mode'));
  configRegistry.register(() => new EndCommand());

  const modes = new ModeRegistry([
    { name: 'user',       prompt: (_s, host) => `${host}>`,         parent: null,         registry: userRegistry },
    { name: 'privileged', prompt: (_s, host) => `${host}#`,         parent: 'user',       registry: privilegedRegistry },
    { name: 'config',     prompt: (_s, host) => `${host}(config)#`, parent: 'privileged', registry: configRegistry },
  ] satisfies CliMode[], { execLevel: 'privileged' });

  const machine = new SwitchMachineApi({ switch: sw, modes });
  const interpreter = new CliInterpreter(modes, machine);
  const promptBuilder = new CliPromptBuilder(modes, () => machine.hostname);
  return { interpreter, machine, promptBuilder };
}
