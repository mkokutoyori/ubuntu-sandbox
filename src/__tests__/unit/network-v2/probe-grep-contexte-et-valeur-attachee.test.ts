/**
 * `grep -A1`, `-B1`, `-C1`, `-2`, `-nA1`, `-m1` and the `--after-context=1`
 * family take their value ATTACHED to the option, as getopt does.
 *
 * Measured before the fix: only the detached forms (`-A 1`) were read; the
 * attached one fell into the short-flag cluster, where `A` is unknown and was
 * silently dropped, so `grep -A3 x` printed the matching line alone. The
 * context that WAS printed was also wrong: no `--` between non-adjacent
 * groups, and context lines carried the `:` of a match instead of `-`.
 *
 * Discriminated with `git stash push -- src/network/devices/linux`: 9 of the
 * 11 cases fall before the fix. The two that pass either way are the WITNESS
 * (the detached `-A 1` form already reaches the line after the match, so the
 * lab's file does carry one) and the NON-REGRESSION of the flag cluster `-in`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { cmdGrep } from '@/network/devices/linux/LinuxTextCommands';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import type { ShellContext } from '@/network/devices/linux/LinuxFileCommands';

let ctx: ShellContext;

beforeEach(() => {
  const vfs = new VirtualFileSystem();
  vfs.writeFile('/home/user/f.txt', 'one\ntwo\nmatch\nfour\nfive\nsix\nmatch again\n', 1000, 1000, 0o022);
  ctx = {
    vfs, cwd: '/home/user', uid: 1000, gid: 1000, umask: 0o022,
    userMgr: { currentUser: 'user', currentUid: 1000, currentGid: 1000 } as never,
  };
});

const grep = (...args: string[]): string[] => cmdGrep(ctx, args).output.split('\n');

describe('grep takes its context and count values attached to the option', () => {
  it('WITNESS: the detached form already reaches the line after the match', () => {
    expect(grep('-A', '1', 'match', 'f.txt')).toContain('four');
  });

  it('groups are separated by -- and context lines use - after the line number', () => {
    expect(grep('-A', '1', 'match', 'f.txt')).toEqual(['match', 'four', '--', 'match again']);
    expect(grep('-n', '-A', '1', 'four', 'f.txt')).toEqual(['4:four', '5-five']);
  });

  it('-A1 prints one line after', () => {
    expect(grep('-A1', 'match', 'f.txt')).toEqual(['match', 'four', '--', 'match again']);
  });

  it('-B1 prints one line before', () => {
    expect(grep('-B1', 'match', 'f.txt')).toEqual(['two', 'match', '--', 'six', 'match again']);
  });

  it('-C1 prints one line each side', () => {
    expect(grep('-C1', 'four', 'f.txt')).toEqual(['match', 'four', 'five']);
  });

  it('-1 is -C1', () => {
    expect(grep('-1', 'four', 'f.txt')).toEqual(['match', 'four', 'five']);
  });

  it('--after-context=1 and --before-context=1 and --context=1', () => {
    expect(grep('--after-context=1', 'four', 'f.txt')).toEqual(['four', 'five']);
    expect(grep('--before-context=1', 'four', 'f.txt')).toEqual(['match', 'four']);
    expect(grep('--context=1', 'four', 'f.txt')).toEqual(['match', 'four', 'five']);
  });

  it('-nA1 numbers the lines and keeps the context', () => {
    expect(grep('-nA1', 'four', 'f.txt')).toEqual(['4:four', '5-five']);
  });

  it('-m1 stops after the first match', () => {
    expect(grep('-m1', 'match', 'f.txt')).toEqual(['match']);
  });

  it('-A with a trailing count in the cluster consumes the rest of the cluster', () => {
    expect(grep('-inA1', 'FOUR', 'f.txt')).toEqual(['4:four', '5-five']);
  });

  it('NON-REGRESSION: a plain flag cluster still works', () => {
    expect(grep('-in', 'MATCH', 'f.txt')).toEqual(['3:match', '7:match again']);
  });
});
