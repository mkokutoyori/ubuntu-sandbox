import { Interpreter } from '@/command-kernel/interpreter';
import { Parser } from '@/command-kernel/ast/parser';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { CmdExpander } from './ast/CmdExpander';
import { CmdLexer } from './ast/CmdLexer';
import { CdCommand } from './commands/Cd';
import { ChcpCommand } from './commands/Chcp';
import { ClsCommand } from './commands/Cls';
import { CopyCommand } from './commands/Copy';
import { DateCommand } from './commands/Date';
import { DelCommand } from './commands/Del';
import { DirCommand } from './commands/Dir';
import { WinEchoCommand } from './commands/Echo';
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

  const interpreter = new Interpreter(registry, machine, {
    lexer: new CmdLexer(),
    parser: new Parser(),
    expander: new CmdExpander(),
    // cmd wildcards (`*.tmp`) use `\` paths and per-command scope (e.g.
    // `del` only matches files directly in cwd, `dir /s` recurses) —
    // nothing like the generic POSIX `expandGlob`. Each migrated command
    // does its own matching against `ctx.machine.fs.list()`, so argv
    // words are passed through unexpanded here.
    globExpand: async (word) => [word],
  });

  return { registry, interpreter };
}
