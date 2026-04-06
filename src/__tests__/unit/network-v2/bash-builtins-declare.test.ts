/**
 * Tests for declare, readonly, local, and let builtins.
 */

import { describe, it, expect } from 'vitest';
import { executeBuiltin } from '@/bash/runtime/Builtins';
import { Environment } from '@/bash/runtime/Environment';

function run(name: string, args: string[], vars: Record<string, string> = {}) {
  const env = new Environment({ variables: vars });
  const result = executeBuiltin(name, args, env, new Map());
  return { ...result, env };
}

describe('declare builtin', () => {
  describe('basic variable declaration', () => {
    it('should declare a variable with value', () => {
      const { env } = run('declare', ['FOO=bar']);
      expect(env.get('FOO')).toBe('bar');
    });

    it('should declare multiple variables', () => {
      const { env } = run('declare', ['A=1', 'B=2']);
      expect(env.get('A')).toBe('1');
      expect(env.get('B')).toBe('2');
    });
  });

  describe('-r flag (readonly)', () => {
    it('should mark variable as readonly with -r', () => {
      const { env } = run('declare', ['-r', 'RO=val']);
      expect(env.get('RO')).toBe('val');
      expect(env.isReadonly('RO')).toBe(true);
    });

    it('should error when setting readonly variable', () => {
      const env = new Environment({ variables: { RO: 'old' } });
      env.setReadonly('RO');
      const result = executeBuiltin('declare', ['RO=new'], env, new Map());
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('readonly variable');
    });
  });

  describe('-x flag (export)', () => {
    it('should export variable with -x', () => {
      const { env } = run('declare', ['-x', 'EXP=val']);
      expect(env.get('EXP')).toBe('val');
      expect(env.getExported()).toHaveProperty('EXP', 'val');
    });
  });

  describe('-p flag (print)', () => {
    it('should print variable declaration with -p', () => {
      const env = new Environment({ variables: { FOO: 'bar' } });
      const result = executeBuiltin('declare', ['-p', 'FOO'], env, new Map());
      expect(result.output).toContain('declare');
      expect(result.output).toContain('FOO');
      expect(result.output).toContain('bar');
    });

    it('should error when -p variable not found', () => {
      const result = run('declare', ['-p', 'NONEXISTENT']);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('not found');
    });
  });

  describe('invalid identifier', () => {
    it('should error on invalid identifier', () => {
      const result = run('declare', ['123=bad']);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('not a valid identifier');
    });
  });
});

describe('readonly builtin', () => {
  it('should mark variable as readonly', () => {
    const { env } = run('readonly', ['VAR=value']);
    expect(env.get('VAR')).toBe('value');
    expect(env.isReadonly('VAR')).toBe(true);
  });

  it('should list readonly variables with -p', () => {
    const env = new Environment({ variables: { A: '1', B: '2' } });
    env.setReadonly('A');
    const result = executeBuiltin('readonly', ['-p'], env, new Map());
    expect(result.output).toContain('declare -r A="1"');
    expect(result.output).not.toContain('B=');
  });

  it('should mark existing variable as readonly', () => {
    const { env } = run('readonly', ['VAR'], { VAR: 'existing' });
    expect(env.isReadonly('VAR')).toBe(true);
  });
});

describe('local builtin', () => {
  it('should set a local variable', () => {
    const { env } = run('local', ['VAR=value']);
    expect(env.get('VAR')).toBe('value');
  });

  it('should initialize unset variable to empty', () => {
    const { env } = run('local', ['NEWVAR']);
    expect(env.get('NEWVAR')).toBe('');
  });

  it('should error on readonly variable', () => {
    const env = new Environment({ variables: { RO: 'val' } });
    env.setReadonly('RO');
    const result = executeBuiltin('local', ['RO=new'], env, new Map());
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('readonly variable');
  });
});

describe('let builtin', () => {
  it('should evaluate arithmetic expression', () => {
    const { env } = run('let', ['x=5+3']);
    expect(env.get('x')).toBe('8');
  });

  it('should return 0 when result is non-zero', () => {
    const result = run('let', ['1+1']);
    expect(result.exitCode).toBe(0);
  });

  it('should return 1 when result is zero', () => {
    const result = run('let', ['0']);
    expect(result.exitCode).toBe(1);
  });

  it('should handle multiple expressions', () => {
    const { env } = run('let', ['a=2', 'b=a+3']);
    expect(env.get('a')).toBe('2');
    expect(env.get('b')).toBe('5');
  });

  it('should error with no arguments', () => {
    const result = run('let', []);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('expression expected');
  });
});
