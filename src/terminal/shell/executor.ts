/**
 * Shell Executor - Executes commands from an AST
 *
 * This properly handles:
 * - Pipelines (command | command)
 * - Redirections (>, >>, <, 2>, 2>&1)
 * - Command chaining (&&, ||, ;)
 * - Background jobs (&)
 * - Redirections combined with pipes
 */

import {
  ProgramNode,
  PipelineNode,
  CommandNode,
  RedirectionNode,
  WordNode,
  parseShellInput,
} from './parser';
import { TokenType, tokenize } from './lexer';
import { TerminalState, CommandResult } from '../types';
import { FileSystem } from '../filesystem';
import { PackageManager } from '../packages';
import { commands, parseCommand, CommandFunction } from '../commands';
import { expandGlobArgs, expandVariables, evaluateArithmetic } from '../shellUtils';
import { executeInlineLoop } from './scriptInterpreter';

export interface ExecutionContext {
  state: TerminalState;
  fs: FileSystem;
  pm: PackageManager;
  stdin?: string;
}

export interface ExecutionResult extends CommandResult {
  envUpdate?: Record<string, string>;
}

/**
 * Execute a shell command string using proper parsing
 */
export function executeShellCommand(
  input: string,
  state: TerminalState,
  fs: FileSystem,
  pm: PackageManager
): ExecutionResult {
  const trimmed = input.trim();

  if (!trimmed) {
    return { output: '', exitCode: 0 };
  }

  // Check for here document (<<EOF ... EOF)
  const heredocResult = handleHeredoc(trimmed, state, fs, pm);
  if (heredocResult !== null) {
    return heredocResult;
  }

  // Check for inline control structures (for, while, if)
  const loopResult = executeInlineLoop(trimmed, state, fs, pm);
  if (loopResult !== null) {
    return loopResult;
  }

  // Parse the input
  const parseResult = parseShellInput(trimmed);

  if (!parseResult.success || !parseResult.ast) {
    return {
      output: '',
      error: parseResult.error || 'Parse error',
      exitCode: 2,
    };
  }

  const ctx: ExecutionContext = { state, fs, pm };
  return executeProgram(parseResult.ast, ctx);
}

/**
 * Handle here documents (<<EOF ... EOF)
 * Supports:
 * - <<EOF ... EOF (with variable expansion)
 * - <<'EOF' ... EOF (no variable expansion)
 * - <<"EOF" ... EOF (with variable expansion)
 * - <<-EOF ... EOF (strip leading tabs)
 */
function handleHeredoc(
  input: string,
  state: TerminalState,
  fs: FileSystem,
  pm: PackageManager
): ExecutionResult | null {
  // Match heredoc pattern: command <<[-]'DELIMITER' or <<[-]"DELIMITER" or <<[-]DELIMITER
  const heredocMatch = input.match(/^(.+?)<<(-)?(['"]?)(\w+)\3\s*\n([\s\S]*?)\n\4$/);

  if (!heredocMatch) {
    // Try single-line heredoc for simple cases like: cat <<EOF\ntext\nEOF
    return null;
  }

  const [, commandPart, stripTabs, quote, delimiter, content] = heredocMatch;

  // Determine if we should expand variables (not quoted with single quotes)
  const expandVars = quote !== "'";
  const shouldStripTabs = stripTabs === '-';

  // Process the content
  let processedContent = content;

  // Strip leading tabs if <<- was used
  if (shouldStripTabs) {
    processedContent = processedContent
      .split('\n')
      .map(line => line.replace(/^\t+/, ''))
      .join('\n');
  }

  // Expand variables if not quoted with single quotes
  if (expandVars) {
    processedContent = expandVariables(processedContent, state.env);
  }

  // Parse the command part
  const cmdTrimmed = commandPart.trim();

  // Execute the command with the heredoc content as stdin
  const ctx: ExecutionContext = { state, fs, pm, stdin: processedContent };

  const parseResult = parseShellInput(cmdTrimmed);

  if (!parseResult.success || !parseResult.ast) {
    return {
      output: '',
      error: parseResult.error || 'Parse error',
      exitCode: 2,
    };
  }

  return executeProgram(parseResult.ast, ctx);
}

/**
 * Parse a heredoc from multiline input
 * This is called when the input contains a heredoc marker
 */
export function parseHeredocInput(input: string): {
  command: string;
  delimiter: string;
  content: string;
  expandVars: boolean;
  stripTabs: boolean;
} | null {
  // Match: command <<[-]['"]?DELIMITER['"]?
  const headerMatch = input.match(/^(.+?)<<(-)?(['"]?)(\w+)\3\s*$/m);

  if (!headerMatch) {
    return null;
  }

  const [fullMatch, command, stripTabs, quote, delimiter] = headerMatch;
  const headerEndIdx = input.indexOf(fullMatch) + fullMatch.length;
  const rest = input.substring(headerEndIdx);

  // Find the ending delimiter
  const delimiterPattern = new RegExp(`^${delimiter}$`, 'm');
  const delimMatch = rest.match(delimiterPattern);

  if (!delimMatch || delimMatch.index === undefined) {
    return null;
  }

  const content = rest.substring(1, delimMatch.index); // Skip initial newline

  return {
    command: command.trim(),
    delimiter,
    content: content.replace(/\n$/, ''), // Remove trailing newline before delimiter
    expandVars: quote !== "'",
    stripTabs: stripTabs === '-',
  };
}

/**
 * Execute a program (top-level AST node)
 */
function executeProgram(program: ProgramNode, ctx: ExecutionContext): ExecutionResult {
  let combinedOutput = '';
  let combinedError = '';
  let lastExitCode = 0;
  let newPath = ctx.state.currentPath;
  let newUser = ctx.state.currentUser;
  let envUpdate: Record<string, string> = {};
  let lastResult: any = null;

  for (let i = 0; i < program.body.length; i++) {
    const pipeline = program.body[i];
    const prevOperator = i > 0 ? program.operators[i - 1] : null;

    // Check if we should skip based on previous operator
    if (prevOperator === '&&' && lastExitCode !== 0) {
      continue;
    }
    if (prevOperator === '||' && lastExitCode === 0) {
      continue;
    }

    // Update context with any path/user changes
    const updatedCtx: ExecutionContext = {
      ...ctx,
      state: {
        ...ctx.state,
        currentPath: newPath,
        currentUser: newUser,
        env: { ...ctx.state.env, ...envUpdate },
      },
    };

    const result = executePipeline(pipeline, updatedCtx);
    lastResult = result;

    if (result.output) {
      combinedOutput += (combinedOutput ? '\n' : '') + result.output;
    }
    if (result.error) {
      combinedError += (combinedError ? '\n' : '') + result.error;
    }

    lastExitCode = result.exitCode;
    newPath = result.newPath || newPath;
    newUser = result.newUser || newUser;

    if (result.envUpdate) {
      envUpdate = { ...envUpdate, ...result.envUpdate };
    }

    if (result.clearScreen) {
      return result;
    }
  }

  // Build the base result
  const baseResult: ExecutionResult = {
    output: combinedOutput,
    error: combinedError || undefined,
    exitCode: lastExitCode,
    newPath: newPath !== ctx.state.currentPath ? newPath : undefined,
    newUser: newUser !== ctx.state.currentUser ? newUser : undefined,
    envUpdate: Object.keys(envUpdate).length > 0 ? envUpdate : undefined,
  };

  // Propagate special flags from the last command result
  // These flags are used by Terminal to enter special modes (Python, SQL*Plus, psql, etc.)
  if (lastResult) {
    const specialFlags = [
      'enterPythonMode', 'enterSQLPlusMode', 'enterPsqlMode', 'enterMysqlMode',
      'enterSqliteMode', 'enterRedisMode', 'enterMongoMode',
      'editorMode', 'sqlplusConfig', 'psqlConfig'
    ];
    for (const flag of specialFlags) {
      if (lastResult[flag] !== undefined) {
        (baseResult as any)[flag] = lastResult[flag];
      }
    }
  }

  return baseResult;
}

/**
 * Execute a pipeline (commands connected by |)
 */
function executePipeline(pipeline: PipelineNode, ctx: ExecutionContext): ExecutionResult {
  let currentStdin = ctx.stdin;
  let lastResult: ExecutionResult = { output: '', exitCode: 0 };

  for (let i = 0; i < pipeline.commands.length; i++) {
    const command = pipeline.commands[i];
    const isLast = i === pipeline.commands.length - 1;

    // Execute command with current stdin
    // Set isPiped flag for commands that are piped to other commands
    const commandCtx: ExecutionContext = {
      ...ctx,
      stdin: currentStdin,
      state: {
        ...ctx.state,
        isPiped: !isLast, // Command output is piped if not the last command
      },
    };

    const result = executeCommandNode(command, commandCtx);

    if (result.error && !isLast) {
      // Errors in the middle of a pipeline stop execution
      return result;
    }

    // For next command in pipeline, use this command's output as stdin
    currentStdin = result.output;
    lastResult = result;
  }

  // Handle background execution
  if (pipeline.background) {
    const pid = Math.floor(Math.random() * 10000) + 1000;
    return {
      ...lastResult,
      output: `[1] ${pid}${lastResult.output ? '\n' + lastResult.output : ''}`,
    };
  }

  return lastResult;
}

/**
 * Execute a single command with its redirections
 */
function executeCommandNode(command: CommandNode, ctx: ExecutionContext): ExecutionResult {
  const simpleCmd = command.command;
  const redirections = command.redirections;

  // Build the command name and args from WordNodes
  const cmdName = resolveWord(simpleCmd.name, ctx);
  const cmdArgs = simpleCmd.args.map(arg => resolveWord(arg, ctx));

  // Handle variable assignments
  if (simpleCmd.assignments.length > 0 && !cmdName) {
    // Just assignments, no command
    const envUpdate: Record<string, string> = {};
    for (const assignment of simpleCmd.assignments) {
      envUpdate[assignment.name] = resolveWord(assignment.value, ctx);
    }
    return { output: '', exitCode: 0, envUpdate };
  }

  // Expand globs
  const expandedArgs = expandGlobArgs(cmdArgs, ctx.state.currentPath, ctx.fs);

  // Apply input redirection to get stdin
  let stdin = ctx.stdin;
  for (const redir of redirections) {
    if (redir.operator === '<') {
      const filePath = resolveWord(redir.target, ctx);
      const fullPath = ctx.fs.resolvePath(filePath, ctx.state.currentPath);
      const node = ctx.fs.getNode(fullPath);

      if (!node) {
        return { output: '', error: `${filePath}: No such file or directory`, exitCode: 1 };
      }
      if (node.type !== 'file') {
        return { output: '', error: `${filePath}: Is a directory`, exitCode: 1 };
      }

      stdin = node.content || '';
    }
  }

  // Handle aliases
  let resolvedCmd = cmdName;
  if (ctx.state.aliases[cmdName]) {
    resolvedCmd = ctx.state.aliases[cmdName];
  }

  // Handle sudo
  if (resolvedCmd === 'sudo') {
    return handleSudo(expandedArgs, ctx);
  }

  // Find and execute the command
  const commandFn = commands[resolvedCmd];

  if (!commandFn) {
    return {
      output: '',
      error: `${resolvedCmd}: command not found`,
      exitCode: 127,
    };
  }

  let result: CommandResult;
  try {
    // Execute with stdin if available
    result = executeSingleCommandWithStdin(resolvedCmd, expandedArgs, ctx, stdin);
  } catch (error) {
    result = {
      output: '',
      error: `${resolvedCmd}: ${error instanceof Error ? error.message : 'unknown error'}`,
      exitCode: 1,
    };
  }

  // Apply output redirections
  for (const redir of redirections) {
    const appliedResult = applyOutputRedirection(redir, result, ctx);
    if (appliedResult) {
      result = appliedResult;
    }
  }

  return result;
}

/**
 * Execute a single command with optional stdin
 */
function executeSingleCommandWithStdin(
  cmd: string,
  args: string[],
  ctx: ExecutionContext,
  stdin?: string
): CommandResult {
  const commandFn = commands[cmd];

  if (!commandFn) {
    return { output: '', error: `${cmd}: command not found`, exitCode: 127 };
  }

  // Some commands handle stdin specially
  if (stdin) {
    return executeWithPipedInput(cmd, args, ctx, stdin, commandFn);
  }

  return commandFn(args, ctx.state, ctx.fs, ctx.pm);
}

/**
 * Execute command with piped input
 */
function executeWithPipedInput(
  cmd: string,
  args: string[],
  ctx: ExecutionContext,
  stdin: string,
  commandFn: CommandFunction
): CommandResult {
  // Commands that can process stdin
  switch (cmd) {
    case 'grep': {
      const pattern = args.find(a => !a.startsWith('-')) || '';
      const flags = args.filter(a => a.startsWith('-')).join('');
      const ignoreCase = flags.includes('i');
      const invertMatch = flags.includes('v');
      const showLineNumbers = flags.includes('n');
      const countOnly = flags.includes('c');

      const lines = stdin.split('\n');
      let matches = lines.filter(line => {
        const searchLine = ignoreCase ? line.toLowerCase() : line;
        const searchPattern = ignoreCase ? pattern.toLowerCase() : pattern;
        const found = searchLine.includes(searchPattern);
        return invertMatch ? !found : found;
      });

      if (countOnly) {
        return { output: matches.length.toString(), exitCode: 0 };
      }
      if (showLineNumbers) {
        return {
          output: matches.map((line, idx) => `${idx + 1}:${line}`).join('\n'),
          exitCode: 0,
        };
      }
      return { output: matches.join('\n'), exitCode: matches.length > 0 ? 0 : 1 };
    }

    case 'wc': {
      const lines = stdin.split('\n');
      if (args.includes('-l')) {
        return { output: `${lines.length}`, exitCode: 0 };
      }
      if (args.includes('-w')) {
        return { output: `${stdin.split(/\s+/).filter(w => w).length}`, exitCode: 0 };
      }
      if (args.includes('-c')) {
        return { output: `${stdin.length}`, exitCode: 0 };
      }
      const words = stdin.split(/\s+/).filter(w => w).length;
      return { output: `      ${lines.length}      ${words}    ${stdin.length}`, exitCode: 0 };
    }

    case 'head': {
      const nIdx = args.indexOf('-n');
      const n = nIdx !== -1 ? parseInt(args[nIdx + 1]) || 10 : 10;
      return { output: stdin.split('\n').slice(0, n).join('\n'), exitCode: 0 };
    }

    case 'tail': {
      const nIdx = args.indexOf('-n');
      const n = nIdx !== -1 ? parseInt(args[nIdx + 1]) || 10 : 10;
      return { output: stdin.split('\n').slice(-n).join('\n'), exitCode: 0 };
    }

    case 'sort': {
      const lines = stdin.split('\n');
      if (args.includes('-n')) {
        lines.sort((a, b) => parseFloat(a) - parseFloat(b));
      } else {
        lines.sort();
      }
      if (args.includes('-r')) lines.reverse();
      if (args.includes('-u')) {
        return { output: [...new Set(lines)].join('\n'), exitCode: 0 };
      }
      return { output: lines.join('\n'), exitCode: 0 };
    }

    case 'uniq': {
      const lines = stdin.split('\n');
      if (args.includes('-c')) {
        const counts = new Map<string, number>();
        lines.forEach(line => counts.set(line, (counts.get(line) || 0) + 1));
        return {
          output: Array.from(counts.entries())
            .map(([line, count]) => `      ${count} ${line}`)
            .join('\n'),
          exitCode: 0,
        };
      }
      if (args.includes('-d')) {
        const seen = new Set<string>();
        const duplicates = new Set<string>();
        lines.forEach(line => {
          if (seen.has(line)) duplicates.add(line);
          seen.add(line);
        });
        return { output: [...duplicates].join('\n'), exitCode: 0 };
      }
      return { output: [...new Set(lines)].join('\n'), exitCode: 0 };
    }

    case 'tr': {
      if (args.length >= 2) {
        const from = args[0].replace(/'/g, '').replace(/"/g, '');
        const to = args[1].replace(/'/g, '').replace(/"/g, '');
        let output = stdin;
        if (args.includes('-d')) {
          const chars = new Set(from.split(''));
          output = output.split('').filter(c => !chars.has(c)).join('');
        } else {
          for (let i = 0; i < from.length && i < to.length; i++) {
            output = output.split(from[i]).join(to[i]);
          }
        }
        return { output, exitCode: 0 };
      }
      return { output: stdin, exitCode: 0 };
    }

    case 'cut': {
      const dIdx = args.indexOf('-d');
      const fIdx = args.indexOf('-f');
      const delimiter = dIdx !== -1 ? args[dIdx + 1]?.replace(/'/g, '') || '\t' : '\t';
      const fields = fIdx !== -1
        ? args[fIdx + 1]?.split(',').map(f => parseInt(f) - 1) || [0]
        : [0];

      const output = stdin.split('\n').map(line => {
        const parts = line.split(delimiter);
        return fields.map(f => parts[f] || '').join(delimiter);
      }).join('\n');

      return { output, exitCode: 0 };
    }

    case 'awk': {
      const printMatch = args.join(' ').match(/\{.*print\s+(\$\d+(?:\s*,\s*\$\d+)*)/);
      if (printMatch) {
        const fields = printMatch[1].match(/\$(\d+)/g)?.map(f => parseInt(f.slice(1))) || [0];
        const output = stdin.split('\n').map(line => {
          const parts = line.split(/\s+/);
          return fields.map(f => f === 0 ? line : parts[f - 1] || '').join(' ');
        }).join('\n');
        return { output, exitCode: 0 };
      }
      return { output: stdin, exitCode: 0 };
    }

    case 'sed': {
      const sedMatch = args.join(' ').match(/s\/([^\/]*)\/([^\/]*)\/([gi]*)/);
      if (sedMatch) {
        const [, pattern, replacement, flags] = sedMatch;
        const global = flags.includes('g');
        const ignoreCase = flags.includes('i');
        const regex = new RegExp(pattern, (global ? 'g' : '') + (ignoreCase ? 'i' : ''));
        const output = stdin.split('\n').map(line =>
          line.replace(regex, replacement)
        ).join('\n');
        return { output, exitCode: 0 };
      }
      return { output: stdin, exitCode: 0 };
    }

    case 'tee': {
      const files = args.filter(a => !a.startsWith('-'));
      const append = args.includes('-a');
      for (const file of files) {
        const fullPath = ctx.fs.resolvePath(file, ctx.state.currentPath);
        const existing = ctx.fs.getNode(fullPath);
        if (existing) {
          if (append) {
            ctx.fs.updateFile(fullPath, (existing.content || '') + stdin);
          } else {
            ctx.fs.updateFile(fullPath, stdin);
          }
        } else {
          ctx.fs.createNode(fullPath, 'file', ctx.state.currentUser, stdin);
        }
      }
      return { output: stdin, exitCode: 0 };
    }

    case 'xargs': {
      const xargsCmd = args.join(' ') || 'echo';
      const results: string[] = [];
      stdin.split('\n').filter(l => l.trim()).forEach(line => {
        const { command, args: xargs } = parseCommand(`${xargsCmd} ${line}`);
        const fn = commands[command];
        if (fn) {
          const result = fn(xargs, ctx.state, ctx.fs, ctx.pm);
          if (result.output) results.push(result.output);
        }
      });
      return { output: results.join('\n'), exitCode: 0 };
    }

    case 'cat': {
      if (args.length === 0) {
        return { output: stdin, exitCode: 0 };
      }
      return commandFn(args, ctx.state, ctx.fs, ctx.pm, stdin);
    }

    case 'rev': {
      return {
        output: stdin.split('\n').map(line =>
          line.split('').reverse().join('')
        ).join('\n'),
        exitCode: 0,
      };
    }

    case 'nl': {
      return {
        output: stdin.split('\n').map((line, idx) =>
          `     ${idx + 1}\t${line}`
        ).join('\n'),
        exitCode: 0,
      };
    }

    case 'python':
    case 'python3': {
      // For python, the stdin doesn't affect execution unless using -c
      // Just run the command normally
      return commandFn(args, ctx.state, ctx.fs, ctx.pm, stdin);
    }

    default: {
      // Try running the command with stdin parameter
      return commandFn(args, ctx.state, ctx.fs, ctx.pm, stdin);
    }
  }
}

/**
 * Apply output redirection to a result
 */
function applyOutputRedirection(
  redir: RedirectionNode,
  result: CommandResult,
  ctx: ExecutionContext
): CommandResult | null {
  const operator = redir.operator;

  // Skip input redirections
  if (operator === '<' || operator === '<<' || operator === '<<<') {
    return null;
  }

  // Handle FD redirections like 2>&1
  if (operator === '2>&1') {
    // Merge stderr into stdout
    const combined = (result.output || '') + (result.error || '');
    return { ...result, output: combined, error: undefined };
  }

  if (operator === '1>&2') {
    // Merge stdout into stderr
    const combined = (result.error || '') + (result.output || '');
    return { ...result, error: combined, output: '' };
  }

  const filePath = resolveWord(redir.target, ctx);
  const fullPath = ctx.fs.resolvePath(filePath, ctx.state.currentPath);

  // Determine what content to write based on FD
  let content = result.output || '';
  if (operator === '2>' || operator === '2>>') {
    content = result.error || '';
  }

  const existingNode = ctx.fs.getNode(fullPath);

  if (existingNode && existingNode.type === 'directory') {
    return { ...result, output: '', error: `${filePath}: Is a directory`, exitCode: 1 };
  }

  const isAppend = operator === '>>' || operator === '2>>' || operator === '1>>';

  if (existingNode) {
    if (isAppend) {
      ctx.fs.updateFile(fullPath, (existingNode.content || '') + content + '\n');
    } else {
      ctx.fs.updateFile(fullPath, content + '\n');
    }
  } else {
    ctx.fs.createNode(fullPath, 'file', ctx.state.currentUser, content + '\n');
  }

  // After writing to file, clear the redirected output/error
  if (operator === '2>' || operator === '2>>') {
    return { ...result, error: undefined };
  }

  return { ...result, output: '' };
}

/**
 * Resolve a WordNode to a string value
 */
function resolveWord(word: WordNode, ctx: ExecutionContext): string {
  if (word.parts.length === 0) {
    return word.value;
  }

  let result = '';

  for (const part of word.parts) {
    switch (part.type) {
      case 'literal':
        result += part.value;
        break;

      case 'variable': {
        const name = part.name.replace(/^\$/, '');
        const value = ctx.state.env[name] || '';
        result += value;
        break;
      }

      case 'command': {
        // Execute command substitution
        const subResult = executeShellCommand(part.command, ctx.state, ctx.fs, ctx.pm);
        result += subResult.output.trim();
        break;
      }

      case 'arithmetic': {
        // Evaluate arithmetic expression
        const expr = part.expr;
        result += evaluateArithmetic(expr, ctx.state.env);
        break;
      }

      case 'glob':
        // Globs are expanded later
        result += part.pattern;
        break;
    }
  }

  // Handle ~ expansion
  const user = ctx.fs.getUser(ctx.state.currentUser);
  result = result.replace(/^~/, user?.home || '/home/' + ctx.state.currentUser);

  // Expand variables that weren't handled as parts
  result = expandVariables(result, ctx.state.env);

  return result;
}

/**
 * Handle sudo command
 */
function handleSudo(args: string[], ctx: ExecutionContext): ExecutionResult {
  if (args.length === 0) {
    return {
      output: '',
      error: 'usage: sudo -h | -K | -k | -V\nusage: sudo [-ABbEHnPS] [-C num] [-D directory] [-g group] [-h host] [-p prompt] [-R directory] [-T timeout] [-u user] [VAR=value] [-i | -s] [command [arg ...]]',
      exitCode: 1,
    };
  }

  const user = ctx.fs.getUser(ctx.state.currentUser);
  if (!user || !user.groups.includes('sudo')) {
    return {
      output: '',
      error: `${ctx.state.currentUser} is not in the sudoers file. This incident will be reported.`,
      exitCode: 1,
    };
  }

  // Handle sudo su / sudo -i
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
    ...ctx.state,
    currentUser: 'root',
    isRoot: true,
  };

  return executeShellCommand(args.join(' '), rootState, ctx.fs, ctx.pm);
}
