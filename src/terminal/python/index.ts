/**
 * Python Simulator - Main Entry Point
 *
 * Provides a Python REPL and script execution environment
 * integrated with the terminal simulator.
 */

import { Lexer, tokenize } from './lexer';
import { Parser, parse } from './parser';
import { Interpreter } from './interpreter';
import { Environment, Scope } from './scope';
import { PyValue, pyNone, pyRepr, pyStr_value } from './types';
import { PyError, SyntaxError, SystemExit } from './errors';

export interface PythonSession {
  interpreter: Interpreter;
  isMultiLine: boolean;
  buffer: string;
  prompt: string;
}

// Create a new Python session
export function createPythonSession(): PythonSession {
  const interpreter = new Interpreter();
  return {
    interpreter,
    isMultiLine: false,
    buffer: '',
    prompt: '>>> '
  };
}

// Execute a line of Python code
export function executeLine(
  session: PythonSession,
  line: string
): { output: string; prompt: string; exit: boolean } {
  const { interpreter } = session;

  // Handle exit commands
  if (line.trim() === 'exit()' || line.trim() === 'quit()' || line.trim() === 'exit' || line.trim() === 'quit') {
    return { output: '', prompt: '', exit: true };
  }

  // Handle multi-line input
  if (session.isMultiLine) {
    if (line === '') {
      // Empty line ends multi-line input
      const code = session.buffer;
      session.buffer = '';
      session.isMultiLine = false;
      session.prompt = '>>> ';
      return executeCode(interpreter, code);
    } else {
      session.buffer += '\n' + line;
      return { output: '', prompt: '... ', exit: false };
    }
  }

  // Check if this starts a multi-line block
  const trimmed = line.trim();
  if (trimmed.endsWith(':') ||
      trimmed.startsWith('def ') ||
      trimmed.startsWith('class ') ||
      trimmed.startsWith('if ') ||
      trimmed.startsWith('elif ') ||
      trimmed.startsWith('else:') ||
      trimmed.startsWith('for ') ||
      trimmed.startsWith('while ') ||
      trimmed.startsWith('try:') ||
      trimmed.startsWith('except') ||
      trimmed.startsWith('finally:') ||
      trimmed.startsWith('with ') ||
      trimmed.startsWith('@')) {
    session.isMultiLine = true;
    session.buffer = line;
    session.prompt = '... ';
    return { output: '', prompt: '... ', exit: false };
  }

  // Check for incomplete expressions (open brackets/parens)
  if (hasUnclosedBrackets(line)) {
    session.isMultiLine = true;
    session.buffer = line;
    session.prompt = '... ';
    return { output: '', prompt: '... ', exit: false };
  }

  // Execute single line
  return executeCode(interpreter, line);
}

// Check for unclosed brackets/parentheses
function hasUnclosedBrackets(code: string): boolean {
  let parens = 0, brackets = 0, braces = 0;
  let inString = false;
  let stringChar = '';

  for (let i = 0; i < code.length; i++) {
    const char = code[i];
    const prev = i > 0 ? code[i - 1] : '';

    // Handle strings
    if ((char === '"' || char === "'") && prev !== '\\') {
      if (!inString) {
        inString = true;
        stringChar = char;
      } else if (char === stringChar) {
        inString = false;
      }
    }

    if (inString) continue;

    // Count brackets
    if (char === '(') parens++;
    else if (char === ')') parens--;
    else if (char === '[') brackets++;
    else if (char === ']') brackets--;
    else if (char === '{') braces++;
    else if (char === '}') braces--;
  }

  return parens > 0 || brackets > 0 || braces > 0 || inString;
}

// Execute Python code and return output
function executeCode(
  interpreter: Interpreter,
  code: string
): { output: string; prompt: string; exit: boolean } {
  interpreter.clearOutput();

  try {
    // Tokenize
    const tokens = tokenize(code);

    // Parse
    const parser = new Parser(tokens);
    const statements = parser.parse();

    if (statements.length === 0) {
      return { output: '', prompt: '>>> ', exit: false };
    }

    // Execute
    let result: PyValue = pyNone();
    for (const stmt of statements) {
      result = interpreter.evaluate(stmt);
    }

    // Get output
    let output = interpreter.getOutput();

    // If it was an expression (not assignment, not function def, etc.), show the result
    const lastStmt = statements[statements.length - 1];
    if (lastStmt.type === 'ExprStatement') {
      const exprType = (lastStmt as any).expr?.type;
      if (exprType !== 'Assignment' && result.type !== 'NoneType') {
        const repr = pyRepr(result);
        output = output ? output + '\n' + repr : repr;
      }
    }

    return { output, prompt: '>>> ', exit: false };
  } catch (e) {
    if (e instanceof SystemExit) {
      return { output: '', prompt: '', exit: true };
    }

    if (e instanceof PyError) {
      return { output: e.toString(), prompt: '>>> ', exit: false };
    }

    if (e instanceof Error) {
      return { output: `Error: ${e.message}`, prompt: '>>> ', exit: false };
    }

    return { output: 'Unknown error', prompt: '>>> ', exit: false };
  }
}

// Execute a Python script (multiple lines)
export function executeScript(code: string): { output: string; error?: string } {
  const interpreter = new Interpreter();

  try {
    const tokens = tokenize(code);
    const parser = new Parser(tokens);
    const statements = parser.parse();

    for (const stmt of statements) {
      interpreter.evaluate(stmt);
    }

    return { output: interpreter.getOutput() };
  } catch (e) {
    if (e instanceof PyError) {
      return { output: interpreter.getOutput(), error: e.toString() };
    }
    if (e instanceof Error) {
      return { output: interpreter.getOutput(), error: e.message };
    }
    return { output: interpreter.getOutput(), error: 'Unknown error' };
  }
}

// Execute Python with -c flag
export function executeCommand(command: string): { output: string; error?: string } {
  return executeScript(command);
}

// Export all components
export { Lexer, tokenize } from './lexer';
export { Parser, parse } from './parser';
export { Interpreter } from './interpreter';
export { Environment, Scope } from './scope';
export * from './types';
export * from './errors';
