/**
 * sanitizeFilename — terminal_gap.md §4.2
 *
 * Asserts that device-name driven download filenames are always safe to
 * pass to <a download="…">.
 */

import { describe, it, expect } from 'vitest';
import { sanitizeFilename } from '@/lib/sanitizeFilename';

describe('sanitizeFilename', () => {
  it('keeps alphanumerics and dot/dash/underscore', () => {
    expect(sanitizeFilename('pc-1.local_2')).toBe('pc-1.local_2');
  });

  it('replaces spaces with a single underscore', () => {
    expect(sanitizeFilename('my   server')).toBe('my_server');
  });

  it('replaces path separators with underscores', () => {
    expect(sanitizeFilename('foo/bar\\baz')).toBe('foo_bar_baz');
  });

  it('neutralises path traversal segments', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('etc_passwd');
  });

  it('strips control characters including NUL', () => {
    expect(sanitizeFilename('host\x00x\x01y')).toBe('host_x_y');
  });

  it('collapses repeated unsafe runs to single underscore', () => {
    expect(sanitizeFilename('a!!!@@@b')).toBe('a_b');
  });

  it('caps the result at 64 characters', () => {
    const out = sanitizeFilename('x'.repeat(200));
    expect(out.length).toBe(64);
  });

  it('returns the fallback for empty input', () => {
    expect(sanitizeFilename('', 'rec')).toBe('rec');
  });

  it('returns the fallback for input that is entirely unsafe chars', () => {
    expect(sanitizeFilename('///___...', 'rec')).toBe('rec');
  });

  it('coerces non-string input safely', () => {
    expect(sanitizeFilename(null as unknown as string, 'fallback')).toBe('fallback');
    expect(sanitizeFilename(undefined as unknown as string, 'fallback')).toBe('fallback');
  });
});
