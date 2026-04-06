/**
 * Tests for the `export` builtin — flags, error messages, edge cases.
 */

import { describe, it, expect } from 'vitest';
import { executeBuiltin } from '@/bash/runtime/Builtins';
import { Environment } from '@/bash/runtime/Environment';

function run(name: string, args: string[], vars: Record<string, string> = {}) {
  const env = new Environment({ variables: vars });
  const result = executeBuiltin(name, args, env, new Map());
  return { ...result, env };
}

describe('export builtin', () => {
  describe('basic export', () => {
    it('should export a variable with value', () => {
      const { env } = run('export', ['FOO=bar']);
      expect(env.get('FOO')).toBe('bar');
      expect(env.getExported()).toHaveProperty('FOO', 'bar');
    });

    it('should export an existing variable by name', () => {
      const { env } = run('export', ['FOO'], { FOO: 'bar' });
      expect(env.getExported()).toHaveProperty('FOO', 'bar');
    });

    it('should export multiple variables', () => {
      const { env } = run('export', ['A=1', 'B=2']);
      expect(env.get('A')).toBe('1');
      expect(env.get('B')).toBe('2');
    });

    it('should export with empty value', () => {
      const { env } = run('export', ['EMPTY=']);
      expect(env.get('EMPTY')).toBe('');
      expect(env.getExported()).toHaveProperty('EMPTY', '');
    });
  });

  describe('-p flag (list exports)', () => {
    it('should list exported variables with -p', () => {
      const env = new Environment({ variables: { FOO: 'bar', BAZ: 'qux' } });
      env.export('FOO');
      const result = executeBuiltin('export', ['-p'], env, new Map());
      expect(result.output).toContain('declare -x FOO="bar"');
    });

    it('should list exports with no args', () => {
      const env = new Environment({ variables: { X: '1' } });
      env.export('X');
      // export with no args should behave like export -p in bash
      const result = executeBuiltin('export', [], env, new Map());
      expect(result.exitCode).toBe(0);
    });
  });

  describe('-n flag (remove export)', () => {
    it('should remove export attribute with -n', () => {
      const env = new Environment({ variables: { FOO: 'bar' } });
      env.export('FOO');
      expect(env.getExported()).toHaveProperty('FOO');
      executeBuiltin('export', ['-n', 'FOO'], env, new Map());
      expect(env.getExported()).not.toHaveProperty('FOO');
      // Variable should still exist
      expect(env.get('FOO')).toBe('bar');
    });
  });

  describe('error handling', () => {
    it('should error on invalid identifier', () => {
      const result = run('export', ['123=bad']);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('not a valid identifier');
    });

    it('should error on readonly variable assignment', () => {
      const env = new Environment({ variables: { RO: 'val' } });
      env.setReadonly('RO');
      const result = executeBuiltin('export', ['RO=new'], env, new Map());
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('readonly variable');
    });
  });
});

describe('unset builtin', () => {
  it('should unset a variable', () => {
    const { env } = run('unset', ['FOO'], { FOO: 'bar' });
    expect(env.get('FOO')).toBeUndefined();
  });

  it('should handle unsetting non-existent variable silently', () => {
    const result = run('unset', ['NONEXISTENT']);
    expect(result.exitCode).toBe(0);
  });

  it('should error on readonly variable', () => {
    const env = new Environment({ variables: { RO: 'val' } });
    env.setReadonly('RO');
    const result = executeBuiltin('unset', ['RO'], env, new Map());
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('readonly variable');
  });

  it('should support -v flag for variables', () => {
    const { env } = run('unset', ['-v', 'FOO'], { FOO: 'bar' });
    expect(env.get('FOO')).toBeUndefined();
  });

  it('should support -f flag for functions (no-op if not a function)', () => {
    const result = run('unset', ['-f', 'myfunc']);
    expect(result.exitCode).toBe(0);
  });
});
