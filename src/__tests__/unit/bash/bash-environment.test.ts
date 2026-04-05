/**
 * Tests for Environment — variable scope management.
 */

import { describe, it, expect } from 'vitest';
import { Environment } from '@/bash/runtime/Environment';

describe('Environment — Basic Variables', () => {
  it('sets and gets a variable', () => {
    const env = new Environment();
    env.set('FOO', 'bar');
    expect(env.get('FOO')).toBe('bar');
  });

  it('returns undefined for unset variable', () => {
    const env = new Environment();
    expect(env.get('UNSET')).toBeUndefined();
  });

  it('overwrites existing variable', () => {
    const env = new Environment();
    env.set('X', '1');
    env.set('X', '2');
    expect(env.get('X')).toBe('2');
  });

  it('unsets a variable', () => {
    const env = new Environment();
    env.set('X', '1');
    env.unset('X');
    expect(env.get('X')).toBeUndefined();
  });

  it('checks if variable is set', () => {
    const env = new Environment();
    env.set('X', '');
    expect(env.isSet('X')).toBe(true);
    expect(env.isSet('Y')).toBe(false);
  });

  it('accepts initial variables via options', () => {
    const env = new Environment({ variables: { PATH: '/usr/bin', HOME: '/root' } });
    expect(env.get('PATH')).toBe('/usr/bin');
    expect(env.get('HOME')).toBe('/root');
  });
});

describe('Environment — Special Variables', () => {
  it('returns exit code for $?', () => {
    const env = new Environment();
    env.lastExitCode = 42;
    expect(env.get('?')).toBe('42');
  });

  it('returns PID for $$', () => {
    const env = new Environment();
    const pid = env.get('$');
    expect(pid).toBeDefined();
    expect(parseInt(pid!)).toBeGreaterThanOrEqual(1000);
  });
});

describe('Environment — Positional Parameters', () => {
  it('sets positional args from constructor', () => {
    const env = new Environment({ positionalArgs: ['a', 'b', 'c'] });
    expect(env.get('1')).toBe('a');
    expect(env.get('2')).toBe('b');
    expect(env.get('3')).toBe('c');
    expect(env.get('#')).toBe('3');
    expect(env.get('@')).toBe('a b c');
  });

  it('updates positional args', () => {
    const env = new Environment({ positionalArgs: ['a', 'b'] });
    env.setPositionalArgs(['x', 'y', 'z']);
    expect(env.get('1')).toBe('x');
    expect(env.get('2')).toBe('y');
    expect(env.get('3')).toBe('z');
    expect(env.get('#')).toBe('3');
  });

  it('returns positional args as array', () => {
    const env = new Environment({ positionalArgs: ['a', 'b'] });
    expect(env.getPositionalArgs()).toEqual(['a', 'b']);
  });

  it('sets $0 from scriptName', () => {
    const env = new Environment({ scriptName: '/tmp/test.sh' });
    expect(env.get('0')).toBe('/tmp/test.sh');
  });
});

describe('Environment — Scope Chain', () => {
  it('creates child scope that inherits parent variables', () => {
    const parent = new Environment({ variables: { X: '1' } });
    const child = parent.createChild();
    expect(child.get('X')).toBe('1');
  });

  it('child variables shadow parent', () => {
    const parent = new Environment({ variables: { X: '1' } });
    const child = parent.createChild();
    child.set('X', '2');
    expect(child.get('X')).toBe('2');
    expect(parent.get('X')).toBe('1');
  });

  it('child can set new variables without affecting parent', () => {
    const parent = new Environment();
    const child = parent.createChild();
    child.set('NEW', 'val');
    expect(child.get('NEW')).toBe('val');
    expect(parent.get('NEW')).toBeUndefined();
  });
});

describe('Environment — Export', () => {
  it('exports a variable', () => {
    const env = new Environment();
    env.export('PATH', '/usr/bin');
    const exported = env.getExported();
    expect(exported['PATH']).toBe('/usr/bin');
  });

  it('exports existing variable without value', () => {
    const env = new Environment();
    env.set('X', '1');
    env.export('X');
    expect(env.getExported()['X']).toBe('1');
  });

  it('child inherits parent exports', () => {
    const parent = new Environment();
    parent.export('PATH', '/usr/bin');
    const child = parent.createChild();
    const exported = child.getExported();
    expect(exported['PATH']).toBe('/usr/bin');
  });
});
