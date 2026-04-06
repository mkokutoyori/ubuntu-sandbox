/**
 * Tests for the `printf` builtin — format specifiers, escapes, edge cases.
 */

import { describe, it, expect } from 'vitest';
import { executeBuiltin } from '@/bash/runtime/Builtins';
import { Environment } from '@/bash/runtime/Environment';

function printf(args: string[], vars: Record<string, string> = {}) {
  const env = new Environment({ variables: vars });
  const result = executeBuiltin('printf', args, env, new Map());
  return { ...result, env };
}

describe('printf builtin', () => {
  describe('basic format specifiers', () => {
    it('should handle %s (string)', () => {
      expect(printf(['%s', 'hello']).output).toBe('hello');
    });

    it('should handle %d (integer)', () => {
      expect(printf(['%d', '42']).output).toBe('42');
    });

    it('should handle %d with non-numeric → 0', () => {
      expect(printf(['%d', 'abc']).output).toBe('0');
    });

    it('should handle %f (float)', () => {
      const result = printf(['%f', '3.14']).output;
      expect(result).toMatch(/^3\.14/);
    });

    it('should handle %x (hex lowercase)', () => {
      expect(printf(['%x', '255']).output).toBe('ff');
    });

    it('should handle %X (hex uppercase)', () => {
      expect(printf(['%X', '255']).output).toBe('FF');
    });

    it('should handle %o (octal)', () => {
      expect(printf(['%o', '8']).output).toBe('10');
    });

    it('should handle %c (first character)', () => {
      expect(printf(['%c', 'hello']).output).toBe('h');
    });

    it('should handle %% (literal percent)', () => {
      expect(printf(['%%']).output).toBe('%');
    });
  });

  describe('escape sequences in format string', () => {
    it('should handle \\n (newline)', () => {
      expect(printf(['hello\\n']).output).toBe('hello\n');
    });

    it('should handle \\t (tab)', () => {
      expect(printf(['col1\\tcol2']).output).toBe('col1\tcol2');
    });

    it('should handle \\\\ (literal backslash)', () => {
      expect(printf(['path\\\\to']).output).toBe('path\\to');
    });

    it('should handle \\a (bell)', () => {
      expect(printf(['bell\\a']).output).toBe('bell\x07');
    });

    it('should handle \\r (carriage return)', () => {
      expect(printf(['hello\\rworld']).output).toBe('hello\rworld');
    });
  });

  describe('width and precision', () => {
    it('should right-align string with width', () => {
      expect(printf(['%10s', 'hi']).output).toBe('        hi');
    });

    it('should left-align string with -width', () => {
      expect(printf(['%-10s', 'hi']).output).toBe('hi        ');
    });

    it('should zero-pad integer', () => {
      expect(printf(['%05d', '42']).output).toBe('00042');
    });

    it('should handle float precision', () => {
      expect(printf(['%.2f', '3.14159']).output).toBe('3.14');
    });
  });

  describe('format reuse', () => {
    it('should reuse format for extra arguments', () => {
      expect(printf(['%s\n', 'a', 'b', 'c']).output).toBe('a\nb\nc\n');
    });

    it('should reuse format with %d', () => {
      expect(printf(['%d ', '1', '2', '3']).output).toBe('1 2 3 ');
    });
  });

  describe('-v flag', () => {
    it('should assign output to variable with -v', () => {
      const { env } = printf(['-v', 'result', 'Hello %s', 'World']);
      expect(env.get('result')).toBe('Hello World');
    });

    it('should produce no stdout with -v', () => {
      const { output } = printf(['-v', 'result', 'test']);
      expect(output).toBe('');
    });
  });

  describe('error handling', () => {
    it('should error with no arguments', () => {
      const result = printf([]);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('usage');
    });

    it('should handle missing format argument gracefully', () => {
      // printf '%s %s' with only one arg → second %s is empty
      expect(printf(['%s %s', 'hello']).output).toBe('hello ');
    });
  });

  describe('multiple format specifiers', () => {
    it('should handle multiple specifiers in one format', () => {
      expect(printf(['Name: %s, Age: %d', 'Alice', '30']).output).toBe('Name: Alice, Age: 30');
    });
  });
});
