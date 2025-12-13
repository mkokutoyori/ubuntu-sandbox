import { CommandResult, TerminalState, EditorState } from '../types';
import { FileSystem } from '../filesystem';
import { PackageManager } from '../packages';
import {
  expandGlobArgs,
  expandCommandSubstitution,
  expandVariables,
  isVariableAssignment,
  parseVariableAssignment,
  splitByOperators,
  isBackgroundJob,
  parseHereDocument,
} from '../shellUtils';
import { executeShellCommand } from '../shell/executor';

export type CommandFunction = (
  args: string[],
  state: TerminalState,
  fs: FileSystem,
  pm: PackageManager,
  stdin?: string
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
import { databaseCommands } from './database';

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
  ...databaseCommands,
};

// Command parser
export function parseCommand(input: string): { command: string; args: string[] } {
  const tokens: string[] = [];
  let current = '';
  let inQuote = false;
  let quoteChar = '';
  let escape = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (escape) {
      current += char;
      escape = false;
      continue;
    }

    if (char === '\\' && !inQuote) {
      escape = true;
      continue;
    }

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

// Main execute command function - now uses proper shell parsing
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

  // Use the new AST-based shell executor for proper parsing
  // This correctly handles complex commands like: echo "text" >> file | python file
  return executeShellCommand(trimmed, state, fs, pm);
}

// Legacy execute command function for simple cases and internal use
export function executeCommandLegacy(
  input: string,
  state: TerminalState,
  fs: FileSystem,
  pm: PackageManager
): CommandResult {
  const trimmed = input.trim();

  if (!trimmed) {
    return { output: '', exitCode: 0 };
  }

  // Handle variable assignment (VAR=value)
  if (isVariableAssignment(trimmed) && !trimmed.includes(' ')) {
    const assignment = parseVariableAssignment(trimmed);
    if (assignment) {
      return {
        output: '',
        exitCode: 0,
        envUpdate: { [assignment.name]: assignment.value }
      } as CommandResult & { envUpdate?: Record<string, string> };
    }
  }

  // Handle logical operators (&&, ||, ;)
  const chains = splitByOperators(trimmed);
  if (chains.length > 1) {
    return handleChainedCommands(chains, state, fs, pm);
  }

  // Handle background jobs (&)
  const { command: bgCommand, isBackground } = isBackgroundJob(trimmed);
  if (isBackground) {
    const result = executeSingleCommand(bgCommand, state, fs, pm);
    return {
      ...result,
      output: `[1] ${Math.floor(Math.random() * 10000) + 1000}\n${result.output}`,
    };
  }

  return executeSingleCommand(trimmed, state, fs, pm);
}

// Handle chained commands with &&, ||, ;
function handleChainedCommands(
  chains: { command: string; operator: '&&' | '||' | ';' | null }[],
  state: TerminalState,
  fs: FileSystem,
  pm: PackageManager
): CommandResult {
  let combinedOutput = '';
  let combinedError = '';
  let lastExitCode = 0;
  let newPath = state.currentPath;
  let newUser = state.currentUser;

  for (let i = 0; i < chains.length; i++) {
    const { command, operator } = chains[i];
    const prevOperator = i > 0 ? chains[i - 1].operator : null;

    // Check if we should skip this command based on previous result
    if (prevOperator === '&&' && lastExitCode !== 0) {
      continue; // Skip on && if previous failed
    }
    if (prevOperator === '||' && lastExitCode === 0) {
      continue; // Skip on || if previous succeeded
    }

    const result = executeSingleCommand(command, { ...state, currentPath: newPath, currentUser: newUser }, fs, pm);

    if (result.output) {
      combinedOutput += (combinedOutput ? '\n' : '') + result.output;
    }
    if (result.error) {
      combinedError += (combinedError ? '\n' : '') + result.error;
    }

    lastExitCode = result.exitCode;
    newPath = result.newPath || newPath;
    newUser = result.newUser || newUser;

    if (result.clearScreen) {
      return result;
    }
  }

  return {
    output: combinedOutput,
    error: combinedError || undefined,
    exitCode: lastExitCode,
    newPath: newPath !== state.currentPath ? newPath : undefined,
    newUser: newUser !== state.currentUser ? newUser : undefined,
  };
}

// Execute a single command
function executeSingleCommand(
  input: string,
  state: TerminalState,
  fs: FileSystem,
  pm: PackageManager
): CommandResult {
  let processedInput = input;

  // Handle aliases
  const firstWord = processedInput.split(' ')[0];
  if (state.aliases[firstWord]) {
    processedInput = processedInput.replace(firstWord, state.aliases[firstWord]);
  }

  // Expand command substitution $(cmd) and `cmd`
  processedInput = expandCommandSubstitution(processedInput, state, fs, pm, executeCommand);

  // Handle environment variable expansion
  processedInput = expandVariables(processedInput, state.env);

  // Handle ~ expansion
  const user = fs.getUser(state.currentUser);
  processedInput = processedInput.replace(/~/g, user?.home || '/home/' + state.currentUser);

  // Handle pipes (extended implementation)
  if (processedInput.includes('|') && !processedInput.includes('||')) {
    return handlePipe(processedInput, state, fs, pm);
  }

  // Handle output redirection
  if (processedInput.includes('>')) {
    return handleRedirection(processedInput, state, fs, pm);
  }

  // Handle input redirection
  if (processedInput.includes('<')) {
    return handleInputRedirection(processedInput, state, fs, pm);
  }

  const { command, args } = parseCommand(processedInput);

  // Expand glob patterns in arguments
  const expandedArgs = expandGlobArgs(args, state.currentPath, fs);

  // Handle sudo
  if (command === 'sudo') {
    return handleSudo(expandedArgs, state, fs, pm);
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
    return commandFn(expandedArgs, state, fs, pm);
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

// Extended pipe handling - supports all commands
function handlePipe(input: string, state: TerminalState, fs: FileSystem, pm: PackageManager): CommandResult {
  const pipeCommands = input.split('|').map(c => c.trim());
  let currentOutput = '';
  let lastExitCode = 0;

  for (let i = 0; i < pipeCommands.length; i++) {
    const cmd = pipeCommands[i];
    const { command, args } = parseCommand(cmd);

    // Expand glob patterns
    const expandedArgs = expandGlobArgs(args, state.currentPath, fs);

    const commandFn = commands[command];

    if (!commandFn) {
      return {
        output: '',
        error: `${command}: command not found`,
        exitCode: 127,
      };
    }

    // Special handling for commands that can process stdin
    if (i > 0 && currentOutput) {
      // Commands that can process piped input
      switch (command) {
        case 'grep': {
          const pattern = expandedArgs[0] || '';
          const flags = expandedArgs.filter(a => a.startsWith('-')).join('');
          const ignoreCase = flags.includes('i');
          const invertMatch = flags.includes('v');
          const showLineNumbers = flags.includes('n');
          const countOnly = flags.includes('c');

          const lines = currentOutput.split('\n');
          let matches = lines.filter((line, idx) => {
            const searchLine = ignoreCase ? line.toLowerCase() : line;
            const searchPattern = ignoreCase ? pattern.toLowerCase() : pattern;
            const found = searchLine.includes(searchPattern);
            return invertMatch ? !found : found;
          });

          if (countOnly) {
            currentOutput = matches.length.toString();
          } else if (showLineNumbers) {
            currentOutput = matches.map((line, idx) => `${idx + 1}:${line}`).join('\n');
          } else {
            currentOutput = matches.join('\n');
          }
          break;
        }

        case 'wc': {
          const lines = currentOutput.split('\n').filter(l => l);
          if (expandedArgs.includes('-l')) {
            currentOutput = `${lines.length}`;
          } else if (expandedArgs.includes('-w')) {
            currentOutput = `${currentOutput.split(/\s+/).filter(w => w).length}`;
          } else if (expandedArgs.includes('-c')) {
            currentOutput = `${currentOutput.length}`;
          } else {
            const words = currentOutput.split(/\s+/).filter(w => w).length;
            currentOutput = `      ${lines.length}      ${words}    ${currentOutput.length}`;
          }
          break;
        }

        case 'head': {
          const nIdx = expandedArgs.indexOf('-n');
          const n = nIdx !== -1 ? parseInt(expandedArgs[nIdx + 1]) || 10 : 10;
          currentOutput = currentOutput.split('\n').slice(0, n).join('\n');
          break;
        }

        case 'tail': {
          const nIdx = expandedArgs.indexOf('-n');
          const n = nIdx !== -1 ? parseInt(expandedArgs[nIdx + 1]) || 10 : 10;
          const lines = currentOutput.split('\n');
          currentOutput = lines.slice(-n).join('\n');
          break;
        }

        case 'sort': {
          const lines = currentOutput.split('\n');
          if (expandedArgs.includes('-n')) {
            lines.sort((a, b) => parseFloat(a) - parseFloat(b));
          } else {
            lines.sort();
          }
          if (expandedArgs.includes('-r')) lines.reverse();
          if (expandedArgs.includes('-u')) {
            currentOutput = [...new Set(lines)].join('\n');
          } else {
            currentOutput = lines.join('\n');
          }
          break;
        }

        case 'uniq': {
          const lines = currentOutput.split('\n');
          if (expandedArgs.includes('-c')) {
            const counts = new Map<string, number>();
            lines.forEach(line => counts.set(line, (counts.get(line) || 0) + 1));
            currentOutput = Array.from(counts.entries())
              .map(([line, count]) => `      ${count} ${line}`)
              .join('\n');
          } else if (expandedArgs.includes('-d')) {
            const seen = new Set<string>();
            const duplicates = new Set<string>();
            lines.forEach(line => {
              if (seen.has(line)) duplicates.add(line);
              seen.add(line);
            });
            currentOutput = [...duplicates].join('\n');
          } else {
            currentOutput = [...new Set(lines)].join('\n');
          }
          break;
        }

        case 'tr': {
          if (expandedArgs.length >= 2) {
            const from = expandedArgs[0].replace(/'/g, '').replace(/"/g, '');
            const to = expandedArgs[1].replace(/'/g, '').replace(/"/g, '');
            if (expandedArgs.includes('-d')) {
              // Delete characters
              const chars = new Set(from.split(''));
              currentOutput = currentOutput.split('').filter(c => !chars.has(c)).join('');
            } else {
              // Translate characters
              for (let i = 0; i < from.length && i < to.length; i++) {
                currentOutput = currentOutput.split(from[i]).join(to[i]);
              }
            }
          }
          break;
        }

        case 'cut': {
          const dIdx = expandedArgs.indexOf('-d');
          const fIdx = expandedArgs.indexOf('-f');
          const delimiter = dIdx !== -1 ? expandedArgs[dIdx + 1]?.replace(/'/g, '') || '\t' : '\t';
          const fields = fIdx !== -1 ? expandedArgs[fIdx + 1]?.split(',').map(f => parseInt(f) - 1) || [0] : [0];

          currentOutput = currentOutput.split('\n').map(line => {
            const parts = line.split(delimiter);
            return fields.map(f => parts[f] || '').join(delimiter);
          }).join('\n');
          break;
        }

        case 'awk': {
          // Simple awk implementation for print $N
          const printMatch = expandedArgs.join(' ').match(/\{.*print\s+(\$\d+(?:\s*,\s*\$\d+)*)/);
          if (printMatch) {
            const fields = printMatch[1].match(/\$(\d+)/g)?.map(f => parseInt(f.slice(1))) || [0];
            currentOutput = currentOutput.split('\n').map(line => {
              const parts = line.split(/\s+/);
              return fields.map(f => f === 0 ? line : parts[f - 1] || '').join(' ');
            }).join('\n');
          }
          break;
        }

        case 'sed': {
          // Simple sed s/pattern/replacement/ support
          const sedMatch = expandedArgs.join(' ').match(/s\/([^\/]*)\/([^\/]*)\/([gi]*)/);
          if (sedMatch) {
            const [, pattern, replacement, flags] = sedMatch;
            const global = flags.includes('g');
            const ignoreCase = flags.includes('i');
            const regex = new RegExp(pattern, (global ? 'g' : '') + (ignoreCase ? 'i' : ''));
            currentOutput = currentOutput.split('\n').map(line =>
              line.replace(regex, replacement)
            ).join('\n');
          }
          break;
        }

        case 'tee': {
          // Write to file and continue
          const files = expandedArgs.filter(a => !a.startsWith('-'));
          const append = expandedArgs.includes('-a');
          for (const file of files) {
            const fullPath = fs.resolvePath(file, state.currentPath);
            const existing = fs.getNode(fullPath);
            if (existing) {
              if (append) {
                fs.updateFile(fullPath, (existing.content || '') + currentOutput);
              } else {
                fs.updateFile(fullPath, currentOutput);
              }
            } else {
              fs.createNode(fullPath, 'file', state.currentUser, currentOutput);
            }
          }
          // tee passes through the input unchanged
          break;
        }

        case 'xargs': {
          // Simple xargs - run command for each line
          const xargsCmd = expandedArgs.join(' ') || 'echo';
          const results: string[] = [];
          currentOutput.split('\n').filter(l => l.trim()).forEach(line => {
            const result = executeCommand(`${xargsCmd} ${line}`, state, fs, pm);
            if (result.output) results.push(result.output);
          });
          currentOutput = results.join('\n');
          break;
        }

        case 'cat': {
          // cat with no args just passes through
          if (expandedArgs.length === 0) {
            // Keep currentOutput as is
          } else {
            const result = commandFn(expandedArgs, state, fs, pm);
            currentOutput = result.output;
            lastExitCode = result.exitCode;
          }
          break;
        }

        case 'rev': {
          currentOutput = currentOutput.split('\n').map(line =>
            line.split('').reverse().join('')
          ).join('\n');
          break;
        }

        case 'nl': {
          currentOutput = currentOutput.split('\n').map((line, idx) =>
            `     ${idx + 1}\t${line}`
          ).join('\n');
          break;
        }

        default: {
          // For other commands, execute normally and use their output
          const result = commandFn(expandedArgs, state, fs, pm, currentOutput);
          currentOutput = result.output;
          lastExitCode = result.exitCode;
          if (result.error) {
            return result;
          }
        }
      }
    } else {
      // First command in pipe or no previous output
      const result = commandFn(expandedArgs, state, fs, pm);
      if (result.error) return result;
      currentOutput = result.output;
      lastExitCode = result.exitCode;
    }
  }

  return { output: currentOutput, exitCode: lastExitCode };
}

function handleRedirection(input: string, state: TerminalState, fs: FileSystem, pm: PackageManager): CommandResult {
  // Handle 2>&1 (stderr to stdout)
  const hasStderrRedirect = input.includes('2>&1');
  let processedInput = input.replace('2>&1', '').trim();

  const append = processedInput.includes('>>');
  const parts = processedInput.split(append ? '>>' : '>');
  const command = parts[0].trim();
  const filePath = parts[1]?.trim();

  if (!filePath) {
    return { output: '', error: 'syntax error near unexpected token `newline\'', exitCode: 1 };
  }

  const result = executeCommand(command, state, fs, pm);

  const fullPath = fs.resolvePath(filePath, state.currentPath);
  const existingNode = fs.getNode(fullPath);

  if (existingNode && existingNode.type === 'directory') {
    return { output: '', error: `${filePath}: Is a directory`, exitCode: 1 };
  }

  const content = hasStderrRedirect
    ? (result.output || '') + (result.error || '')
    : result.output;

  if (existingNode) {
    if (append) {
      fs.updateFile(fullPath, (existingNode.content || '') + content + '\n');
    } else {
      fs.updateFile(fullPath, content + '\n');
    }
  } else {
    fs.createNode(fullPath, 'file', state.currentUser, content + '\n');
  }

  return { output: '', exitCode: hasStderrRedirect ? 0 : result.exitCode, error: hasStderrRedirect ? undefined : result.error };
}

function handleInputRedirection(input: string, state: TerminalState, fs: FileSystem, pm: PackageManager): CommandResult {
  const parts = input.split('<');
  const command = parts[0].trim();
  const filePath = parts[1]?.trim();

  if (!filePath) {
    return { output: '', error: 'syntax error near unexpected token `newline\'', exitCode: 1 };
  }

  const fullPath = fs.resolvePath(filePath, state.currentPath);
  const node = fs.getNode(fullPath);

  if (!node) {
    return { output: '', error: `${filePath}: No such file or directory`, exitCode: 1 };
  }

  if (node.type !== 'file') {
    return { output: '', error: `${filePath}: Is a directory`, exitCode: 1 };
  }

  // Execute command with file content as stdin
  const { command: cmd, args } = parseCommand(command);
  const commandFn = commands[cmd];

  if (!commandFn) {
    return { output: '', error: `${cmd}: command not found`, exitCode: 127 };
  }

  return commandFn(args, state, fs, pm, node.content || '');
}
