import { CommandResult, TerminalState, EditorState } from '../types';
import { FileSystem } from '../filesystem';
import { PackageManager } from '../packages';

export type CommandFunction = (
  args: string[],
  state: TerminalState,
  fs: FileSystem,
  pm: PackageManager
) => CommandResult;

export interface CommandRegistry {
  [key: string]: CommandFunction;
}

// Import all command modules
import { navigationCommands } from './navigation';
import { fileCommands } from './files';
import { systemCommands } from './system';
import { userCommands } from './users';
import { packageCommands } from './packages';
import { networkCommands } from './network';
import { textCommands } from './text';
import { processCommands } from './process';
import { archiveCommands } from './archive';
import { miscCommands } from './misc';
import { editorCommands } from './editors';

// Combine all commands
export const commands: CommandRegistry = {
  ...navigationCommands,
  ...fileCommands,
  ...systemCommands,
  ...userCommands,
  ...packageCommands,
  ...networkCommands,
  ...textCommands,
  ...processCommands,
  ...archiveCommands,
  ...miscCommands,
  ...editorCommands,
};

// Command parser
export function parseCommand(input: string): { command: string; args: string[] } {
  const tokens: string[] = [];
  let current = '';
  let inQuote = false;
  let quoteChar = '';

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    
    if ((char === '"' || char === "'") && !inQuote) {
      inQuote = true;
      quoteChar = char;
    } else if (char === quoteChar && inQuote) {
      inQuote = false;
      quoteChar = '';
    } else if (char === ' ' && !inQuote) {
      if (current) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }
  
  if (current) {
    tokens.push(current);
  }

  return {
    command: tokens[0] || '',
    args: tokens.slice(1),
  };
}

// Execute command
export function executeCommand(
  input: string,
  state: TerminalState,
  fs: FileSystem,
  pm: PackageManager
): CommandResult {
  const trimmed = input.trim();
  
  if (!trimmed) {
    return { output: '', exitCode: 0 };
  }

  // Handle aliases
  let processedInput = trimmed;
  const firstWord = trimmed.split(' ')[0];
  if (state.aliases[firstWord]) {
    processedInput = trimmed.replace(firstWord, state.aliases[firstWord]);
  }

  // Handle environment variable expansion
  processedInput = processedInput.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => {
    return state.env[name] || '';
  });

  // Handle ~ expansion
  const user = fs.getUser(state.currentUser);
  processedInput = processedInput.replace(/~/g, user?.home || '/home/' + state.currentUser);

  // Handle pipes (basic implementation)
  if (processedInput.includes('|')) {
    return handlePipe(processedInput, state, fs, pm);
  }

  // Handle output redirection
  if (processedInput.includes('>')) {
    return handleRedirection(processedInput, state, fs, pm);
  }

  const { command, args } = parseCommand(processedInput);

  // Handle sudo
  if (command === 'sudo') {
    return handleSudo(args, state, fs, pm);
  }

  const commandFn = commands[command];
  
  if (!commandFn) {
    return {
      output: '',
      error: `${command}: command not found`,
      exitCode: 127,
    };
  }

  try {
    return commandFn(args, state, fs, pm);
  } catch (error) {
    return {
      output: '',
      error: `${command}: ${error instanceof Error ? error.message : 'unknown error'}`,
      exitCode: 1,
    };
  }
}

function handleSudo(args: string[], state: TerminalState, fs: FileSystem, pm: PackageManager): CommandResult {
  if (args.length === 0) {
    return { output: '', error: 'usage: sudo -h | -K | -k | -V\nusage: sudo [-ABbEHnPS] [-C num] [-D directory] [-g group] [-h host] [-p prompt] [-R directory] [-T timeout] [-u user] [VAR=value] [-i | -s] [command [arg ...]]', exitCode: 1 };
  }

  // Check if user can sudo
  const user = fs.getUser(state.currentUser);
  if (!user || !user.groups.includes('sudo')) {
    return { output: '', error: `${state.currentUser} is not in the sudoers file. This incident will be reported.`, exitCode: 1 };
  }

  // Handle sudo su
  if (args[0] === 'su' || args[0] === '-i') {
    return {
      output: '',
      exitCode: 0,
      newUser: 'root',
      newPath: '/root',
    };
  }

  // Execute command as root
  const rootState: TerminalState = {
    ...state,
    currentUser: 'root',
    isRoot: true,
  };

  return executeCommand(args.join(' '), rootState, fs, pm);
}

function handlePipe(input: string, state: TerminalState, fs: FileSystem, pm: PackageManager): CommandResult {
  const commands = input.split('|').map(c => c.trim());
  let currentOutput = '';

  for (const cmd of commands) {
    // For grep, pass the previous output as stdin
    const { command, args } = parseCommand(cmd);
    
    if (command === 'grep' && currentOutput) {
      const pattern = args[0];
      const lines = currentOutput.split('\n');
      const matches = lines.filter(line => line.toLowerCase().includes(pattern?.toLowerCase() || ''));
      currentOutput = matches.join('\n');
    } else if (command === 'wc') {
      const lines = currentOutput.split('\n').filter(l => l);
      if (args.includes('-l')) {
        currentOutput = `${lines.length}`;
      } else if (args.includes('-w')) {
        currentOutput = `${currentOutput.split(/\s+/).filter(w => w).length}`;
      } else if (args.includes('-c')) {
        currentOutput = `${currentOutput.length}`;
      } else {
        currentOutput = `${lines.length} ${currentOutput.split(/\s+/).filter(w => w).length} ${currentOutput.length}`;
      }
    } else if (command === 'head') {
      const n = args.includes('-n') ? parseInt(args[args.indexOf('-n') + 1]) || 10 : 10;
      currentOutput = currentOutput.split('\n').slice(0, n).join('\n');
    } else if (command === 'tail') {
      const n = args.includes('-n') ? parseInt(args[args.indexOf('-n') + 1]) || 10 : 10;
      const lines = currentOutput.split('\n');
      currentOutput = lines.slice(-n).join('\n');
    } else if (command === 'sort') {
      const lines = currentOutput.split('\n');
      lines.sort();
      if (args.includes('-r')) lines.reverse();
      currentOutput = lines.join('\n');
    } else if (command === 'uniq') {
      const lines = currentOutput.split('\n');
      currentOutput = [...new Set(lines)].join('\n');
    } else {
      const result = executeCommand(cmd, state, fs, pm);
      if (result.error) return result;
      currentOutput = result.output;
    }
  }

  return { output: currentOutput, exitCode: 0 };
}

function handleRedirection(input: string, state: TerminalState, fs: FileSystem, pm: PackageManager): CommandResult {
  const append = input.includes('>>');
  const parts = input.split(append ? '>>' : '>');
  const command = parts[0].trim();
  const filePath = parts[1]?.trim();

  if (!filePath) {
    return { output: '', error: 'syntax error near unexpected token `newline\'', exitCode: 1 };
  }

  const result = executeCommand(command, state, fs, pm);
  
  if (result.error) return result;

  const fullPath = fs.resolvePath(filePath, state.currentPath);
  const existingNode = fs.getNode(fullPath);

  if (existingNode && existingNode.type === 'directory') {
    return { output: '', error: `${filePath}: Is a directory`, exitCode: 1 };
  }

  if (existingNode) {
    if (append) {
      fs.updateFile(fullPath, (existingNode.content || '') + result.output + '\n');
    } else {
      fs.updateFile(fullPath, result.output + '\n');
    }
  } else {
    fs.createNode(fullPath, 'file', state.currentUser, result.output + '\n');
  }

  return { output: '', exitCode: 0 };
}
