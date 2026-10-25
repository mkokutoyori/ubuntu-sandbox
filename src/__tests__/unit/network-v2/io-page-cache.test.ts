/**
 * Probe - IoPageCache, the page cache that decides what getrusage counts as ru_inblock and ru_oublock: a miss reads the page and the
 * 128 KiB read-ahead window that follows it from a cold disk (8 sectors per 4 KiB page, no more than the file holds), a hit costs
 * nothing, a write dirties each page it touches (8 sectors the first time, nothing while the page stays dirty, again once the
 * kernel has written it back 30 s later), a partial write to a page that is not cached but already holds data first reads it, a
 * write that covers a whole page or goes past the end of the file reads nothing, and a flush makes the next write count again.
 * Measured before the class existed (git stash push -- src/network): the file is untracked-new, so every case fails at import.
 */
import { describe, expect, it } from 'vitest';
import { IoPageCache } from '@/network/devices/linux/process/IoPageCache';

describe('IoPageCache', () => {
  it('reads a cold page with the read-ahead window and serves the next pages from the cache', () => {
    const cache = new IoPageCache();
    expect(cache.read(7, 0, 100, 1_000_000)).toBe(32 * 8);
    expect(cache.read(7, 4096, 100, 1_000_000)).toBe(0);
    expect(cache.read(7, 32 * 4096, 100, 1_000_000)).toBe(32 * 8);
  });

  it('reads no more than the file holds', () => {
    const cache = new IoPageCache();
    expect(cache.read(8, 0, 10, 100)).toBe(8);
    expect(cache.read(8, 500, 10, 100)).toBe(0);
  });

  it('counts a dirtied page once while it stays dirty and again after the writeback delay', () => {
    const cache = new IoPageCache();
    expect(cache.write(9, 0, 10, 0, 1_000).written).toBe(8);
    expect(cache.write(9, 10, 10, 10, 2_000).written).toBe(0);
    expect(cache.write(9, 20, 10, 20, 31_000).written).toBe(8);
  });

  it('counts every page a write touches', () => {
    const cache = new IoPageCache();
    expect(cache.write(10, 4090, 20, 4090, 0).written).toBe(16);
  });

  it('reads a partly overwritten page that already holds data, but not a page it covers or a page past the end', () => {
    const cache = new IoPageCache();
    expect(cache.write(11, 100, 10, 8192, 0).read).toBe(8);
    expect(cache.write(12, 0, 4096, 8192, 0).read).toBe(0);
    expect(cache.write(13, 8192, 10, 8192, 0).read).toBe(0);
  });

  it('counts a page again after a flush', () => {
    const cache = new IoPageCache();
    cache.write(14, 0, 10, 0, 0);
    cache.flush(14);
    expect(cache.write(14, 10, 10, 10, 1).written).toBe(8);
  });

  it('treats a page another process wrote as cached', () => {
    const cache = new IoPageCache();
    cache.warm(15, 5000);
    expect(cache.read(15, 0, 5000, 5000)).toBe(0);
  });
});
