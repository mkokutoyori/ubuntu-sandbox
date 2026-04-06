/**
 * Tests for the `cd` builtin — error messages and edge cases.
 *
 * Covers:
 * - cd with no args → uses HOME
 * - cd with no args and HOME not set → error
 * - cd - → uses OLDPWD, prints new directory
 * - cd - with OLDPWD not set → error
 * - cd with too many arguments → error
 * - cd to nonexistent directory → error (with VFS)
 * - cd to a file → error (with VFS)
 * - cd ~ → HOME
 * - cd ~/subdir → HOME/subdir
 * - cd .. → parent directory
 * - cd . → same directory
 * - cd with relative path
 */

import { describe, it, expect } from 'vitest';
import { executeBuiltin, isBuiltin, type BuiltinIO } from '@/bash/runtime/Builtins';
import { Environment } from '@/bash/runtime/Environment';

function makeEnv(vars: Record<string, string> = {}): Environment {
  return new Environment({ variables: vars });
}

function makeIO(entries: Record<string, 'file' | 'directory'>): BuiltinIO {
  return {
    resolvePath(path: string) { return path; },
    stat(path: string) {
      const type = entries[path];
      if (!type) return null;
      return { type };
    },
  };
}

const noFunctions = new Map();

describe('cd builtin', () => {
  it('should be recognized as a builtin', () => {
    expect(isBuiltin('cd')).toBe(true);
  });

  describe('basic navigation', () => {
    it('should cd to an absolute path', () => {
      const env = makeEnv({ PWD: '/home/user', HOME: '/home/user' });
      const io = makeIO({ '/etc': 'directory' });
      const result = executeBuiltin('cd', ['/etc'], env, noFunctions, io);
      expect(result.exitCode).toBe(0);
      expect(result.output).toBe('');
      expect(env.get('PWD')).toBe('/etc');
      expect(env.get('OLDPWD')).toBe('/home/user');
    });

    it('should cd to a relative path', () => {
      const env = makeEnv({ PWD: '/home/user', HOME: '/home/user' });
      const io = makeIO({ '/home/user/Documents': 'directory' });
      const result = executeBuiltin('cd', ['Documents'], env, noFunctions, io);
      expect(result.exitCode).toBe(0);
      expect(env.get('PWD')).toBe('/home/user/Documents');
    });

    it('should cd .. to parent directory', () => {
      const env = makeEnv({ PWD: '/home/user/Documents', HOME: '/home/user' });
      const io = makeIO({ '/home/user': 'directory' });
      const result = executeBuiltin('cd', ['..'], env, noFunctions, io);
      expect(result.exitCode).toBe(0);
      expect(env.get('PWD')).toBe('/home/user');
    });

    it('should cd . to stay in current directory', () => {
      const env = makeEnv({ PWD: '/home/user', HOME: '/home/user' });
      const io = makeIO({ '/home/user': 'directory' });
      const result = executeBuiltin('cd', ['.'], env, noFunctions, io);
      expect(result.exitCode).toBe(0);
      expect(env.get('PWD')).toBe('/home/user');
    });

    it('should cd from root with ..', () => {
      const env = makeEnv({ PWD: '/', HOME: '/root' });
      const io = makeIO({ '/': 'directory' });
      const result = executeBuiltin('cd', ['..'], env, noFunctions, io);
      expect(result.exitCode).toBe(0);
      expect(env.get('PWD')).toBe('/');
    });
  });

  describe('HOME handling', () => {
    it('should cd to HOME when no args given', () => {
      const env = makeEnv({ PWD: '/tmp', HOME: '/home/user' });
      const io = makeIO({ '/home/user': 'directory' });
      const result = executeBuiltin('cd', [], env, noFunctions, io);
      expect(result.exitCode).toBe(0);
      expect(env.get('PWD')).toBe('/home/user');
    });

    it('should error when HOME not set and no args', () => {
      const env = makeEnv({ PWD: '/tmp' });
      const result = executeBuiltin('cd', [], env, noFunctions);
      expect(result.exitCode).toBe(1);
      expect(result.output).toBe('bash: cd: HOME not set\n');
    });

    it('should cd ~ to HOME', () => {
      const env = makeEnv({ PWD: '/tmp', HOME: '/home/user' });
      const io = makeIO({ '/home/user': 'directory' });
      const result = executeBuiltin('cd', ['~'], env, noFunctions, io);
      expect(result.exitCode).toBe(0);
      expect(env.get('PWD')).toBe('/home/user');
    });

    it('should cd ~/subdir to HOME/subdir', () => {
      const env = makeEnv({ PWD: '/tmp', HOME: '/home/user' });
      const io = makeIO({ '/home/user/subdir': 'directory' });
      const result = executeBuiltin('cd', ['~/subdir'], env, noFunctions, io);
      expect(result.exitCode).toBe(0);
      expect(env.get('PWD')).toBe('/home/user/subdir');
    });
  });

  describe('OLDPWD and cd -', () => {
    it('should cd - to OLDPWD and print new directory', () => {
      const env = makeEnv({ PWD: '/home/user', HOME: '/home/user', OLDPWD: '/tmp' });
      const io = makeIO({ '/tmp': 'directory' });
      const result = executeBuiltin('cd', ['-'], env, noFunctions, io);
      expect(result.exitCode).toBe(0);
      expect(env.get('PWD')).toBe('/tmp');
      expect(result.output).toBe('/tmp\n');
    });

    it('should error when cd - with OLDPWD not set', () => {
      const env = makeEnv({ PWD: '/home/user', HOME: '/home/user' });
      const result = executeBuiltin('cd', ['-'], env, noFunctions);
      expect(result.exitCode).toBe(1);
      expect(result.output).toBe('bash: cd: OLDPWD not set\n');
    });

    it('should set OLDPWD after cd', () => {
      const env = makeEnv({ PWD: '/home/user', HOME: '/home/user' });
      const io = makeIO({ '/tmp': 'directory' });
      executeBuiltin('cd', ['/tmp'], env, noFunctions, io);
      expect(env.get('OLDPWD')).toBe('/home/user');
    });
  });

  describe('error messages', () => {
    it('should error with too many arguments', () => {
      const env = makeEnv({ PWD: '/home/user', HOME: '/home/user' });
      const result = executeBuiltin('cd', ['/tmp', '/var'], env, noFunctions);
      expect(result.exitCode).toBe(1);
      expect(result.output).toBe('bash: cd: too many arguments\n');
    });

    it('should error when target does not exist (with VFS)', () => {
      const env = makeEnv({ PWD: '/home/user', HOME: '/home/user' });
      const io = makeIO({}); // empty filesystem
      const result = executeBuiltin('cd', ['/nonexistent'], env, noFunctions, io);
      expect(result.exitCode).toBe(1);
      expect(result.output).toBe('bash: cd: /nonexistent: No such file or directory\n');
    });

    it('should error when target is a file not a directory (with VFS)', () => {
      const env = makeEnv({ PWD: '/home/user', HOME: '/home/user' });
      const io = makeIO({ '/etc/passwd': 'file' });
      const result = executeBuiltin('cd', ['/etc/passwd'], env, noFunctions, io);
      expect(result.exitCode).toBe(1);
      expect(result.output).toBe('bash: cd: /etc/passwd: Not a directory\n');
    });

    it('should not change PWD when cd fails', () => {
      const env = makeEnv({ PWD: '/home/user', HOME: '/home/user' });
      const io = makeIO({});
      executeBuiltin('cd', ['/nonexistent'], env, noFunctions, io);
      expect(env.get('PWD')).toBe('/home/user');
    });

    it('should not change OLDPWD when cd fails', () => {
      const env = makeEnv({ PWD: '/home/user', HOME: '/home/user', OLDPWD: '/tmp' });
      const io = makeIO({});
      executeBuiltin('cd', ['/nonexistent'], env, noFunctions, io);
      expect(env.get('OLDPWD')).toBe('/tmp');
    });
  });
});
