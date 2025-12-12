/**
 * Windows CMD Commands Index
 * Main command execution for Windows CMD shell
 */

import { WindowsCommandResult, WindowsTerminalState } from '../types';
import { WindowsFileSystem } from '../filesystem';

export type CmdCommandFunction = (
  args: string[],
  state: WindowsTerminalState,
  fs: WindowsFileSystem
) => WindowsCommandResult;

export interface CmdCommandRegistry {
  [key: string]: CmdCommandFunction;
}

// Import command modules
import { navigationCommands } from './navigation';
import { fileCommands } from './files';
import { systemCommands } from './system';
import { networkCommands } from './network';
import { miscCommands } from './misc';

// Combine all commands
export const cmdCommands: CmdCommandRegistry = {
  ...navigationCommands,
  ...fileCommands,
  ...systemCommands,
  ...networkCommands,
  ...miscCommands,
};

// Parse command line (handles quotes, etc.)
export function parseCommand(input: string): { command: string; args: string[] } {
  const tokens: string[] = [];
  let current = '';
  let inQuote = false;
  let quoteChar = '';

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if ((char === '"') && !inQuote) {
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
    command: tokens[0]?.toLowerCase() || '',
    args: tokens.slice(1),
  };
}

// Expand environment variables (%VAR%)
function expandVariables(input: string, env: Record<string, string>): string {
  return input.replace(/%([^%]+)%/g, (match, varName) => {
    const upperName = varName.toUpperCase();
    return env[upperName] || env[varName] || match;
  });
}

// Main execute command function
export function executeCmdCommand(
  input: string,
  state: WindowsTerminalState,
  fs: WindowsFileSystem
): WindowsCommandResult {
  const trimmed = input.trim();

  if (!trimmed) {
    return { output: '', exitCode: 0 };
  }

  // Handle SET command for variable assignment
  if (trimmed.toLowerCase().startsWith('set ') && trimmed.includes('=')) {
    const assignment = trimmed.slice(4);
    const eqIndex = assignment.indexOf('=');
    if (eqIndex > 0) {
      const name = assignment.slice(0, eqIndex).trim().toUpperCase();
      const value = assignment.slice(eqIndex + 1);
      state.env[name] = value;
      return { output: '', exitCode: 0 };
    }
  }

  // Handle pipe (|)
  if (trimmed.includes('|') && !trimmed.includes('||')) {
    return handlePipe(trimmed, state, fs);
  }

  // Handle output redirection (>)
  if (trimmed.includes('>') && !trimmed.includes('>>')) {
    return handleRedirection(trimmed, state, fs, false);
  }

  // Handle append redirection (>>)
  if (trimmed.includes('>>')) {
    return handleRedirection(trimmed, state, fs, true);
  }

  // Handle && and || operators
  if (trimmed.includes('&&') || trimmed.includes('||')) {
    return handleChainedCommands(trimmed, state, fs);
  }

  return executeSingleCommand(trimmed, state, fs);
}

function executeSingleCommand(
  input: string,
  state: WindowsTerminalState,
  fs: WindowsFileSystem
): WindowsCommandResult {
  // Expand environment variables
  let processedInput = expandVariables(input, state.env);

  const { command, args } = parseCommand(processedInput);

  // Handle special built-in commands
  if (command === 'exit') {
    return { output: '', exitCode: 0, exitTerminal: true };
  }

  if (command === 'powershell' || command === 'pwsh') {
    return { output: '', exitCode: 0, switchToPowerShell: true };
  }

  const commandFn = cmdCommands[command];

  if (!commandFn) {
    return {
      output: '',
      error: `'${command}' is not recognized as an internal or external command,\r\noperable program or batch file.`,
      exitCode: 1,
    };
  }

  try {
    return commandFn(args, state, fs);
  } catch (error) {
    return {
      output: '',
      error: `${command}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      exitCode: 1,
    };
  }
}

function handlePipe(
  input: string,
  state: WindowsTerminalState,
  fs: WindowsFileSystem
): WindowsCommandResult {
  const commands = input.split('|').map(c => c.trim());
  let currentOutput = '';

  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i];

    if (i === 0) {
      const result = executeSingleCommand(cmd, state, fs);
      if (result.error) return result;
      currentOutput = result.output;
    } else {
      // For subsequent commands, we need to pipe the output
      const { command, args } = parseCommand(cmd);

      // Handle common pipe commands
      switch (command) {
        case 'find':
        case 'findstr': {
          const searchTerm = args.find(a => !a.startsWith('/'))?.replace(/"/g, '') || '';
          const ignoreCase = args.some(a => a.toLowerCase() === '/i');
          const invertMatch = args.some(a => a.toLowerCase() === '/v');

          const lines = currentOutput.split('\r\n').filter(line => {
            const searchLine = ignoreCase ? line.toLowerCase() : line;
            const term = ignoreCase ? searchTerm.toLowerCase() : searchTerm;
            const found = searchLine.includes(term);
            return invertMatch ? !found : found;
          });
          currentOutput = lines.join('\r\n');
          break;
        }

        case 'sort': {
          const reverse = args.some(a => a.toLowerCase() === '/r');
          const lines = currentOutput.split('\r\n').sort();
          if (reverse) lines.reverse();
          currentOutput = lines.join('\r\n');
          break;
        }

        case 'more': {
          // In a real terminal this would paginate, here we just pass through
          break;
        }

        default: {
          const result = executeSingleCommand(cmd, state, fs);
          if (result.error) return result;
          currentOutput = result.output;
        }
      }
    }
  }

  return { output: currentOutput, exitCode: 0 };
}

function handleRedirection(
  input: string,
  state: WindowsTerminalState,
  fs: WindowsFileSystem,
  append: boolean
): WindowsCommandResult {
  const separator = append ? '>>' : '>';
  const parts = input.split(separator);
  const command = parts[0].trim();
  const filePath = parts[1]?.trim();

  if (!filePath) {
    return { output: '', error: 'The syntax of the command is incorrect.', exitCode: 1 };
  }

  const result = executeSingleCommand(command, state, fs);
  const content = result.output || '';

  const fullPath = fs.resolvePath(filePath, state.currentPath);
  const existingNode = fs.getNode(fullPath);

  if (existingNode && existingNode.type === 'directory') {
    return { output: '', error: 'Access is denied.', exitCode: 1 };
  }

  if (existingNode) {
    if (append) {
      fs.updateFile(fullPath, (existingNode.content || '') + content + '\r\n');
    } else {
      fs.updateFile(fullPath, content + '\r\n');
    }
  } else {
    fs.createNode(fullPath, 'file', content + '\r\n');
  }

  return { output: '', exitCode: 0 };
}

function handleChainedCommands(
  input: string,
  state: WindowsTerminalState,
  fs: WindowsFileSystem
): WindowsCommandResult {
  // Split by && and ||
  const parts: { cmd: string; operator: '&&' | '||' | null }[] = [];
  let current = '';
  let i = 0;

  while (i < input.length) {
    if (input.slice(i, i + 2) === '&&') {
      parts.push({ cmd: current.trim(), operator: '&&' });
      current = '';
      i += 2;
    } else if (input.slice(i, i + 2) === '||') {
      parts.push({ cmd: current.trim(), operator: '||' });
      current = '';
      i += 2;
    } else {
      current += input[i];
      i++;
    }
  }
  parts.push({ cmd: current.trim(), operator: null });

  let combinedOutput = '';
  let lastExitCode = 0;
  let currentPath = state.currentPath;

  for (let j = 0; j < parts.length; j++) {
    const { cmd, operator } = parts[j];
    const prevOperator = j > 0 ? parts[j - 1].operator : null;

    // Check if we should skip
    if (prevOperator === '&&' && lastExitCode !== 0) continue;
    if (prevOperator === '||' && lastExitCode === 0) continue;

    const result = executeSingleCommand(cmd, { ...state, currentPath }, fs);

    if (result.output) {
      combinedOutput += (combinedOutput ? '\r\n' : '') + result.output;
    }
    if (result.error) {
      combinedOutput += (combinedOutput ? '\r\n' : '') + result.error;
    }

    lastExitCode = result.exitCode;
    if (result.newPath) currentPath = result.newPath;

    if (result.exitTerminal) {
      return { ...result, output: combinedOutput };
    }
  }

  return {
    output: combinedOutput,
    exitCode: lastExitCode,
    newPath: currentPath !== state.currentPath ? currentPath : undefined,
  };
}
