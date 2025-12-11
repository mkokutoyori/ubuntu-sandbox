/**
 * Python Errors - Erreurs et exceptions Python
 */

export class PyError extends Error {
  pythonType: string;

  constructor(type: string, message: string) {
    super(message);
    this.pythonType = type;
    this.name = type;
  }

  toString(): string {
    return `${this.pythonType}: ${this.message}`;
  }
}

export class SyntaxError extends PyError {
  line: number;
  column: number;

  constructor(message: string, line: number = 0, column: number = 0) {
    super('SyntaxError', message);
    this.line = line;
    this.column = column;
  }

  toString(): string {
    if (this.line > 0) {
      return `  File "<stdin>", line ${this.line}\nSyntaxError: ${this.message}`;
    }
    return `SyntaxError: ${this.message}`;
  }
}

export class NameError extends PyError {
  constructor(name: string) {
    super('NameError', `name '${name}' is not defined`);
  }
}

export class TypeError extends PyError {
  constructor(message: string) {
    super('TypeError', message);
  }
}

export class ValueError extends PyError {
  constructor(message: string) {
    super('ValueError', message);
  }
}

export class IndexError extends PyError {
  constructor(message: string = 'list index out of range') {
    super('IndexError', message);
  }
}

export class KeyError extends PyError {
  constructor(key: string) {
    super('KeyError', `'${key}'`);
  }
}

export class ZeroDivisionError extends PyError {
  constructor(message: string = 'division by zero') {
    super('ZeroDivisionError', message);
  }
}

export class AttributeError extends PyError {
  constructor(type: string, attr: string) {
    super('AttributeError', `'${type}' object has no attribute '${attr}'`);
  }
}

export class ImportError extends PyError {
  constructor(module: string) {
    super('ImportError', `No module named '${module}'`);
  }
}

export class ModuleNotFoundError extends PyError {
  constructor(module: string) {
    super('ModuleNotFoundError', `No module named '${module}'`);
  }
}

export class StopIteration extends PyError {
  value: any;

  constructor(value: any = null) {
    super('StopIteration', '');
    this.value = value;
  }
}

export class RuntimeError extends PyError {
  constructor(message: string) {
    super('RuntimeError', message);
  }
}

export class RecursionError extends PyError {
  constructor(message: string = 'maximum recursion depth exceeded') {
    super('RecursionError', message);
  }
}

export class AssertionError extends PyError {
  constructor(message: string = '') {
    super('AssertionError', message);
  }
}

export class NotImplementedError extends PyError {
  constructor(message: string = '') {
    super('NotImplementedError', message);
  }
}

export class IndentationError extends PyError {
  constructor(message: string = 'unexpected indent') {
    super('IndentationError', message);
  }
}

export class UnboundLocalError extends PyError {
  constructor(name: string) {
    super('UnboundLocalError', `local variable '${name}' referenced before assignment`);
  }
}

export class OverflowError extends PyError {
  constructor(message: string) {
    super('OverflowError', message);
  }
}

export class FileNotFoundError extends PyError {
  constructor(filename: string) {
    super('FileNotFoundError', `[Errno 2] No such file or directory: '${filename}'`);
  }
}

export class PermissionError extends PyError {
  constructor(message: string) {
    super('PermissionError', message);
  }
}

export class EOFError extends PyError {
  constructor(message: string = 'EOF when reading a line') {
    super('EOFError', message);
  }
}

export class KeyboardInterrupt extends PyError {
  constructor() {
    super('KeyboardInterrupt', '');
  }
}

export class SystemExit extends PyError {
  code: number;

  constructor(code: number = 0) {
    super('SystemExit', String(code));
    this.code = code;
  }
}

// Control flow exceptions (internal use)
export class BreakException extends Error {
  constructor() {
    super('break');
    this.name = 'BreakException';
  }
}

export class ContinueException extends Error {
  constructor() {
    super('continue');
    this.name = 'ContinueException';
  }
}

export class ReturnException extends Error {
  value: any;

  constructor(value: any) {
    super('return');
    this.name = 'ReturnException';
    this.value = value;
  }
}

// Format traceback
export function formatTraceback(error: PyError, stack: string[] = []): string {
  let result = 'Traceback (most recent call last):\n';

  for (const frame of stack) {
    result += `  ${frame}\n`;
  }

  result += error.toString();
  return result;
}
