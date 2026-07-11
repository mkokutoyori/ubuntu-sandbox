import { Interpreter } from '@/command-kernel/interpreter';
import { Parser } from '@/command-kernel/ast/parser';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { CmdExpander } from './ast/CmdExpander';
import { CmdLexer } from './ast/CmdLexer';
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
 * cmd.exe syntax (`%VAR%` expansion, bare `&` chaining, no single-quote
 * strings) diverges too far from command-kernel's bash-flavoured `Lexer`
 * to reuse it — `CmdLexer` tokenizes cmd's own grammar instead. The
 * shared `Parser` (ast/parser.ts) is reused as-is: it is already generic
 * over `Token`/`TokenType` and never assumes bash-specific syntax beyond
 * the token stream it's given — `&&`/`||`/`|`/`>`/`>>`/`<` map directly,
 * and bare `&` (unconditional chaining) is emitted as `TokenType.SEMI`,
 * the same token bash's `;` uses for "always run the next statement".
 * Only the tokenizer and the `%VAR%` expansion are vendor-specific.
 */
export function createWindowsHostShell(deps: WindowsMachineApiDeps): { registry: CommandRegistry; interpreter: Interpreter } {
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

  const interpreter = new Interpreter(registry, machine, {
    lexer: new CmdLexer(),
    parser: new Parser(),
    expander: new CmdExpander(),
  });

  return { registry, interpreter };
}
