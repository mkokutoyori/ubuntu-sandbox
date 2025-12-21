/**
 * Script Interpreter - Handles shell control structures (for, while, if)
 *
 * This module provides interpretation for shell scripts with control flow,
 * working alongside the existing command executor.
 */

import { executeShellCommand } from './executor';
import { TerminalState, CommandResult } from '../types';
import { FileSystem } from '../filesystem';
import { PackageManager } from '../packages';
import { expandVariables } from '../shellUtils';

export interface ShellFunction {
  name: string;
  body: string[];
  params: string[]; // $1, $2, etc. will be filled from call
}

// Global function registry (persists across commands)
const shellFunctions: Map<string, ShellFunction> = new Map();

/**
 * Clear all defined functions (for testing or reset)
 */
export function clearShellFunctions(): void {
  shellFunctions.clear();
}

/**
 * Get a defined function by name
 */
export function getShellFunction(name: string): ShellFunction | undefined {
  return shellFunctions.get(name);
}

/**
 * Check if a function is defined
 */
export function hasShellFunction(name: string): boolean {
  return shellFunctions.has(name);
}

/**
 * Define a shell function
 * Syntax: function name() { ... } or name() { ... }
 */
export function defineShellFunction(name: string, body: string[]): void {
  shellFunctions.set(name, {
    name,
    body,
    params: [],
  });
}

/**
 * Remove a shell function
 */
export function unsetShellFunction(name: string): boolean {
  return shellFunctions.delete(name);
}

/**
 * Get all defined function names
 */
export function listShellFunctions(): string[] {
  return Array.from(shellFunctions.keys());
}

/**
 * Get function definition as string (for declare -f)
 * Format matches real bash output:
 * name ()
 * {
 *     command
 * }
 */
export function getFunctionDefinition(name: string): string | null {
  const func = shellFunctions.get(name);
  if (!func) return null;
  return `${name} () \n{ \n${func.body.map(l => '    ' + l).join('\n')}\n}`;
}

export interface ScriptContext {
  state: TerminalState;
  fs: FileSystem;
  pm: PackageManager;
  localVars: Record<string, string>;
  positionalArgs?: string[]; // $1, $2, $@, $#, etc.
  arrays?: Record<string, string[]>; // Bash arrays
}

/**
 * Execute a shell script with control flow support
 */
export function executeScript(
  script: string,
  state: TerminalState,
  fs: FileSystem,
  pm: PackageManager
): CommandResult {
  const ctx: ScriptContext = {
    state: { ...state },
    fs,
    pm,
    localVars: {},
  };

  const lines = script.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  return executeLines(lines, ctx);
}

/**
 * Execute a list of lines with control flow
 */
function executeLines(lines: string[], ctx: ScriptContext): CommandResult {
  let output = '';
  let lastExitCode = 0;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // For loop: for VAR in VALUES; do ... done
    if (line.startsWith('for ')) {
      const result = executeForLoop(lines, i, ctx);
      output += result.output ? (output ? '\n' : '') + result.output : '';
      lastExitCode = result.exitCode;
      i = result.nextIndex;
      continue;
    }

    // While loop: while CONDITION; do ... done
    if (line.startsWith('while ')) {
      const result = executeWhileLoop(lines, i, ctx);
      output += result.output ? (output ? '\n' : '') + result.output : '';
      lastExitCode = result.exitCode;
      i = result.nextIndex;
      continue;
    }

    // If statement: if CONDITION; then ... [elif ... then ...] [else ...] fi
    if (line.startsWith('if ')) {
      const result = executeIfStatement(lines, i, ctx);
      output += result.output ? (output ? '\n' : '') + result.output : '';
      lastExitCode = result.exitCode;
      i = result.nextIndex;
      continue;
    }

    // Case statement: case WORD in ... esac
    if (line.startsWith('case ')) {
      const result = executeCaseStatement(lines, i, ctx);
      output += result.output ? (output ? '\n' : '') + result.output : '';
      lastExitCode = result.exitCode;
      i = result.nextIndex;
      continue;
    }

    // Function definition: function name() { ... } or name() { ... }
    const funcDefResult = tryParseFunctionDefinition(lines, i, ctx);
    if (funcDefResult) {
      i = funcDefResult.nextIndex;
      continue;
    }

    // Regular command
    const result = executeLineWithVars(line, ctx);
    if (result.output) {
      output += (output ? '\n' : '') + result.output;
    }
    lastExitCode = result.exitCode;
    i++;
  }

  return { output, exitCode: lastExitCode };
}

/**
 * Execute a line with local variable expansion
 */
function executeLineWithVars(line: string, ctx: ScriptContext): CommandResult {
  // Expand positional arguments first ($1, $2, $@, $#, $*)
  let expandedLine = expandPositionalArgs(line, ctx);

  // Expand local variables
  for (const [name, value] of Object.entries(ctx.localVars)) {
    expandedLine = expandedLine.replace(new RegExp(`\\$${name}\\b`, 'g'), value);
    expandedLine = expandedLine.replace(new RegExp(`\\$\\{${name}\\}`, 'g'), value);
  }

  // Expand special variables ($?, $$)
  expandedLine = expandedLine.replace(/\$\?/g, (ctx.state.lastExitCode ?? 0).toString());
  expandedLine = expandedLine.replace(/\$\$/g, '1'); // Fake PID

  // Expand array references
  if (ctx.arrays) {
    expandedLine = expandArrays(expandedLine, ctx.arrays);
  }

  // Also expand environment variables
  expandedLine = expandVariables(expandedLine, ctx.state.env);

  // Handle 'local' variable declaration (local var=value or local var)
  const localMatch = expandedLine.match(/^local\s+([A-Za-z_][A-Za-z0-9_]*)(?:=(.*))?$/);
  if (localMatch) {
    const [, name, value] = localMatch;
    ctx.localVars[name] = value ? value.replace(/^["']|["']$/g, '') : '';
    return { output: '', exitCode: 0 };
  }

  // Handle array assignment: arr=(a b c)
  const arrayAssignMatch = expandedLine.match(/^([A-Za-z_][A-Za-z0-9_]*)=\(([^)]*)\)$/);
  if (arrayAssignMatch) {
    const [, name, elements] = arrayAssignMatch;
    if (!ctx.arrays) ctx.arrays = {};
    // Parse array elements (handles quoted strings)
    const values = parseArrayElements(elements);
    ctx.arrays[name] = values;
    return { output: '', exitCode: 0 };
  }

  // Handle variable assignment
  const assignMatch = expandedLine.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (assignMatch) {
    const [, name, value] = assignMatch;
    ctx.localVars[name] = value.replace(/^["']|["']$/g, '');
    return { output: '', exitCode: 0 };
  }

  // Handle 'return' statement inside functions
  const returnMatch = expandedLine.match(/^return(?:\s+(\d+))?$/);
  if (returnMatch) {
    const exitCode = returnMatch[1] ? parseInt(returnMatch[1]) : 0;
    return { output: '', exitCode, error: '__return__' };
  }

  // Handle 'shift' command to shift positional arguments
  const shiftMatch = expandedLine.match(/^shift(?:\s+(\d+))?$/);
  if (shiftMatch && ctx.positionalArgs) {
    const n = shiftMatch[1] ? parseInt(shiftMatch[1]) : 1;
    ctx.positionalArgs = ctx.positionalArgs.slice(n);
    return { output: '', exitCode: 0 };
  }

  // Handle 'declare -f' to list/show functions
  const declareFMatch = expandedLine.match(/^declare\s+-f(?:\s+([A-Za-z_][A-Za-z0-9_]*))?$/);
  if (declareFMatch) {
    const funcName = declareFMatch[1];
    if (funcName) {
      // Show specific function
      const def = getFunctionDefinition(funcName);
      if (def) {
        return { output: def, exitCode: 0 };
      }
      return { output: '', error: `declare: ${funcName}: not found`, exitCode: 1 };
    } else {
      // List all functions
      const funcs = listShellFunctions();
      const defs = funcs.map(name => getFunctionDefinition(name)).filter(Boolean);
      return { output: defs.join('\n'), exitCode: 0 };
    }
  }

  // Handle 'unset -f' to remove functions
  const unsetFMatch = expandedLine.match(/^unset\s+-f\s+([A-Za-z_][A-Za-z0-9_]*)$/);
  if (unsetFMatch) {
    const funcName = unsetFMatch[1];
    unsetShellFunction(funcName);
    return { output: '', exitCode: 0 };
  }

  // Check if line is a function call
  const funcCallResult = tryCallFunction(expandedLine, ctx);
  if (funcCallResult !== null) {
    return funcCallResult;
  }

  return executeShellCommand(expandedLine, ctx.state, ctx.fs, ctx.pm);
}

/**
 * Expand positional arguments ($1, $2, $@, $#, $*, $0)
 */
function expandPositionalArgs(line: string, ctx: ScriptContext): string {
  if (!ctx.positionalArgs || ctx.positionalArgs.length === 0) {
    // Replace with empty if no args
    return line
      .replace(/\$@/g, '')
      .replace(/\$\*/g, '')
      .replace(/\$#/g, '0')
      .replace(/\$0/g, 'bash')
      .replace(/\$(\d+)/g, '');
  }

  let result = line;
  const args = ctx.positionalArgs;

  // $# - number of arguments
  result = result.replace(/\$#/g, args.length.toString());

  // $@ and $* - all arguments (simplified - $@ should quote each arg separately)
  const allArgs = args.join(' ');
  result = result.replace(/\$@/g, allArgs);
  result = result.replace(/\$\*/g, allArgs);

  // $0 - script name (use "bash" as default)
  result = result.replace(/\$0/g, 'bash');

  // $1, $2, etc. - individual arguments
  result = result.replace(/\$(\d+)/g, (_, num) => {
    const index = parseInt(num) - 1;
    return index >= 0 && index < args.length ? args[index] : '';
  });

  // ${1}, ${2}, etc.
  result = result.replace(/\$\{(\d+)\}/g, (_, num) => {
    const index = parseInt(num) - 1;
    return index >= 0 && index < args.length ? args[index] : '';
  });

  return result;
}

/**
 * Parse array elements from (a b c) content
 */
function parseArrayElements(input: string): string[] {
  const elements: string[] = [];
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
        elements.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }

  if (current) {
    elements.push(current);
  }

  return elements;
}

/**
 * Expand array references in a string
 */
function expandArrays(input: string, arrays: Record<string, string[]>): string {
  let result = input;

  // Handle ${#arr[@]} - array length
  result = result.replace(/\$\{#([A-Za-z_][A-Za-z0-9_]*)\[@\]\}/g, (_, name) => {
    return (arrays[name]?.length || 0).toString();
  });

  // Handle ${arr[@]} and ${arr[*]} - all elements
  result = result.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\[[@*]\]\}/g, (_, name) => {
    return (arrays[name] || []).join(' ');
  });

  // Handle ${arr[n]} - specific index
  result = result.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\[(\d+)\]\}/g, (_, name, index) => {
    const arr = arrays[name];
    const idx = parseInt(index);
    return arr && idx < arr.length ? arr[idx] : '';
  });

  return result;
}

/**
 * Parse a command line respecting quoted strings
 */
function parseCommandArgs(input: string): string[] {
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

  return tokens;
}

/**
 * Try to call a shell function
 */
function tryCallFunction(line: string, ctx: ScriptContext): CommandResult | null {
  // Parse the command and arguments respecting quotes
  const parts = parseCommandArgs(line.trim());
  if (parts.length === 0) return null;

  const funcName = parts[0];
  const func = shellFunctions.get(funcName);

  if (!func) return null;

  // Get arguments for the function
  const args = parts.slice(1);

  // Create a new context with positional args
  const funcCtx: ScriptContext = {
    state: ctx.state,
    fs: ctx.fs,
    pm: ctx.pm,
    localVars: { ...ctx.localVars },
    positionalArgs: args,
  };

  // Execute function body
  let output = '';
  let exitCode = 0;

  for (const bodyLine of func.body) {
    const result = executeLineWithVars(bodyLine, funcCtx);
    if (result.output) {
      output += (output ? '\n' : '') + result.output;
    }
    exitCode = result.exitCode;

    // Handle return statement
    if (result.error === '__return__') {
      break;
    }
  }

  return { output, exitCode };
}

/**
 * Try to parse a function definition
 * Syntax:
 *   function name() { ... }
 *   function name { ... }
 *   name() { ... }
 */
function tryParseFunctionDefinition(
  lines: string[],
  startIndex: number,
  _ctx: ScriptContext
): { nextIndex: number } | null {
  const line = lines[startIndex];

  // Match function definitions:
  // - function name() {
  // - function name {
  // - name() {
  const funcMatch = line.match(
    /^(?:function\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*\)\s*\{?\s*$|^function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{?\s*$/
  );

  if (!funcMatch) return null;

  const funcName = funcMatch[1] || funcMatch[2];
  if (!funcName) return null;

  // Find opening brace if not on same line
  let i = startIndex;
  let foundBrace = line.includes('{');

  if (!foundBrace) {
    i++;
    while (i < lines.length) {
      if (lines[i] === '{') {
        foundBrace = true;
        break;
      } else if (lines[i].trim() !== '') {
        // Non-empty line that isn't brace - not a function definition
        return null;
      }
      i++;
    }
  }

  if (!foundBrace) return null;

  // Now find the matching closing brace
  const body: string[] = [];
  let depth = 1;
  i++;

  while (i < lines.length && depth > 0) {
    const bodyLine = lines[i];

    // Count braces (simplified - doesn't handle braces in strings)
    for (const char of bodyLine) {
      if (char === '{') depth++;
      if (char === '}') depth--;
    }

    if (depth > 0) {
      body.push(bodyLine);
    } else if (bodyLine.trim() !== '}') {
      // Line contains } but has other content before it
      const content = bodyLine.substring(0, bodyLine.lastIndexOf('}'));
      if (content.trim()) {
        body.push(content.trim());
      }
    }

    i++;
  }

  // Register the function
  defineShellFunction(funcName, body);

  return { nextIndex: i };
}

interface LoopResult extends CommandResult {
  nextIndex: number;
}

/**
 * Execute a for loop
 * Syntax: for VAR in VALUE1 VALUE2 ...; do COMMANDS; done
 * Or multi-line:
 *   for VAR in VALUES
 *   do
 *     COMMANDS
 *   done
 */
function executeForLoop(lines: string[], startIndex: number, ctx: ScriptContext): LoopResult {
  const line = lines[startIndex];

  // Parse for loop header: for VAR in VALUES [; do]
  const match = line.match(/^for\s+(\w+)\s+in\s+(.+?)(?:\s*;\s*do)?$/);
  if (!match) {
    return { output: '', error: 'syntax error: invalid for loop', exitCode: 2, nextIndex: startIndex + 1 };
  }

  const [, varName, valuesPart] = match;

  // Parse values (handle quoted strings, brace expansion, etc.)
  const values = parseValues(valuesPart, ctx);

  // Find loop body (between do and done)
  const { body, endIndex } = findLoopBody(lines, startIndex, 'do', 'done');

  let output = '';
  let lastExitCode = 0;

  // Execute loop body for each value
  for (const value of values) {
    ctx.localVars[varName] = value;

    const result = executeLines(body, ctx);
    if (result.output) {
      output += (output ? '\n' : '') + result.output;
    }
    lastExitCode = result.exitCode;

    // Handle break/continue (simplified)
    if (result.error === '__break__') break;
    if (result.error === '__continue__') continue;
  }

  delete ctx.localVars[varName];

  return { output, exitCode: lastExitCode, nextIndex: endIndex + 1 };
}

/**
 * Execute a while loop
 * Syntax: while CONDITION; do COMMANDS; done
 */
function executeWhileLoop(lines: string[], startIndex: number, ctx: ScriptContext): LoopResult {
  const line = lines[startIndex];

  // Parse while loop header: while CONDITION [; do]
  const match = line.match(/^while\s+(.+?)(?:\s*;\s*do)?$/);
  if (!match) {
    return { output: '', error: 'syntax error: invalid while loop', exitCode: 2, nextIndex: startIndex + 1 };
  }

  const [, condition] = match;

  // Find loop body
  const { body, endIndex } = findLoopBody(lines, startIndex, 'do', 'done');

  let output = '';
  let lastExitCode = 0;
  let iterations = 0;
  const maxIterations = 1000; // Prevent infinite loops

  // Execute while condition is true
  while (iterations < maxIterations) {
    const condResult = executeLineWithVars(condition, ctx);
    if (condResult.exitCode !== 0) break;

    const result = executeLines(body, ctx);
    if (result.output) {
      output += (output ? '\n' : '') + result.output;
    }
    lastExitCode = result.exitCode;

    if (result.error === '__break__') break;
    if (result.error === '__continue__') continue;

    iterations++;
  }

  return { output, exitCode: lastExitCode, nextIndex: endIndex + 1 };
}

/**
 * Execute an if statement
 * Syntax: if CONDITION; then COMMANDS [elif CONDITION; then COMMANDS] [else COMMANDS] fi
 */
function executeIfStatement(lines: string[], startIndex: number, ctx: ScriptContext): LoopResult {
  const line = lines[startIndex];

  // Parse if header: if CONDITION [; then]
  const match = line.match(/^if\s+(.+?)(?:\s*;\s*then)?$/);
  if (!match) {
    return { output: '', error: 'syntax error: invalid if statement', exitCode: 2, nextIndex: startIndex + 1 };
  }

  const [, condition] = match;

  // Find the structure of the if statement
  const { branches, endIndex } = findIfStructure(lines, startIndex);

  let output = '';
  let exitCode = 0;
  let executed = false;

  // Evaluate conditions in order
  for (const branch of branches) {
    if (branch.type === 'else') {
      if (!executed) {
        const result = executeLines(branch.body, ctx);
        output = result.output;
        exitCode = result.exitCode;
      }
      break;
    }

    if (!executed) {
      const condResult = executeLineWithVars(branch.condition!, ctx);
      if (condResult.exitCode === 0) {
        const result = executeLines(branch.body, ctx);
        output = result.output;
        exitCode = result.exitCode;
        executed = true;
      }
    }
  }

  return { output, exitCode, nextIndex: endIndex + 1 };
}

/**
 * Execute a case statement
 * Syntax: case WORD in PATTERN) COMMANDS ;; ... esac
 */
function executeCaseStatement(lines: string[], startIndex: number, ctx: ScriptContext): LoopResult {
  const line = lines[startIndex];

  const match = line.match(/^case\s+(\S+)\s+in$/);
  if (!match) {
    return { output: '', error: 'syntax error: invalid case statement', exitCode: 2, nextIndex: startIndex + 1 };
  }

  let word = match[1];
  // Expand variables in word
  word = expandVariables(word, ctx.state.env);
  for (const [name, value] of Object.entries(ctx.localVars)) {
    word = word.replace(new RegExp(`\\$${name}\\b`, 'g'), value);
  }
  word = word.replace(/^["']|["']$/g, '');

  // Find case patterns and their commands
  const { cases, endIndex } = findCaseStructure(lines, startIndex);

  let output = '';
  let exitCode = 0;

  for (const caseItem of cases) {
    if (matchPattern(word, caseItem.pattern)) {
      const result = executeLines(caseItem.body, ctx);
      output = result.output;
      exitCode = result.exitCode;
      break;
    }
  }

  return { output, exitCode, nextIndex: endIndex + 1 };
}

/**
 * Parse values for a for loop (handles glob, brace expansion, etc.)
 */
function parseValues(valuesPart: string, ctx: ScriptContext): string[] {
  // Expand variables first
  let expanded = valuesPart;
  for (const [name, value] of Object.entries(ctx.localVars)) {
    expanded = expanded.replace(new RegExp(`\\$${name}\\b`, 'g'), value);
  }
  expanded = expandVariables(expanded, ctx.state.env);

  // Handle brace expansion {1..5} or {a,b,c}
  const braceMatch = expanded.match(/\{(\d+)\.\.(\d+)\}/);
  if (braceMatch) {
    const start = parseInt(braceMatch[1]);
    const end = parseInt(braceMatch[2]);
    const values: string[] = [];
    for (let i = start; i <= end; i++) {
      values.push(i.toString());
    }
    return values;
  }

  const commaMatch = expanded.match(/\{([^}]+)\}/);
  if (commaMatch) {
    return commaMatch[1].split(',').map(s => s.trim());
  }

  // Handle $(command) substitution
  const cmdMatch = expanded.match(/\$\(([^)]+)\)/);
  if (cmdMatch) {
    const result = executeShellCommand(cmdMatch[1], ctx.state, ctx.fs, ctx.pm);
    return result.output.split(/\s+/).filter(s => s);
  }

  // Simple space-separated values
  return expanded.split(/\s+/).filter(s => s);
}

/**
 * Find the body of a loop (between start and end keywords)
 */
function findLoopBody(
  lines: string[],
  startIndex: number,
  startKeyword: string,
  endKeyword: string
): { body: string[]; endIndex: number } {
  const body: string[] = [];
  let depth = 1;
  let foundDo = lines[startIndex].includes('; do') || lines[startIndex].includes(';do');
  let i = startIndex + 1;

  while (i < lines.length && depth > 0) {
    const line = lines[i];

    // Track nested structures
    if (line.startsWith('for ') || line.startsWith('while ') || line.startsWith('until ')) {
      if (!foundDo) {
        if (line === 'do') {
          foundDo = true;
          i++;
          continue;
        }
      }
      depth++;
    }

    if (!foundDo && line === 'do') {
      foundDo = true;
      i++;
      continue;
    }

    if (line === endKeyword || line.startsWith(endKeyword + ' ')) {
      depth--;
      if (depth === 0) break;
    }

    if (foundDo && depth > 0) {
      body.push(line);
    }

    i++;
  }

  return { body, endIndex: i };
}

/**
 * Find the structure of an if statement
 */
interface IfBranch {
  type: 'if' | 'elif' | 'else';
  condition?: string;
  body: string[];
}

function findIfStructure(
  lines: string[],
  startIndex: number
): { branches: IfBranch[]; endIndex: number } {
  const branches: IfBranch[] = [];
  let i = startIndex;
  let depth = 1;
  let currentBranch: IfBranch | null = null;

  // Parse initial if
  const ifMatch = lines[i].match(/^if\s+(.+?)(?:\s*;\s*then)?$/);
  if (ifMatch) {
    currentBranch = { type: 'if', condition: ifMatch[1], body: [] };
  }

  let foundThen = lines[i].includes('; then') || lines[i].includes(';then');
  i++;

  while (i < lines.length && depth > 0) {
    const line = lines[i];

    // Handle nested if
    if (line.startsWith('if ')) {
      depth++;
      if (foundThen && currentBranch) {
        currentBranch.body.push(line);
      }
      i++;
      continue;
    }

    if (!foundThen && line === 'then') {
      foundThen = true;
      i++;
      continue;
    }

    if (depth === 1 && line.startsWith('elif ')) {
      if (currentBranch) branches.push(currentBranch);
      const elifMatch = line.match(/^elif\s+(.+?)(?:\s*;\s*then)?$/);
      currentBranch = { type: 'elif', condition: elifMatch?.[1] || '', body: [] };
      foundThen = line.includes('; then');
      i++;
      continue;
    }

    if (depth === 1 && line === 'else') {
      if (currentBranch) branches.push(currentBranch);
      currentBranch = { type: 'else', body: [] };
      i++;
      continue;
    }

    if (line === 'fi') {
      depth--;
      if (depth === 0) {
        if (currentBranch) branches.push(currentBranch);
        break;
      }
    }

    if (foundThen && currentBranch && depth > 0) {
      currentBranch.body.push(line);
    }

    i++;
  }

  return { branches, endIndex: i };
}

/**
 * Find the structure of a case statement
 */
interface CaseItem {
  pattern: string;
  body: string[];
}

function findCaseStructure(
  lines: string[],
  startIndex: number
): { cases: CaseItem[]; endIndex: number } {
  const cases: CaseItem[] = [];
  let i = startIndex + 1;
  let currentCase: CaseItem | null = null;

  while (i < lines.length) {
    const line = lines[i];

    if (line === 'esac') {
      if (currentCase) cases.push(currentCase);
      break;
    }

    // Pattern line: pattern)
    const patternMatch = line.match(/^(.+)\)$/);
    if (patternMatch) {
      if (currentCase) cases.push(currentCase);
      currentCase = { pattern: patternMatch[1].trim(), body: [] };
      i++;
      continue;
    }

    // End of case: ;;
    if (line === ';;') {
      if (currentCase) {
        cases.push(currentCase);
        currentCase = null;
      }
      i++;
      continue;
    }

    if (currentCase) {
      currentCase.body.push(line);
    }

    i++;
  }

  return { cases, endIndex: i };
}

/**
 * Match a value against a shell pattern
 */
function matchPattern(value: string, pattern: string): boolean {
  // Handle * wildcard pattern
  if (pattern === '*') return true;

  // Handle simple patterns with * and ?
  const regexPattern = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');

  return new RegExp(`^${regexPattern}$`).test(value);
}

/**
 * Execute inline loop (for single-line for loops)
 * Syntax: for i in 1 2 3; do echo $i; done
 */
export function executeInlineLoop(
  command: string,
  state: TerminalState,
  fs: FileSystem,
  pm: PackageManager
): CommandResult | null {
  // Check if it's a complete inline loop
  const forMatch = command.match(/^for\s+(\w+)\s+in\s+(.+?);\s*do\s+(.+?);\s*done$/);
  if (forMatch) {
    const [, varName, valuesPart, bodyCommand] = forMatch;
    const ctx: ScriptContext = { state, fs, pm, localVars: {} };
    const values = parseValues(valuesPart, ctx);

    let output = '';
    let lastExitCode = 0;

    for (const value of values) {
      ctx.localVars[varName] = value;
      const result = executeLineWithVars(bodyCommand, ctx);
      if (result.output) {
        output += (output ? '\n' : '') + result.output;
      }
      lastExitCode = result.exitCode;
    }

    return { output, exitCode: lastExitCode };
  }

  // Check if it's an inline while loop
  const whileMatch = command.match(/^while\s+(.+?);\s*do\s+(.+?);\s*done$/);
  if (whileMatch) {
    const [, condition, bodyCommand] = whileMatch;
    const ctx: ScriptContext = { state, fs, pm, localVars: {} };

    let output = '';
    let lastExitCode = 0;
    let iterations = 0;

    while (iterations < 100) {
      const condResult = executeLineWithVars(condition, ctx);
      if (condResult.exitCode !== 0) break;

      const result = executeLineWithVars(bodyCommand, ctx);
      if (result.output) {
        output += (output ? '\n' : '') + result.output;
      }
      lastExitCode = result.exitCode;
      iterations++;
    }

    return { output, exitCode: lastExitCode };
  }

  // Check if it's an inline if statement
  const ifMatch = command.match(/^if\s+(.+?);\s*then\s+(.+?)(?:;\s*else\s+(.+?))?;\s*fi$/);
  if (ifMatch) {
    const [, condition, thenCmd, elseCmd] = ifMatch;
    const ctx: ScriptContext = { state, fs, pm, localVars: {} };

    const condResult = executeLineWithVars(condition, ctx);
    if (condResult.exitCode === 0) {
      return executeLineWithVars(thenCmd, ctx);
    } else if (elseCmd) {
      return executeLineWithVars(elseCmd, ctx);
    }
    return { output: '', exitCode: 0 };
  }

  // Check if it's an inline function definition: name() { cmd; }
  const inlineFuncMatch = command.match(
    /^(?:function\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*\)\s*\{\s*(.+?)\s*\}$/
  );
  if (inlineFuncMatch) {
    const [, funcName, bodyContent] = inlineFuncMatch;
    // Split body by semicolons
    const bodyLines = bodyContent.split(/\s*;\s*/).filter(l => l.trim());
    defineShellFunction(funcName, bodyLines);
    return { output: '', exitCode: 0 };
  }

  // Check if it's a function call (defined function)
  const parts = parseCommandArgs(command.trim());
  if (parts.length > 0 && shellFunctions.has(parts[0])) {
    const ctx: ScriptContext = { state, fs, pm, localVars: {} };
    return tryCallFunction(command, ctx);
  }

  // Handle special builtins: declare -f, unset -f
  const declareFMatch = command.match(/^declare\s+-f(?:\s+([A-Za-z_][A-Za-z0-9_]*))?$/);
  if (declareFMatch) {
    const funcName = declareFMatch[1];
    if (funcName) {
      const def = getFunctionDefinition(funcName);
      if (def) {
        return { output: def, exitCode: 0 };
      }
      return { output: '', error: `declare: ${funcName}: not found`, exitCode: 1 };
    } else {
      const funcs = listShellFunctions();
      const defs = funcs.map(name => getFunctionDefinition(name)).filter(Boolean);
      return { output: defs.join('\n'), exitCode: 0 };
    }
  }

  const unsetFMatch = command.match(/^unset\s+-f\s+([A-Za-z_][A-Za-z0-9_]*)$/);
  if (unsetFMatch) {
    unsetShellFunction(unsetFMatch[1]);
    return { output: '', exitCode: 0 };
  }

  return null;
}
