import { Interpreter } from '@/command-kernel/interpreter';
import { registerCoreCommands } from '@/command-kernel/register-core-commands';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { CatCommand } from './commands/Cat';
import { CdCommand } from './commands/Cd';
import { ChmodCommand } from './commands/Chmod';
import { ChownCommand } from './commands/Chown';
import { CpCommand } from './commands/Cp';
import { LsCommand } from './commands/Ls';
import { MkdirCommand } from './commands/Mkdir';
import { MvCommand } from './commands/Mv';
import { PwdCommand } from './commands/Pwd';
import { RmCommand } from './commands/Rm';
import { StatCommand } from './commands/Stat';
import { TouchCommand } from './commands/Touch';
import { LinuxMachineApi, LinuxMachineApiDeps } from './LinuxMachineApi';

export function createLinuxHostShell(deps: LinuxMachineApiDeps): Interpreter {
  const registry = new CommandRegistry();
  const machine = new LinuxMachineApi(deps);

  registerCoreCommands(registry);
  registry.register(() => new PwdCommand());
  registry.register(() => new CdCommand());
  registry.register(() => new LsCommand());
  registry.register(() => new CatCommand());
  registry.register(() => new MkdirCommand());
  registry.register(() => new TouchCommand());
  registry.register(() => new RmCommand());
  registry.register(() => new CpCommand());
  registry.register(() => new MvCommand());
  registry.register(() => new StatCommand());
  registry.register(() => new ChmodCommand());
  registry.register(() => new ChownCommand());

  return new Interpreter(registry, machine);
}
