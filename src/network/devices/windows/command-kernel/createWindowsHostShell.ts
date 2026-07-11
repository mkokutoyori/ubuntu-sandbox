import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { Executor } from '@/command-kernel/exec/executor';
import { CdCommand } from './commands/Cd';
import { ClsCommand } from './commands/Cls';
import { CopyCommand } from './commands/Copy';
import { DelCommand } from './commands/Del';
import { WinEchoCommand } from './commands/Echo';
import { MkdirCommand } from './commands/Mkdir';
import { MoveCommand } from './commands/Move';
import { RenCommand } from './commands/Ren';
import { RmdirCommand } from './commands/Rmdir';
import { SetCommand } from './commands/Set';
import { TreeCommand } from './commands/Tree';
import { TypeCommand } from './commands/Type';
import { WindowsMachineApi, WindowsMachineApiDeps } from './WindowsMachineApi';

/**
 * cmd.exe syntax (`%VAR%` expansion, bare `&` chaining, drive letters,
 * doskey macros, .bat scripts) diverges too far from command-kernel's
 * bash-flavoured Lexer/Parser to route raw command lines through it.
 * `WindowsPC.executeCmdCommand` already does that parsing itself, so this
 * shell skips `Interpreter` (Lexer → Parser → Executor) and exposes the
 * bare `CommandRegistry` + `Executor` — the caller builds a `SimpleCommandNode`
 * directly from its own already-split `cmd`/`args`.
 */
export function createWindowsHostShell(deps: WindowsMachineApiDeps): { registry: CommandRegistry; executor: Executor } {
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

  return { registry, executor: new Executor(registry, machine) };
}
