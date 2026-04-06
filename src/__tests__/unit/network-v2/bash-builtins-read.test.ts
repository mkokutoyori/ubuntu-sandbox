/**
 * Tests for the `read` builtin — stdin parsing, flags, variable splitting.
 */

import { describe, it, expect } from 'vitest';
import { executeBuiltin } from '@/bash/runtime/Builtins';
import { Environment } from '@/bash/runtime/Environment';

function read(args: string[], stdin?: string, vars: Record<string, string> = {}) {
  const env = new Environment({ variables: vars });
  const result = executeBuiltin('read', args, env, new Map(), undefined, stdin);
  return { ...result, env };
}

describe('read builtin', () => {
  describe('basic reading', () => {
    it('should read a line into REPLY when no variable given', () => {
      const { env } = read([], 'hello world\n');
      expect(env.get('REPLY')).toBe('hello world');
    });

    it('should read a line into named variable', () => {
      const { env } = read(['myvar'], 'hello\n');
      expect(env.get('myvar')).toBe('hello');
    });

    it('should return exit code 0 on successful read', () => {
      const result = read(['var'], 'data\n');
      expect(result.exitCode).toBe(0);
    });

    it('should return exit code 1 on EOF (no input)', () => {
      const result = read(['var']);
      expect(result.exitCode).toBe(1);
    });
  });

  describe('variable splitting', () => {
    it('should split input into multiple variables', () => {
      const { env } = read(['first', 'second', 'third'], 'a b c\n');
      expect(env.get('first')).toBe('a');
      expect(env.get('second')).toBe('b');
      expect(env.get('third')).toBe('c');
    });

    it('should assign remainder to last variable', () => {
      const { env } = read(['first', 'rest'], 'a b c d\n');
      expect(env.get('first')).toBe('a');
      expect(env.get('rest')).toBe('b c d');
    });

    it('should set empty for extra variables', () => {
      const { env } = read(['a', 'b', 'c'], 'only_one\n');
      expect(env.get('a')).toBe('only_one');
      expect(env.get('b')).toBe('');
      expect(env.get('c')).toBe('');
    });
  });

  describe('-p flag (prompt)', () => {
    it('should output prompt text', () => {
      const result = read(['-p', 'Enter name: ', 'name'], 'Alice\n');
      expect(result.output).toBe('Enter name: ');
      expect(result.env.get('name')).toBe('Alice');
    });
  });

  describe('-r flag (raw mode)', () => {
    it('should not interpret backslash escapes with -r', () => {
      const { env } = read(['-r', 'line'], 'path\\to\\file\n');
      expect(env.get('line')).toBe('path\\to\\file');
    });

    it('should interpret backslash escapes without -r', () => {
      const { env } = read(['line'], 'path\\to\\file\n');
      expect(env.get('line')).toBe('pathtofile');
    });
  });

  describe('edge cases', () => {
    it('should handle input without trailing newline', () => {
      const { env } = read(['var'], 'no newline');
      expect(env.get('var')).toBe('no newline');
    });

    it('should only read first line from multi-line input', () => {
      const { env } = read(['var'], 'first\nsecond\nthird\n');
      expect(env.get('var')).toBe('first');
    });

    it('should handle empty input line', () => {
      const { env } = read(['var'], '\n');
      expect(env.get('var')).toBe('');
    });
  });
});
