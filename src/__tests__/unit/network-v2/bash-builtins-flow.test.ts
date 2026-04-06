/**
 * Tests for flow control builtins: exit, return, break, continue.
 */

import { describe, it, expect } from 'vitest';
import { executeBuiltin } from '@/bash/runtime/Builtins';
import { Environment } from '@/bash/runtime/Environment';
import { ExitSignal, ReturnSignal, BreakSignal, ContinueSignal } from '@/bash/errors/BashError';

function run(name: string, args: string[]) {
  const env = new Environment();
  return executeBuiltin(name, args, env, new Map());
}

function catchSignal(name: string, args: string[]): unknown {
  try { run(name, args); return null; } catch (e) { return e; }
}

describe('exit builtin', () => {
  it('should throw ExitSignal with exitCode 0 by default', () => {
    const e = catchSignal('exit', []);
    expect(e).toBeInstanceOf(ExitSignal);
    expect((e as ExitSignal).exitCode).toBe(0);
  });

  it('should throw ExitSignal with specified exitCode', () => {
    const e = catchSignal('exit', ['42']);
    expect(e).toBeInstanceOf(ExitSignal);
    expect((e as ExitSignal).exitCode).toBe(42);
  });

  it('should exit with code 2 for non-numeric argument', () => {
    const e = catchSignal('exit', ['abc']);
    expect(e).toBeInstanceOf(ExitSignal);
    expect((e as ExitSignal).exitCode).toBe(2);
  });

  it('should handle negative exit codes', () => {
    const e = catchSignal('exit', ['-1']);
    expect(e).toBeInstanceOf(ExitSignal);
    expect((e as ExitSignal).exitCode).toBe(-1);
  });
});

describe('return builtin', () => {
  it('should throw ReturnSignal with exitCode 0 by default', () => {
    const e = catchSignal('return', []);
    expect(e).toBeInstanceOf(ReturnSignal);
    expect((e as ReturnSignal).exitCode).toBe(0);
  });

  it('should throw ReturnSignal with specified exitCode', () => {
    const e = catchSignal('return', ['1']);
    expect(e).toBeInstanceOf(ReturnSignal);
    expect((e as ReturnSignal).exitCode).toBe(1);
  });

  it('should return with code 2 for non-numeric argument', () => {
    const e = catchSignal('return', ['abc']);
    expect(e).toBeInstanceOf(ReturnSignal);
    expect((e as ReturnSignal).exitCode).toBe(2);
  });
});

describe('break builtin', () => {
  it('should throw BreakSignal with level 1 by default', () => {
    const e = catchSignal('break', []);
    expect(e).toBeInstanceOf(BreakSignal);
    expect((e as BreakSignal).levels).toBe(1);
  });

  it('should throw BreakSignal with specified levels', () => {
    const e = catchSignal('break', ['3']);
    expect(e).toBeInstanceOf(BreakSignal);
    expect((e as BreakSignal).levels).toBe(3);
  });

  it('should error with non-numeric argument', () => {
    const result = run('break', ['abc']);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('numeric argument required');
  });

  it('should error with 0 or negative', () => {
    const result = run('break', ['0']);
    expect(result.exitCode).toBe(1);
  });
});

describe('continue builtin', () => {
  it('should throw ContinueSignal with level 1 by default', () => {
    const e = catchSignal('continue', []);
    expect(e).toBeInstanceOf(ContinueSignal);
    expect((e as ContinueSignal).levels).toBe(1);
  });

  it('should throw ContinueSignal with specified levels', () => {
    const e = catchSignal('continue', ['2']);
    expect(e).toBeInstanceOf(ContinueSignal);
    expect((e as ContinueSignal).levels).toBe(2);
  });

  it('should error with non-numeric argument', () => {
    const result = run('continue', ['abc']);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('numeric argument required');
  });

  it('should error with 0 or negative', () => {
    const result = run('continue', ['0']);
    expect(result.exitCode).toBe(1);
  });
});
