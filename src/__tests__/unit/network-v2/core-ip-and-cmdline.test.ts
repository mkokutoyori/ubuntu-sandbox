/**
 * Tests for the canonical validators/tokenizers introduced by the
 * Série 3 dedup work (journal entries — backlog #18/#19):
 *   - core/ip.ts isValidIPv4 / isValidIPv6 (replaces three per-module
 *     regex variants in PowerShellExecutor, WinNetsh, …)
 *   - devices/windows/cmdline.ts splitCmdArgs (replaces the identical
 *     private copies in WindowsPC.parseCommandLine / CmdSubShell.splitArgs)
 */

import { describe, it, expect } from 'vitest';
import { isValidIPv4, isValidIPv6 } from '@/network/core/ip';
import { splitCmdArgs } from '@/network/devices/windows/cmdline';

describe('isValidIPv4', () => {
  it('accepts plain dotted quads', () => {
    expect(isValidIPv4('192.168.1.1')).toBe(true);
    expect(isValidIPv4('0.0.0.0')).toBe(true);
    expect(isValidIPv4('255.255.255.255')).toBe(true);
  });

  it('rejects octets above 255', () => {
    expect(isValidIPv4('999.1.1.1')).toBe(false);
    expect(isValidIPv4('1.2.3.256')).toBe(false);
  });

  it('rejects wrong group counts and garbage', () => {
    expect(isValidIPv4('1.2.3')).toBe(false);
    expect(isValidIPv4('1.2.3.4.5')).toBe(false);
    expect(isValidIPv4('')).toBe(false);
    expect(isValidIPv4('a.b.c.d')).toBe(false);
    expect(isValidIPv4('1.2.3.')).toBe(false);
  });
});

describe('isValidIPv6', () => {
  it('accepts full and compressed forms', () => {
    expect(isValidIPv6('2001:db8:0:0:0:0:0:1')).toBe(true);
    expect(isValidIPv6('2001:db8::1')).toBe(true);
    expect(isValidIPv6('::1')).toBe(true);
    expect(isValidIPv6('::')).toBe(true);
    expect(isValidIPv6('fe80::1')).toBe(true);
  });

  it('accepts a zone index and embedded IPv4 tails', () => {
    expect(isValidIPv6('fe80::1%eth0')).toBe(true);
    expect(isValidIPv6('::ffff:192.0.2.1')).toBe(true);
  });

  it('rejects the garbage the old loose regex accepted', () => {
    expect(isValidIPv6(':::::')).toBe(false);
    expect(isValidIPv6('12345::')).toBe(false);
    expect(isValidIPv6('1:2:3:4:5:6:7:8:9')).toBe(false);
    expect(isValidIPv6('2001:db8::1::2')).toBe(false);
    expect(isValidIPv6('1:2:3:4:5:6:7:8::')).toBe(false);
    expect(isValidIPv6('not-an-ip')).toBe(false);
    expect(isValidIPv6('192.168.1.1')).toBe(false);
  });

  it('requires :: to compress at least one group', () => {
    // 8 explicit groups + '::' would make 9 — invalid.
    expect(isValidIPv6('1:2:3:4:5:6:7::8')).toBe(false);
    // 7 explicit groups + '::' standing for the 8th — valid.
    expect(isValidIPv6('1:2:3:4:5:6:7::')).toBe(true);
  });
});

describe('splitCmdArgs', () => {
  it('splits on spaces', () => {
    expect(splitCmdArgs('dir C:\\Users /s')).toEqual(['dir', 'C:\\Users', '/s']);
  });

  it('keeps double-quoted segments together and strips quotes', () => {
    expect(splitCmdArgs('type "C:\\My Documents\\a.txt"'))
      .toEqual(['type', 'C:\\My Documents\\a.txt']);
  });

  it('handles quotes toggling mid-token', () => {
    expect(splitCmdArgs('echo a"b c"d')).toEqual(['echo', 'ab cd']);
  });

  it('collapses repeated spaces and trims', () => {
    expect(splitCmdArgs('  echo   hi  ')).toEqual(['echo', 'hi']);
  });

  it('returns empty array for empty/blank input', () => {
    expect(splitCmdArgs('')).toEqual([]);
    expect(splitCmdArgs('   ')).toEqual([]);
  });
});
