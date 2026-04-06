/**
 * Tests for `set`, `shift`, and `type` builtins.
 */

import { describe, it, expect } from 'vitest';
import { executeBuiltin, isBuiltin } from '@/bash/runtime/Builtins';
import { Environment } from '@/bash/runtime/Environment';

function run(name: string, args: string[], vars: Record<string, string> = {}) {
  const env = new Environment({ variables: vars });
  const result = executeBuiltin(name, args, env, new Map());
  return { ...result, env };
}

describe('set builtin', () => {
  describe('display variables', () => {
    it('should list all variables with no args', () => {
      const result = run('set', [], { FOO: 'bar', BAZ: 'qux' });
      expect(result.output).toContain("FOO='bar'");
      expect(result.output).toContain("BAZ='qux'");
    });

    it('should sort output alphabetically', () => {
      const result = run('set', [], { ZZZ: '1', AAA: '2' });
      const lines = result.output.trim().split('\n');
      const zIdx = lines.findIndex(l => l.startsWith('ZZZ'));
      const aIdx = lines.findIndex(l => l.startsWith('AAA'));
      expect(aIdx).toBeLessThan(zIdx);
    });
  });

  describe('set -- (positional args)', () => {
    it('should reset positional args with set --', () => {
      const { env } = run('set', ['--', 'a', 'b', 'c']);
      const args = env.getPositionalArgs();
      expect(args).toEqual(['a', 'b', 'c']);
    });

    it('should clear positional args with set --', () => {
      const env = new Environment({ positionalArgs: ['old1', 'old2'] });
      executeBuiltin('set', ['--'], env, new Map());
      expect(env.getPositionalArgs()).toEqual([]);
    });
  });

  describe('shell options', () => {
    it('should enable -e option', () => {
      const { env } = run('set', ['-e']);
      expect(env.get('SHELLOPTS')).toContain('errexit');
    });

    it('should enable -u option', () => {
      const { env } = run('set', ['-u']);
      expect(env.get('SHELLOPTS')).toContain('nounset');
    });

    it('should enable -x option', () => {
      const { env } = run('set', ['-x']);
      expect(env.get('SHELLOPTS')).toContain('xtrace');
    });

    it('should disable option with +', () => {
      const env = new Environment({ variables: { SHELLOPTS: 'errexit:nounset' } });
      executeBuiltin('set', ['+e'], env, new Map());
      expect(env.get('SHELLOPTS')).not.toContain('errexit');
      expect(env.get('SHELLOPTS')).toContain('nounset');
    });

    it('should handle -o option-name', () => {
      const { env } = run('set', ['-o', 'errexit']);
      expect(env.get('SHELLOPTS')).toContain('errexit');
    });

    it('should handle +o option-name', () => {
      const env = new Environment({ variables: { SHELLOPTS: 'errexit' } });
      executeBuiltin('set', ['+o', 'errexit'], env, new Map());
      expect(env.get('SHELLOPTS')).not.toContain('errexit');
    });
  });
});

describe('shift builtin', () => {
  it('should shift positional args by 1', () => {
    const env = new Environment({ positionalArgs: ['a', 'b', 'c'] });
    const result = executeBuiltin('shift', [], env, new Map());
    expect(result.exitCode).toBe(0);
    expect(env.getPositionalArgs()).toEqual(['b', 'c']);
  });

  it('should shift by N', () => {
    const env = new Environment({ positionalArgs: ['a', 'b', 'c', 'd'] });
    executeBuiltin('shift', ['2'], env, new Map());
    expect(env.getPositionalArgs()).toEqual(['c', 'd']);
  });

  it('should error when shifting more than available', () => {
    const env = new Environment({ positionalArgs: ['a'] });
    const result = executeBuiltin('shift', ['5'], env, new Map());
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('shift count');
  });

  it('should handle shift 0', () => {
    const env = new Environment({ positionalArgs: ['a', 'b'] });
    executeBuiltin('shift', ['0'], env, new Map());
    expect(env.getPositionalArgs()).toEqual(['a', 'b']);
  });
});

describe('type builtin', () => {
  it('should identify shell builtins', () => {
    const result = run('type', ['echo']);
    expect(result.output).toContain('echo is a shell builtin');
  });

  it('should identify functions', () => {
    const fns = new Map();
    fns.set('myfunc', {} as any);
    const env = new Environment();
    const result = executeBuiltin('type', ['myfunc'], env, fns);
    expect(result.output).toContain('myfunc is a function');
  });

  it('should report not found for unknown commands', () => {
    const result = run('type', ['nonexistent']);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('not found');
  });

  it('should handle multiple arguments', () => {
    const result = run('type', ['echo', 'cd', 'nonexistent']);
    expect(result.output).toContain('echo is a shell builtin');
    expect(result.output).toContain('cd is a shell builtin');
    expect(result.output).toContain('not found');
    expect(result.exitCode).toBe(1);
  });
});
