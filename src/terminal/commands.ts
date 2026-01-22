/**
 * STUB FILE - will be rebuilt with TDD
 * Terminal command execution
 */

import { FileSystem } from './filesystem';

export interface CommandContext {
  currentPath: string;
  fileSystem: FileSystem;
  environment: Record<string, string>;
}

export interface CommandResult {
  output: string;
  exitCode: number;
  newPath?: string;
}

export type CommandFunction = (args: string[], context: CommandContext) => CommandResult | Promise<CommandResult>;

export const commands: Record<string, CommandFunction> = {
  ls: (args, context) => ({ output: 'STUB: directory listing', exitCode: 0 }),
  cd: (args, context) => ({ output: '', exitCode: 0, newPath: args[0] || '/home/user' }),
  pwd: (args, context) => ({ output: context.currentPath, exitCode: 0 }),
  cat: (args, context) => ({ output: 'STUB: file contents', exitCode: 0 }),
  echo: (args, context) => ({ output: args.join(' '), exitCode: 0 }),
  mkdir: (args, context) => ({ output: '', exitCode: 0 }),
  rm: (args, context) => ({ output: '', exitCode: 0 }),
  touch: (args, context) => ({ output: '', exitCode: 0 }),
  cp: (args, context) => ({ output: '', exitCode: 0 }),
  mv: (args, context) => ({ output: '', exitCode: 0 }),
};

export async function executeCommand(
  command: string,
  context: CommandContext
): Promise<CommandResult> {
  const parts = command.trim().split(/\s+/);
  const cmd = parts[0];
  const args = parts.slice(1);

  if (commands[cmd]) {
    return await commands[cmd](args, context);
  }

  return {
    output: `STUB: Command not found: ${cmd}`,
    exitCode: 127
  };
}
