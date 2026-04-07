/**
 * Tests for grep command — flags, error messages, edge cases.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { cmdGrep } from '@/network/devices/linux/LinuxTextCommands';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import type { ShellContext } from '@/network/devices/linux/LinuxFileCommands';

let vfs: VirtualFileSystem;
let ctx: ShellContext;

function makeCtx(): ShellContext {
  return {
    vfs,
    cwd: '/home/user',
    uid: 1000,
    gid: 1000,
    umask: 0o022,
    userMgr: {
      currentUser: 'user',
      currentUid: 1000,
      currentGid: 1000,
    } as any,
  };
}

beforeEach(() => {
  vfs = new VirtualFileSystem();
  // Create test files
  vfs.writeFile('/home/user/test.txt',
    'Hello World\napple pie\nBanana split\ncherry jam\napple sauce\n',
    1000, 1000, 0o022);
  vfs.writeFile('/home/user/data.csv',
    'name,age,city\nAlice,30,Paris\nBob,25,London\nCharlie,35,Paris\n',
    1000, 1000, 0o022);
  vfs.writeFile('/home/user/empty.txt', '', 1000, 1000, 0o022);
  ctx = makeCtx();
});

describe('grep command', () => {
  describe('basic matching', () => {
    it('should match lines containing pattern', () => {
      const result = cmdGrep(ctx, ['apple', 'test.txt']);
      expect(result).toContain('apple pie');
      expect(result).toContain('apple sauce');
      expect(result).not.toContain('Hello');
    });

    it('should match regex patterns', () => {
      const result = cmdGrep(ctx, ['^a', 'test.txt']);
      expect(result).toContain('apple pie');
      expect(result).toContain('apple sauce');
      expect(result).not.toContain('Banana');
    });

    it('should handle stdin input', () => {
      const result = cmdGrep(ctx, ['hello'], 'hello world\ngoodbye world\nhello again\n');
      expect(result).toContain('hello world');
      expect(result).toContain('hello again');
      expect(result).not.toContain('goodbye');
    });
  });

  describe('-i flag (case insensitive)', () => {
    it('should match case-insensitively', () => {
      const result = cmdGrep(ctx, ['-i', 'hello', 'test.txt']);
      expect(result).toContain('Hello World');
    });
  });

  describe('-v flag (invert match)', () => {
    it('should show non-matching lines', () => {
      const result = cmdGrep(ctx, ['-v', 'apple', 'test.txt']);
      expect(result).not.toContain('apple');
      expect(result).toContain('Hello World');
      expect(result).toContain('Banana split');
    });
  });

  describe('-c flag (count only)', () => {
    it('should count matching lines', () => {
      const result = cmdGrep(ctx, ['-c', 'apple', 'test.txt']);
      expect(result.trim()).toBe('2');
    });
  });

  describe('-n flag (line numbers)', () => {
    it('should prefix matching lines with line numbers', () => {
      const result = cmdGrep(ctx, ['-n', 'apple', 'test.txt']);
      expect(result).toContain('2:apple pie');
      expect(result).toContain('5:apple sauce');
    });
  });

  describe('-l flag (files with matches)', () => {
    it('should print only filenames of matching files', () => {
      const result = cmdGrep(ctx, ['-l', 'apple', 'test.txt', 'data.csv']);
      expect(result.trim()).toBe('test.txt');
    });

    it('should list multiple matching files', () => {
      const result = cmdGrep(ctx, ['-l', 'a', 'test.txt', 'data.csv']);
      expect(result).toContain('test.txt');
      expect(result).toContain('data.csv');
    });
  });

  describe('-w flag (whole word)', () => {
    it('should match whole words only', () => {
      const result = cmdGrep(ctx, ['-w', 'pie', 'test.txt']);
      expect(result).toContain('apple pie');
    });

    it('should not match partial words', () => {
      const result = cmdGrep(ctx, ['-w', 'app', 'test.txt']);
      expect(result).toBe('');
    });
  });

  describe('-o flag (only matching part)', () => {
    it('should print only the matching part', () => {
      const result = cmdGrep(ctx, ['-o', 'apple', 'test.txt']);
      const lines = result.split('\n').filter(Boolean);
      expect(lines).toEqual(['apple', 'apple']);
    });
  });

  describe('-q flag (quiet)', () => {
    it('should produce no output in quiet mode', () => {
      const result = cmdGrep(ctx, ['-q', 'apple', 'test.txt']);
      expect(result).toBe('');
    });
  });

  describe('-H and -h flags (filename control)', () => {
    it('should force filename prefix with -H on single file', () => {
      const result = cmdGrep(ctx, ['-H', 'apple', 'test.txt']);
      expect(result).toContain('test.txt:apple pie');
    });

    it('should suppress filename with -h on multiple files', () => {
      const result = cmdGrep(ctx, ['-h', 'Paris', 'test.txt', 'data.csv']);
      expect(result).not.toContain('data.csv:');
      expect(result).toContain('Paris');
    });
  });

  describe('context lines (-A, -B, -C)', () => {
    it('should show lines after match with -A', () => {
      const result = cmdGrep(ctx, ['-A', '1', 'Hello', 'test.txt']);
      expect(result).toContain('Hello World');
      expect(result).toContain('apple pie');
    });

    it('should show lines before match with -B', () => {
      const result = cmdGrep(ctx, ['-B', '1', 'Banana', 'test.txt']);
      expect(result).toContain('apple pie');
      expect(result).toContain('Banana split');
    });

    it('should show context with -C', () => {
      const result = cmdGrep(ctx, ['-C', '1', 'Banana', 'test.txt']);
      expect(result).toContain('apple pie');
      expect(result).toContain('Banana split');
      expect(result).toContain('cherry jam');
    });
  });

  describe('multiple files', () => {
    it('should prefix with filename when searching multiple files', () => {
      const result = cmdGrep(ctx, ['Paris', 'test.txt', 'data.csv']);
      expect(result).toContain('data.csv:');
    });
  });

  describe('error handling', () => {
    it('should return error for missing pattern', () => {
      const result = cmdGrep(ctx, []);
      expect(result).toContain('Usage');
    });

    it('should report missing file', () => {
      const result = cmdGrep(ctx, ['pattern', 'nonexistent.txt']);
      expect(result).toContain('No such file or directory');
    });

    it('should handle empty file gracefully', () => {
      const result = cmdGrep(ctx, ['pattern', 'empty.txt']);
      expect(result).toBe('');
    });
  });

  describe('combined flags', () => {
    it('should handle -in (case insensitive + line numbers)', () => {
      const result = cmdGrep(ctx, ['-in', 'hello', 'test.txt']);
      expect(result).toContain('1:Hello World');
    });

    it('should handle -cv (count inverted)', () => {
      const result = cmdGrep(ctx, ['-cv', 'apple', 'test.txt']);
      // 5 lines total, 2 match, so 3 non-matching
      expect(result.trim()).toBe('3');
    });
  });
});
