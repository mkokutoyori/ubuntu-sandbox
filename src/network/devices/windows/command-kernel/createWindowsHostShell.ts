import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { CmdInterpreter } from './CmdInterpreter';
import { CdCommand } from './commands/Cd';
import { ChcpCommand } from './commands/Chcp';
import { ClsCommand } from './commands/Cls';
import { CopyCommand } from './commands/Copy';
import { DateCommand } from './commands/Date';
import { DelCommand } from './commands/Del';
import { DirCommand } from './commands/Dir';
import { WinEchoCommand } from './commands/Echo';
import { FindstrCommand } from './commands/Findstr';
import { HostnameCommand } from './commands/Hostname';
import { MkdirCommand } from './commands/Mkdir';
import { MoveCommand } from './commands/Move';
import { RenCommand } from './commands/Ren';
import { RmdirCommand } from './commands/Rmdir';
import { NetstatCommand } from './commands/Netstat';
import { ScCommand } from './commands/Sc';
import { SetCommand } from './commands/Set';
import { SysteminfoCommand } from './commands/Systeminfo';
import { TaskkillCommand } from './commands/Taskkill';
import { TasklistCommand } from './commands/Tasklist';
import { TimeCommand } from './commands/Time';
import { WmicCommand } from './commands/Wmic';
import { TreeCommand } from './commands/Tree';
import { TypeCommand } from './commands/Type';
import { VerCommand } from './commands/Ver';
import { VolCommand } from './commands/Vol';
import { WindowsMachineApi, WindowsMachineApiDeps } from './WindowsMachineApi';

/**
 * Assemble le registre de commandes cmd.exe migrées et le `CmdInterpreter`
 * qui les exécute — l'unique point d'entrée que `WindowsPC` doit connaître
 * (migration_framework.md §6).
 */
export function createWindowsHostShell(deps: WindowsMachineApiDeps): { registry: CommandRegistry; interpreter: CmdInterpreter } {
  const registry = new CommandRegistry();
  const machine = new WindowsMachineApi(deps);

  registry.register(() => new CdCommand());
  registry.register(() => new MkdirCommand());
  registry.register(() => new RmdirCommand());
  registry.register(() => new TypeCommand());
  registry.register(() => new CopyCommand());
  registry.register(() => new MoveCommand());
  registry.register(() => new RenCommand());
  registry.register(() => new DelCommand());
  registry.register(() => new TreeCommand());
  registry.register(() => new SetCommand());
  registry.register(() => new ClsCommand());
  registry.register(() => new WinEchoCommand());
  registry.register(() => new DirCommand());
  registry.register(() => new VerCommand());
  registry.register(() => new HostnameCommand());
  registry.register(() => new VolCommand());
  registry.register(() => new ChcpCommand());
  registry.register(() => new DateCommand());
  registry.register(() => new TimeCommand());
  registry.register(() => new SysteminfoCommand());
  registry.register(() => new TasklistCommand());
  registry.register(() => new TaskkillCommand());
  registry.register(() => new NetstatCommand());
  registry.register(() => new ScCommand());
  registry.register(() => new WmicCommand());
  registry.register(() => new FindstrCommand());

  const interpreter = new CmdInterpreter(registry, machine);

  return { registry, interpreter };
}
