import { CatCommand } from "./commands/cat-command";
import { ShutdownCommand } from "./commands/shutdown-command";
import { Interpreter } from "./interpreter";
import { MachineApi } from "./machine/types";
import { CommandRegistry } from "./registry/command-registry";
import { registerCoreCommands } from "./register-core-commands";

export function createShell(machine: MachineApi): Interpreter {
  const registry = new CommandRegistry();

  registerCoreCommands(registry);
  registry.register(() => new CatCommand());
  registry.register(() => new ShutdownCommand());

  // Une commande développée à part s'enregistre exactement pareil :
  //   import { MyCustomCommand } from "./commands/my-custom-command";
  //   registry.register(() => new MyCustomCommand());

  return new Interpreter(registry, machine);
}
