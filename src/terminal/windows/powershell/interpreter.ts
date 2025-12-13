/**
 * PowerShell Interpreter
 * Simplified interpreter for common PowerShell operations
 */

import { PSLexer, Token, TokenType } from './lexer';
import {
  PSValue, psString, psInt, psFloat, psBool, psNull, psArray, psHashtable, psDateTime,
  psValueToString, psTruthy, WindowsTerminalState
} from '../types';
import { WindowsFileSystem } from '../filesystem';

export interface PSContext {
  variables: Map<string, PSValue>;
  env: Record<string, string>;
  functions: Map<string, PSFunction>;
  aliases: Map<string, string>;
  fs: WindowsFileSystem;
  state: WindowsTerminalState;
  output: string[];
  lastExitCode: number;
}

export interface PSFunction {
  name: string;
  params: string[];
  body: string;
}

export interface PSResult {
  output: string;
  exitCode: number;
  exitTerminal?: boolean;
  switchToCmd?: boolean;
  newPath?: string;
}

// Built-in aliases
const DEFAULT_ALIASES: Record<string, string> = {
  'ls': 'Get-ChildItem',
  'dir': 'Get-ChildItem',
  'gci': 'Get-ChildItem',
  'cd': 'Set-Location',
  'sl': 'Set-Location',
  'chdir': 'Set-Location',
  'pwd': 'Get-Location',
  'gl': 'Get-Location',
  'cat': 'Get-Content',
  'gc': 'Get-Content',
  'type': 'Get-Content',
  'cp': 'Copy-Item',
  'copy': 'Copy-Item',
  'cpi': 'Copy-Item',
  'mv': 'Move-Item',
  'move': 'Move-Item',
  'mi': 'Move-Item',
  'rm': 'Remove-Item',
  'del': 'Remove-Item',
  'ri': 'Remove-Item',
  'rmdir': 'Remove-Item',
  'rd': 'Remove-Item',
  'erase': 'Remove-Item',
  'mkdir': 'New-Item -ItemType Directory',
  'md': 'New-Item -ItemType Directory',
  'ni': 'New-Item',
  'ren': 'Rename-Item',
  'rni': 'Rename-Item',
  'cls': 'Clear-Host',
  'clear': 'Clear-Host',
  'echo': 'Write-Output',
  'write': 'Write-Output',
  'man': 'Get-Help',
  'help': 'Get-Help',
  'ps': 'Get-Process',
  'gps': 'Get-Process',
  'kill': 'Stop-Process',
  'spps': 'Stop-Process',
  'sls': 'Select-String',
  'sort': 'Sort-Object',
  'measure': 'Measure-Object',
  'select': 'Select-Object',
  'where': 'Where-Object',
  '?': 'Where-Object',
  'foreach': 'ForEach-Object',
  '%': 'ForEach-Object',
  'ft': 'Format-Table',
  'fl': 'Format-List',
  'fw': 'Format-Wide',
  'oh': 'Out-Host',
  'out': 'Out-Host',
  'sc': 'Set-Content',
  'ac': 'Add-Content',
  'clc': 'Clear-Content',
  'h': 'Get-History',
  'history': 'Get-History',
  'ihy': 'Invoke-History',
  'r': 'Invoke-History',
  'gwmi': 'Get-WmiObject',
  'icm': 'Invoke-Command',
  'iex': 'Invoke-Expression',
};

export function createPSContext(fs: WindowsFileSystem, state: WindowsTerminalState): PSContext {
  const context: PSContext = {
    variables: new Map(),
    env: { ...state.env },
    functions: new Map(),
    aliases: new Map(Object.entries(DEFAULT_ALIASES)),
    fs,
    state,
    output: [],
    lastExitCode: 0,
  };

  // Initialize automatic variables
  context.variables.set('true', psBool(true));
  context.variables.set('false', psBool(false));
  context.variables.set('null', psNull());
  context.variables.set('PSVersionTable', psHashtable(new Map([
    ['PSVersion', psString('7.4.0')],
    ['PSEdition', psString('Core')],
    ['OS', psString('Microsoft Windows 10.0.22621')],
    ['Platform', psString('Win32NT')],
  ])));
  context.variables.set('HOME', psString(state.env.USERPROFILE || 'C:\\Users\\User'));
  context.variables.set('PWD', psString(state.currentPath));
  context.variables.set('Host', psHashtable(new Map([
    ['Name', psString('ConsoleHost')],
    ['Version', psString('7.4.0')],
  ])));

  return context;
}

export function executePSCommand(input: string, context: PSContext): PSResult {
  const trimmed = input.trim();

  if (!trimmed) {
    return { output: '', exitCode: 0 };
  }

  // Handle exit - returns to CMD shell instead of closing terminal
  if (trimmed.toLowerCase() === 'exit') {
    return { output: '', exitCode: 0, switchToCmd: true };
  }

  // Handle switch to CMD
  if (trimmed.toLowerCase() === 'cmd' || trimmed.toLowerCase() === 'cmd.exe') {
    return { output: '', exitCode: 0, switchToCmd: true };
  }

  try {
    // Tokenize
    const lexer = new PSLexer(trimmed);
    const tokens = lexer.tokenize();

    // Simple command execution
    const result = executeTokens(tokens, context);
    return result;
  } catch (error) {
    return {
      output: error instanceof Error ? error.message : 'An error occurred',
      exitCode: 1,
    };
  }
}

function executeTokens(tokens: Token[], context: PSContext): PSResult {
  // Filter out newlines and comments
  tokens = tokens.filter(t => t.type !== TokenType.NEWLINE && t.type !== TokenType.COMMENT && t.type !== TokenType.EOF);

  if (tokens.length === 0) {
    return { output: '', exitCode: 0 };
  }

  // Check for variable assignment
  if (tokens[0].type === TokenType.VARIABLE && tokens[1]?.type === TokenType.ASSIGN) {
    return executeAssignment(tokens, context);
  }

  // Check for pipeline
  const pipeIndex = tokens.findIndex(t => t.type === TokenType.PIPE);
  if (pipeIndex !== -1) {
    return executePipeline(tokens, context);
  }

  // Execute as command
  return executeCommand(tokens, context);
}

function executeAssignment(tokens: Token[], context: PSContext): PSResult {
  const varName = tokens[0].value;
  const valueTokens = tokens.slice(2);

  const value = evaluateExpression(valueTokens, context);
  context.variables.set(varName, value);

  return { output: '', exitCode: 0 };
}

function executePipeline(tokens: Token[], context: PSContext): PSResult {
  // Split by pipe
  const commands: Token[][] = [];
  let current: Token[] = [];

  for (const token of tokens) {
    if (token.type === TokenType.PIPE) {
      if (current.length > 0) {
        commands.push(current);
        current = [];
      }
    } else {
      current.push(token);
    }
  }
  if (current.length > 0) {
    commands.push(current);
  }

  // Execute pipeline
  let pipelineInput: PSValue[] = [];

  for (const cmdTokens of commands) {
    const result = executeSingleCommand(cmdTokens, context, pipelineInput);
    if (result.exitCode !== 0) {
      return { output: result.output, exitCode: result.exitCode };
    }
    pipelineInput = result.objects;
  }

  // Format output
  const output = pipelineInput.map(obj => formatPSValue(obj)).join('\r\n');
  return { output, exitCode: 0 };
}

function executeCommand(tokens: Token[], context: PSContext): PSResult {
  const result = executeSingleCommand(tokens, context, []);
  const output = result.objects.map(obj => formatPSValue(obj)).join('\r\n');

  return {
    output,
    exitCode: result.exitCode,
    newPath: result.newPath,
  };
}

interface CommandResult {
  objects: PSValue[];
  exitCode: number;
  newPath?: string;
}

function executeSingleCommand(tokens: Token[], context: PSContext, pipelineInput: PSValue[]): CommandResult {
  if (tokens.length === 0) {
    return { objects: [], exitCode: 0 };
  }

  const firstToken = tokens[0];
  let commandName = '';
  let args: Token[] = [];

  if (firstToken.type === TokenType.COMMAND || firstToken.type === TokenType.IDENTIFIER) {
    commandName = firstToken.value;
    args = tokens.slice(1);
  } else {
    // Expression
    const value = evaluateExpression(tokens, context);
    return { objects: [value], exitCode: 0 };
  }

  // Resolve alias
  const alias = context.aliases.get(commandName.toLowerCase());
  if (alias) {
    const aliasTokens = new PSLexer(alias + ' ' + args.map(t => t.value).join(' ')).tokenize()
      .filter(t => t.type !== TokenType.EOF && t.type !== TokenType.NEWLINE);
    return executeSingleCommand(aliasTokens, context, pipelineInput);
  }

  // Parse arguments
  const parsedArgs = parseArguments(args, context);

  // Execute cmdlet
  return executeCmdlet(commandName, parsedArgs, context, pipelineInput);
}

interface ParsedArgs {
  positional: PSValue[];
  named: Map<string, PSValue>;
}

function parseArguments(tokens: Token[], context: PSContext): ParsedArgs {
  const positional: PSValue[] = [];
  const named: Map<string, PSValue> = new Map();

  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];

    if (token.type === TokenType.PARAMETER) {
      const paramName = token.value;
      // Check if next token is a value
      if (i + 1 < tokens.length && tokens[i + 1].type !== TokenType.PARAMETER) {
        const valueToken = tokens[i + 1];
        named.set(paramName.toLowerCase(), tokenToValue(valueToken, context));
        i += 2;
      } else {
        // Switch parameter (boolean)
        named.set(paramName.toLowerCase(), psBool(true));
        i++;
      }
    } else {
      positional.push(tokenToValue(token, context));
      i++;
    }
  }

  return { positional, named };
}

function tokenToValue(token: Token, context: PSContext): PSValue {
  switch (token.type) {
    case TokenType.NUMBER:
      const numStr = token.value.replace(/[kmgtp]b$/i, '');
      let num = parseFloat(numStr);
      const suffix = token.value.slice(-2).toUpperCase();
      if (suffix === 'KB') num *= 1024;
      else if (suffix === 'MB') num *= 1024 * 1024;
      else if (suffix === 'GB') num *= 1024 * 1024 * 1024;
      else if (suffix === 'TB') num *= 1024 * 1024 * 1024 * 1024;
      return token.value.includes('.') ? psFloat(num) : psInt(num);

    case TokenType.STRING:
    case TokenType.EXPANDABLE_STRING:
    case TokenType.HERE_STRING:
      let value = token.value;
      // Expand variables in expandable strings
      if (token.type === TokenType.EXPANDABLE_STRING) {
        value = expandVariables(value, context);
      }
      return psString(value);

    case TokenType.VARIABLE:
      return context.variables.get(token.value) || psNull();

    case TokenType.IDENTIFIER:
      // Could be a bareword string
      return psString(token.value);

    default:
      return psString(token.value);
  }
}

function evaluateExpression(tokens: Token[], context: PSContext): PSValue {
  if (tokens.length === 0) {
    return psNull();
  }

  if (tokens.length === 1) {
    return tokenToValue(tokens[0], context);
  }

  // Handle array @()
  if (tokens[0].type === TokenType.AT && tokens[1]?.type === TokenType.LPAREN) {
    const elements: PSValue[] = [];
    let depth = 0;
    let current: Token[] = [];

    for (let i = 2; i < tokens.length; i++) {
      if (tokens[i].type === TokenType.LPAREN) depth++;
      if (tokens[i].type === TokenType.RPAREN) {
        if (depth === 0) break;
        depth--;
      }
      if (tokens[i].type === TokenType.COMMA && depth === 0) {
        if (current.length > 0) {
          elements.push(evaluateExpression(current, context));
          current = [];
        }
      } else {
        current.push(tokens[i]);
      }
    }
    if (current.length > 0) {
      elements.push(evaluateExpression(current, context));
    }

    return psArray(elements);
  }

  // Handle hashtable @{}
  if (tokens[0].type === TokenType.AT && tokens[1]?.type === TokenType.LBRACE) {
    const entries = new Map<string, PSValue>();
    // Simplified parsing
    return psHashtable(entries);
  }

  // Handle binary operations
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if ([TokenType.PLUS, TokenType.MINUS, TokenType.MULTIPLY, TokenType.DIVIDE,
         TokenType.EQ, TokenType.NE, TokenType.GT, TokenType.GE, TokenType.LT, TokenType.LE,
         TokenType.AND, TokenType.OR].includes(token.type)) {
      const left = evaluateExpression(tokens.slice(0, i), context);
      const right = evaluateExpression(tokens.slice(i + 1), context);
      return applyOperator(left, token.type, right);
    }
  }

  // Single value
  return tokenToValue(tokens[0], context);
}

function applyOperator(left: PSValue, op: TokenType, right: PSValue): PSValue {
  switch (op) {
    case TokenType.PLUS:
      if (left.type === 'int' && right.type === 'int') {
        return psInt(left.value + right.value);
      }
      if ((left.type === 'int' || left.type === 'double') &&
          (right.type === 'int' || right.type === 'double')) {
        return psFloat(left.value + right.value);
      }
      if (left.type === 'string' || right.type === 'string') {
        return psString(psValueToString(left) + psValueToString(right));
      }
      if (left.type === 'array') {
        const items = [...left.items];
        if (right.type === 'array') {
          items.push(...right.items);
        } else {
          items.push(right);
        }
        return psArray(items);
      }
      return psString(psValueToString(left) + psValueToString(right));

    case TokenType.MINUS:
      if ((left.type === 'int' || left.type === 'double') &&
          (right.type === 'int' || right.type === 'double')) {
        const result = left.value - right.value;
        return left.type === 'int' && right.type === 'int' ? psInt(result) : psFloat(result);
      }
      return psInt(0);

    case TokenType.MULTIPLY:
      if ((left.type === 'int' || left.type === 'double') &&
          (right.type === 'int' || right.type === 'double')) {
        const result = left.value * right.value;
        return left.type === 'int' && right.type === 'int' ? psInt(result) : psFloat(result);
      }
      if (left.type === 'string' && right.type === 'int') {
        return psString(left.value.repeat(Math.max(0, right.value)));
      }
      return psInt(0);

    case TokenType.DIVIDE:
      if ((left.type === 'int' || left.type === 'double') &&
          (right.type === 'int' || right.type === 'double')) {
        if (right.value === 0) {
          throw new Error('Attempted to divide by zero.');
        }
        return psFloat(left.value / right.value);
      }
      return psInt(0);

    case TokenType.EQ:
      return psBool(psValueToString(left) === psValueToString(right));

    case TokenType.NE:
      return psBool(psValueToString(left) !== psValueToString(right));

    case TokenType.GT:
      if ((left.type === 'int' || left.type === 'double') &&
          (right.type === 'int' || right.type === 'double')) {
        return psBool(left.value > right.value);
      }
      return psBool(psValueToString(left) > psValueToString(right));

    case TokenType.GE:
      if ((left.type === 'int' || left.type === 'double') &&
          (right.type === 'int' || right.type === 'double')) {
        return psBool(left.value >= right.value);
      }
      return psBool(psValueToString(left) >= psValueToString(right));

    case TokenType.LT:
      if ((left.type === 'int' || left.type === 'double') &&
          (right.type === 'int' || right.type === 'double')) {
        return psBool(left.value < right.value);
      }
      return psBool(psValueToString(left) < psValueToString(right));

    case TokenType.LE:
      if ((left.type === 'int' || left.type === 'double') &&
          (right.type === 'int' || right.type === 'double')) {
        return psBool(left.value <= right.value);
      }
      return psBool(psValueToString(left) <= psValueToString(right));

    case TokenType.AND:
      return psBool(psTruthy(left) && psTruthy(right));

    case TokenType.OR:
      return psBool(psTruthy(left) || psTruthy(right));

    default:
      return psNull();
  }
}

function expandVariables(str: string, context: PSContext): string {
  return str.replace(/\$(\w+)/g, (match, varName) => {
    const value = context.variables.get(varName);
    if (value) {
      return psValueToString(value);
    }
    // Check environment
    const envValue = context.env[varName] || context.env[varName.toUpperCase()];
    if (envValue) {
      return envValue;
    }
    return match;
  });
}

function formatPSValue(value: PSValue): string {
  switch (value.type) {
    case 'string':
      return value.value;
    case 'int':
    case 'double':
      return String(value.value);
    case 'bool':
      return value.value ? 'True' : 'False';
    case 'null':
      return '';
    case 'datetime':
      return value.value.toLocaleString();
    case 'array':
      return value.items.map(formatPSValue).join('\r\n');
    case 'hashtable':
      let result = '\r\nName                           Value\r\n----                           -----\r\n';
      value.entries.forEach((v, k) => {
        result += `${k.padEnd(30)} ${formatPSValue(v)}\r\n`;
      });
      return result;
    case 'psobject':
      let objResult = '';
      value.properties.forEach((v, k) => {
        objResult += `${k}: ${formatPSValue(v)}\r\n`;
      });
      return objResult;
    default:
      return String(value);
  }
}

// Import cmdlets
import { executeCmdlet } from './cmdlets';
