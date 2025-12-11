/**
 * Python Scope - Gestion des portées de variables
 */

import { PyValue, PyFunction, PyClass, pyNone } from './types';

export class Scope {
  private variables: Map<string, PyValue> = new Map();
  private parent: Scope | null;
  private globals: Scope;
  private globalNames: Set<string> = new Set();
  private nonlocalNames: Set<string> = new Set();

  constructor(parent: Scope | null = null) {
    this.parent = parent;
    this.globals = parent ? parent.globals : this;
  }

  // Get a variable's value
  get(name: string): PyValue | undefined {
    // Check if declared global
    if (this.globalNames.has(name)) {
      return this.globals.variables.get(name);
    }

    // Check if declared nonlocal
    if (this.nonlocalNames.has(name)) {
      return this.findNonlocal(name);
    }

    // Check local scope
    if (this.variables.has(name)) {
      return this.variables.get(name);
    }

    // Check parent scopes
    if (this.parent) {
      return this.parent.get(name);
    }

    return undefined;
  }

  // Set a variable's value
  set(name: string, value: PyValue): void {
    // Check if declared global
    if (this.globalNames.has(name)) {
      this.globals.variables.set(name, value);
      return;
    }

    // Check if declared nonlocal
    if (this.nonlocalNames.has(name)) {
      this.setNonlocal(name, value);
      return;
    }

    // Set in local scope
    this.variables.set(name, value);
  }

  // Check if variable exists (for assignment target checking)
  has(name: string): boolean {
    if (this.globalNames.has(name)) {
      return this.globals.variables.has(name);
    }

    if (this.nonlocalNames.has(name)) {
      return this.hasNonlocal(name);
    }

    if (this.variables.has(name)) {
      return true;
    }

    if (this.parent) {
      return this.parent.has(name);
    }

    return false;
  }

  // Delete a variable
  delete(name: string): boolean {
    if (this.globalNames.has(name)) {
      return this.globals.variables.delete(name);
    }

    if (this.variables.has(name)) {
      return this.variables.delete(name);
    }

    return false;
  }

  // Mark a variable as global
  declareGlobal(name: string): void {
    this.globalNames.add(name);
  }

  // Mark a variable as nonlocal
  declareNonlocal(name: string): void {
    this.nonlocalNames.add(name);
  }

  // Create a new child scope
  createChild(): Scope {
    return new Scope(this);
  }

  // Get global scope
  getGlobals(): Scope {
    return this.globals;
  }

  // Get all local variables
  getLocals(): Map<string, PyValue> {
    return new Map(this.variables);
  }

  // Helper: Find nonlocal variable in enclosing scopes
  private findNonlocal(name: string): PyValue | undefined {
    let scope: Scope | null = this.parent;

    while (scope && scope !== this.globals) {
      if (scope.variables.has(name)) {
        return scope.variables.get(name);
      }
      scope = scope.parent;
    }

    return undefined;
  }

  // Helper: Set nonlocal variable in enclosing scope
  private setNonlocal(name: string, value: PyValue): void {
    let scope: Scope | null = this.parent;

    while (scope && scope !== this.globals) {
      if (scope.variables.has(name)) {
        scope.variables.set(name, value);
        return;
      }
      scope = scope.parent;
    }

    // If not found, create in immediate parent
    if (this.parent) {
      this.parent.variables.set(name, value);
    }
  }

  // Helper: Check if nonlocal exists
  private hasNonlocal(name: string): boolean {
    let scope: Scope | null = this.parent;

    while (scope && scope !== this.globals) {
      if (scope.variables.has(name)) {
        return true;
      }
      scope = scope.parent;
    }

    return false;
  }
}

// Environment for the interpreter
export class Environment {
  scope: Scope;
  output: string[] = [];
  private inputBuffer: string[] = [];
  private inputCallback?: (prompt: string) => Promise<string>;

  constructor(scope?: Scope) {
    this.scope = scope || new Scope();
  }

  // Print output
  print(...args: string[]): void {
    this.output.push(args.join(' '));
  }

  // Get all output
  getOutput(): string {
    return this.output.join('\n');
  }

  // Clear output
  clearOutput(): void {
    this.output = [];
  }

  // Set input callback for interactive mode
  setInputCallback(callback: (prompt: string) => Promise<string>): void {
    this.inputCallback = callback;
  }

  // Add input to buffer
  addInput(input: string): void {
    this.inputBuffer.push(input);
  }

  // Get input (from buffer or callback)
  async getInput(prompt: string = ''): Promise<string> {
    if (this.inputBuffer.length > 0) {
      return this.inputBuffer.shift()!;
    }

    if (this.inputCallback) {
      return this.inputCallback(prompt);
    }

    throw new Error('No input available');
  }

  // Create a new environment with a child scope
  createChild(): Environment {
    const child = new Environment(this.scope.createChild());
    child.output = this.output;
    child.inputBuffer = this.inputBuffer;
    child.inputCallback = this.inputCallback;
    return child;
  }
}

// Helper to create a closure from current scope
export function createClosure(scope: Scope): Map<string, PyValue> {
  const closure = new Map<string, PyValue>();
  let current: Scope | null = scope;

  while (current) {
    const locals = current.getLocals();
    locals.forEach((value, key) => {
      if (!closure.has(key)) {
        closure.set(key, value);
      }
    });
    // Stop at global scope
    if (current === current.getGlobals()) break;
    current = null; // Only capture immediate scope for closure
  }

  return closure;
}
