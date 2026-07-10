import { EchoCommand } from "./commands/echo-command";
import { CommandRegistry } from "./registry/command-registry";
import { ExitCommand } from "./shell/exit";

/**
 * Commandes universelles, identiques quel que soit le profil d'équipement.
 * Chaque bootstrap par type de matériel (createLinuxHostShell,
 * createSwitchShell, createRouterShell…) appelle ceci en premier pour
 * éviter toute duplication entre profils.
 */
export function registerCoreCommands(registry: CommandRegistry): void {
  registry.register(() => new ExitCommand());
  registry.register(() => new EchoCommand());
}
