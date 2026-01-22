/**
 * STUB FILE - will be rebuilt with TDD
 * Python interpreter for terminal
 */

export interface PythonContext {
  globals: Record<string, any>;
  locals: Record<string, any>;
  output: string[];
}

export interface PythonSession {
  id: string;
  context: PythonContext;
  isActive: boolean;
}

export function createPythonSession(deviceId: string): PythonSession {
  return {
    id: `python-${deviceId}-${Date.now()}`,
    context: {
      globals: {},
      locals: {},
      output: []
    },
    isActive: true
  };
}

export function executeLine(line: string, session: PythonSession): string {
  // Stub implementation
  if (line.trim() === 'exit()' || line.trim() === 'quit()') {
    session.isActive = false;
    return '';
  }
  return `STUB: Python execution result for: ${line}`;
}
