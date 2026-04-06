/**
 * Tests for the `echo` builtin — flags, escape sequences, edge cases.
 */

import { describe, it, expect } from 'vitest';
import { executeBuiltin } from '@/bash/runtime/Builtins';
import { Environment } from '@/bash/runtime/Environment';

const env = new Environment();
const noFunctions = new Map();
function echo(args: string[]) {
  return executeBuiltin('echo', args, env, noFunctions);
}

describe('echo builtin', () => {
  describe('basic output', () => {
    it('should output a single string with trailing newline', () => {
      expect(echo(['hello']).output).toBe('hello\n');
    });

    it('should join multiple args with spaces', () => {
      expect(echo(['hello', 'world']).output).toBe('hello world\n');
    });

    it('should output empty line with no args', () => {
      expect(echo([]).output).toBe('\n');
    });

    it('should always exit with code 0', () => {
      expect(echo(['test']).exitCode).toBe(0);
    });
  });

  describe('-n flag (no trailing newline)', () => {
    it('should suppress trailing newline with -n', () => {
      expect(echo(['-n', 'hello']).output).toBe('hello');
    });

    it('should output nothing with -n and no text', () => {
      expect(echo(['-n']).output).toBe('');
    });
  });

  describe('-e flag (enable escapes)', () => {
    it('should interpret \\n as newline', () => {
      expect(echo(['-e', 'line1\\nline2']).output).toBe('line1\nline2\n');
    });

    it('should interpret \\t as tab', () => {
      expect(echo(['-e', 'col1\\tcol2']).output).toBe('col1\tcol2\n');
    });

    it('should interpret \\\\ as literal backslash', () => {
      expect(echo(['-e', 'path\\\\to']).output).toBe('path\\to\n');
    });

    it('should interpret \\a as alert (bell)', () => {
      expect(echo(['-e', 'bell\\a']).output).toBe('bell\x07\n');
    });

    it('should interpret \\b as backspace', () => {
      expect(echo(['-e', 'ab\\bc']).output).toBe('ab\bc\n');
    });

    it('should interpret \\r as carriage return', () => {
      expect(echo(['-e', 'hello\\rworld']).output).toBe('hello\rworld\n');
    });

    it('should interpret \\0NNN as octal character', () => {
      // \\0101 = 'A' (octal 101 = decimal 65)
      expect(echo(['-e', '\\0101']).output).toBe('A\n');
    });

    it('should interpret \\xHH as hex character', () => {
      // \\x41 = 'A'
      expect(echo(['-e', '\\x41']).output).toBe('A\n');
    });

    it('should stop output at \\c', () => {
      expect(echo(['-e', 'hello\\cworld']).output).toBe('hello');
    });
  });

  describe('-E flag (disable escapes, default)', () => {
    it('should not interpret escape sequences by default', () => {
      expect(echo(['hello\\nworld']).output).toBe('hello\\nworld\n');
    });

    it('should not interpret escapes with -E', () => {
      expect(echo(['-E', 'hello\\nworld']).output).toBe('hello\\nworld\n');
    });
  });

  describe('combined flags', () => {
    it('should handle -ne (no newline + escapes)', () => {
      expect(echo(['-ne', 'hello\\nworld']).output).toBe('hello\nworld');
    });

    it('should handle -en (escapes + no newline)', () => {
      expect(echo(['-en', 'hello\\tworld']).output).toBe('hello\tworld');
    });

    it('should handle multiple separate flags', () => {
      expect(echo(['-n', '-e', 'hello\\n']).output).toBe('hello\n');
    });
  });

  describe('edge cases', () => {
    it('should treat non-flag dashes as text', () => {
      expect(echo(['-x', 'hello']).output).toBe('-x hello\n');
    });

    it('should treat -- as text (echo does not support --)', () => {
      expect(echo(['--', 'hello']).output).toBe('-- hello\n');
    });

    it('should output -n as text if it appears after non-flag arg', () => {
      expect(echo(['hello', '-n']).output).toBe('hello -n\n');
    });
  });
});
