import { CliInterpreter, CliPromptBuilder, EndCommand, ModeRegistry, PopModeCommand } from '@/command-kernel/cli';
import type { CliMode } from '@/command-kernel/cli';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import type { Switch } from '../../Switch';
import { createHuaweiDisplayCommand, HuaweiSystemViewCommand } from '../../vendor-cli';
import { SwitchMachineApi } from './SwitchMachineApi';
import { HuaweiSwitchDisplayVersionCommand } from './commands/huawei/display/Version';

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
 *            ├── vlan          (à venir)
 *            ├── interface     (à venir)
 *            └── stp / mstp    (à venir)
 *
 *  `system-view`/`quit` viennent de `vendor-cli/huawei/` — IDENTIQUES
 *  à celles du routeur. Sous-registre `display` propre au switch
 *  (S5720 pour l'instant, seule `version` migrée).
 */
export function createHuaweiSwitchHostShell(sw: Switch): {
  interpreter: CliInterpreter;
  machine: SwitchMachineApi;
  promptBuilder: CliPromptBuilder;
} {
  const displaySub = new CommandRegistry();
  displaySub.register(() => new HuaweiSwitchDisplayVersionCommand());

  const userViewRegistry = new CommandRegistry();
  const systemViewRegistry = new CommandRegistry();

  userViewRegistry.register(() => createHuaweiDisplayCommand(displaySub));
  userViewRegistry.register(() => new HuaweiSystemViewCommand());
  userViewRegistry.register(() => new PopModeCommand('quit', 'Exit from the current view'));

  systemViewRegistry.register(() => createHuaweiDisplayCommand(displaySub));
  systemViewRegistry.register(() => new PopModeCommand('quit', 'Exit from the current view'));
  systemViewRegistry.register(() => new EndCommand());

  const modes = new ModeRegistry([
    { name: 'user-view',   prompt: (_s, host) => `<${host}>`, parent: null,        registry: userViewRegistry },
    { name: 'system-view', prompt: (_s, host) => `[${host}]`, parent: 'user-view', registry: systemViewRegistry },
  ] satisfies CliMode[]);

  const machine = new SwitchMachineApi({ switch: sw, modes });
  const interpreter = new CliInterpreter(modes, machine);
  const promptBuilder = new CliPromptBuilder(modes, () => machine.hostname);
  return { interpreter, machine, promptBuilder };
}
