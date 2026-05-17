/**
 * Result<T,E> monad — used everywhere in the RMAN module instead of
 * throwing exceptions. Errors flow as typed values, results stay
 * composable.
 */

import { describe, it, expect } from 'vitest';
import { ok, err, type Result } from '@/terminal/subshells/rman/core/Result';
import { rmanErrorMessage, type RmanError } from '@/terminal/subshells/rman/core/RmanError';

describe('Result<T,E>', () => {
  it('ok(value) is a discriminated success', () => {
    const r: Result<number, string> = ok(42);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(42);
  });

  it('err(e) is a discriminated failure', () => {
    const r: Result<number, string> = err('boom');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('boom');
  });

  it('TypeScript narrows after the ok check', () => {
    const r: Result<number, string> = Math.random() > -1 ? ok(1) : err('x');
    if (r.ok) {
      const n: number = r.value;
      expect(n).toBe(1);
    }
  });
});

describe('RmanError', () => {
  it('formats with rmanErrorMessage(e)', () => {
    // Oracle convention: hyphen in the printed code, even though the
    // discriminant union uses underscores so TypeScript can narrow.
    const e: RmanError = { code: 'RMAN_01009', message: 'unknown command' };
    expect(rmanErrorMessage(e)).toBe('RMAN-01009: unknown command');
  });

  it('extra fields are preserved on the value', () => {
    const e: RmanError = { code: 'BACKUP_KEY_NOT_FOUND', message: 'no piece', key: 'BS:1/BP:2' };
    expect(e.code).toBe('BACKUP_KEY_NOT_FOUND');
    expect(e.key).toBe('BS:1/BP:2');
  });
});
