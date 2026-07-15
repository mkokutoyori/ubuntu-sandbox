import { CliInterpreter, CliPromptBuilder, EndCommand, ModeRegistry, PopModeCommand } from '@/command-kernel/cli';
import type { CliMode } from '@/command-kernel/cli';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import type { Router } from '../../Router';
import { RouterMachineApi } from './RouterMachineApi';
import { HuaweiDisplayCommand } from './commands/huawei/Display';
import { HuaweiSystemViewCommand } from './commands/huawei/SystemView';

/**
 * =====================================================================
 *  Bootstrap CLI vendeur Huawei VRP — modes, registres, interpréteur
 * =====================================================================
 *
 *  Structure des modes Huawei VRP :
 *
 *    user-view (racine, prompt `<host>`)
 *      └── system-view (prompt `[host]`)
 *            └── interface, ospf, bgp, ipsec-policy, dhcp-pool… (à
 *                venir au fur et à mesure des migrations)
 *
 *  Contrairement à Cisco, VRP n'a pas de mode « privileged » séparé :
 *  `user-view` est déjà exécutif, `system-view` est la configuration.
 *  La transition passe par `system-view` (au lieu de `enable` +
 *  `configure terminal`).
 */
export function createHuaweiRouterHostShell(router: Router): {
  interpreter: CliInterpreter;
  machine: RouterMachineApi;
  promptBuilder: CliPromptBuilder;
} {
  const userViewRegistry = new CommandRegistry();
  const systemViewRegistry = new CommandRegistry();

  userViewRegistry.register(() => new HuaweiDisplayCommand());
  userViewRegistry.register(() => new HuaweiSystemViewCommand());
  userViewRegistry.register(() => new PopModeCommand('quit', 'Exit from the current view'));

  systemViewRegistry.register(() => new HuaweiDisplayCommand());
  systemViewRegistry.register(() => new PopModeCommand('quit', 'Exit from the current view'));
  // VRP `return` = équivalent Cisco `end` : retour direct à user-view.
  // Le socle expose `EndCommand` avec un alias vendeur ; le vrai
  // renommage `return` sera fait par une sous-classe dédiée le jour où
  // la sémantique diffère de `end` sur un point précis.
  systemViewRegistry.register(() => new EndCommand());

  const modes = new ModeRegistry([
    { name: 'user-view',   prompt: (_s, host) => `<${host}>`, parent: null,        registry: userViewRegistry },
    { name: 'system-view', prompt: (_s, host) => `[${host}]`, parent: 'user-view', registry: systemViewRegistry },
  ] satisfies CliMode[]);

  const machine = new RouterMachineApi({ router, modes });
  const interpreter = new CliInterpreter(modes, machine);
  const promptBuilder = new CliPromptBuilder(modes, () => machine.hostname);
  return { interpreter, machine, promptBuilder };
}
