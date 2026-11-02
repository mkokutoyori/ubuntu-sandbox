/*
 * Structure — the RRL settings of a Windows DNS server and the SetRRL operation of [MS-DNSP] 3.1.4.1 that changes them:
 * only the parameters given are updated; fSetDefault ignores every other parameter and resets all but the mode; and
 * the result is validated, the first failure in the order of the specification winning — Leak Rate (9916), TC Rate
 * (9915), window size (9912), IPv4 prefix (9913), IPv6 prefix (9914), then Leak Rate below TC Rate (9917). The texts are
 * those of the Win32 error table; the TC rate range follows the cmdlet page (0 or 2 to 10) where the error text says
 * "less than 10". Discrimination (run on the tree before the change): every case falls, the module did not exist.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_RESPONSE_RATE_LIMITING, RESPONSE_RATE_LIMITING_REFUSALS, RESPONSE_RATE_LIMITING_MODES, planResponseRateLimiting,
  type ResponseRateLimitingChanges, type ResponseRateLimitingSettings,
} from '@/network/devices/windows/server/dns/DnsResponseRateLimiting';

const plan = (changes: ResponseRateLimitingChanges, current: ResponseRateLimitingSettings = DEFAULT_RESPONSE_RATE_LIMITING) =>
  planResponseRateLimiting(current, changes);

describe('the defaults', () => {
  it('are those of DNS_RPC_RRL_PARAMS, with the mode off', () => {
    expect(DEFAULT_RESPONSE_RATE_LIMITING).toEqual({
      responsesPerSecond: 5, errorsPerSecond: 5, windowSeconds: 5, ipv4PrefixLength: 24, ipv6PrefixLength: 56,
      leakRate: 3, truncateRate: 2, maximumResponsesPerWindow: 1024, mode: 'Disable',
    });
  });

  it('name the three modes of DNS_RRL_MODE_ENUM', () => {
    expect(RESPONSE_RATE_LIMITING_MODES).toEqual(['LogOnly', 'Enable', 'Disable']);
  });
});

describe('updating', () => {
  it('changes only the parameters given', () => {
    expect(plan({ windowSeconds: 7, leakRate: 4, truncateRate: 3, errorsPerSecond: 8, responsesPerSecond: 8 })).toEqual({
      ...DEFAULT_RESPONSE_RATE_LIMITING, windowSeconds: 7, leakRate: 4, truncateRate: 3, errorsPerSecond: 8, responsesPerSecond: 8,
    });
  });

  it.each([
    ['responsesPerSecond', 9], ['errorsPerSecond', 9], ['windowSeconds', 9], ['ipv4PrefixLength', 20],
    ['ipv6PrefixLength', 64], ['leakRate', 5], ['truncateRate', 3], ['maximumResponsesPerWindow', 99], ['mode', 'Enable'],
  ] as const)('sets %s on its own', (field, value) => {
    expect(plan({ [field]: value })).toEqual({ ...DEFAULT_RESPONSE_RATE_LIMITING, [field]: value });
  });

  it('changes the mode without touching the rest', () => {
    const current = { ...DEFAULT_RESPONSE_RATE_LIMITING, windowSeconds: 9 };
    expect(plan({ mode: 'LogOnly' }, current)).toEqual({ ...current, mode: 'LogOnly' });
  });

  it('does not change what it was given when it refuses', () => {
    const current = { ...DEFAULT_RESPONSE_RATE_LIMITING };
    expect(typeof plan({ leakRate: 1 }, current)).toBe('string');
    expect(current).toEqual(DEFAULT_RESPONSE_RATE_LIMITING);
  });
});

describe('resetting to the defaults', () => {
  const changed: ResponseRateLimitingSettings = {
    responsesPerSecond: 9, errorsPerSecond: 9, windowSeconds: 9, ipv4PrefixLength: 20, ipv6PrefixLength: 64,
    leakRate: 5, truncateRate: 3, maximumResponsesPerWindow: 99, mode: 'LogOnly',
  };

  it('puts every parameter back and keeps the mode', () => {
    expect(plan({ resetToDefault: true }, changed)).toEqual({ ...DEFAULT_RESPONSE_RATE_LIMITING, mode: 'LogOnly' });
  });

  it('ignores every other parameter, the mode included, even an invalid one', () => {
    expect(plan({ resetToDefault: true, windowSeconds: 0, leakRate: 1, mode: 'Enable' }, changed))
      .toEqual({ ...DEFAULT_RESPONSE_RATE_LIMITING, mode: 'LogOnly' });
  });

  it('is not triggered by a false flag', () => {
    expect(plan({ resetToDefault: false, windowSeconds: 9 }, changed)).toEqual({ ...changed, windowSeconds: 9 });
  });
});

describe('validation', () => {
  it.each([
    ['LeakRate 1', { leakRate: 1 }, RESPONSE_RATE_LIMITING_REFUSALS.leakRate],
    ['LeakRate 11', { leakRate: 11 }, RESPONSE_RATE_LIMITING_REFUSALS.leakRate],
    ['TruncateRate 1', { truncateRate: 1 }, RESPONSE_RATE_LIMITING_REFUSALS.truncateRate],
    ['TruncateRate 11', { truncateRate: 11 }, RESPONSE_RATE_LIMITING_REFUSALS.truncateRate],
    ['WindowInSec 0', { windowSeconds: 0 }, RESPONSE_RATE_LIMITING_REFUSALS.windowSize],
    ['IPv4PrefixLength 33', { ipv4PrefixLength: 33 }, RESPONSE_RATE_LIMITING_REFUSALS.ipv4Prefix],
    ['IPv6PrefixLength 129', { ipv6PrefixLength: 129 }, RESPONSE_RATE_LIMITING_REFUSALS.ipv6Prefix],
    ['LeakRate below TruncateRate', { leakRate: 2, truncateRate: 3 }, RESPONSE_RATE_LIMITING_REFUSALS.leakBelowTruncate],
    ['ResponsesPerSec 0', { responsesPerSecond: 0 }, RESPONSE_RATE_LIMITING_REFUSALS.notPositive],
    ['ErrorsPerSec 0', { errorsPerSecond: 0 }, RESPONSE_RATE_LIMITING_REFUSALS.notPositive],
    ['MaximumResponsesPerWindow 0', { maximumResponsesPerWindow: 0 }, RESPONSE_RATE_LIMITING_REFUSALS.notPositive],
  ] as const)('refuses %s', (_label, changes, refusal) => {
    expect(plan(changes)).toBe(refusal);
  });

  it.each([
    ['LeakRate 0', { leakRate: 0 }],
    ['LeakRate 10', { leakRate: 10 }],
    ['TruncateRate 0', { truncateRate: 0 }],
    ['TruncateRate 2', { truncateRate: 2 }],
    ['both rates 10', { leakRate: 10, truncateRate: 10 }],
    ['WindowInSec 1', { windowSeconds: 1 }],
    ['IPv4PrefixLength 0', { ipv4PrefixLength: 0 }],
    ['IPv4PrefixLength 32', { ipv4PrefixLength: 32 }],
    ['IPv6PrefixLength 0', { ipv6PrefixLength: 0 }],
    ['IPv6PrefixLength 128', { ipv6PrefixLength: 128 }],
    ['LeakRate equal to TruncateRate', { leakRate: 4, truncateRate: 4 }],
    ['LeakRate 0 with a TruncateRate', { leakRate: 0, truncateRate: 5 }],
    ['TruncateRate 0 with a LeakRate', { leakRate: 2, truncateRate: 0 }],
    ['ResponsesPerSec 1', { responsesPerSecond: 1 }],
    ['ErrorsPerSec 4294967295', { errorsPerSecond: 4294967295 }],
  ] as const)('accepts %s', (_label, changes) => {
    expect(typeof plan(changes)).toBe('object');
  });

  it('judges the settings that would result, not only the parameters given', () => {
    expect(plan({ truncateRate: 5 })).toBe(RESPONSE_RATE_LIMITING_REFUSALS.leakBelowTruncate);
    expect(plan({ leakRate: 2 })).toMatchObject({ leakRate: 2, truncateRate: 2 });
    expect(plan({ leakRate: 2 }, { ...DEFAULT_RESPONSE_RATE_LIMITING, truncateRate: 5, leakRate: 6 }))
      .toBe(RESPONSE_RATE_LIMITING_REFUSALS.leakBelowTruncate);
  });

  it('reports the first failure in the order of the specification', () => {
    const everythingWrong = { leakRate: 1, truncateRate: 1, windowSeconds: 0, ipv4PrefixLength: 33, ipv6PrefixLength: 129, responsesPerSecond: 0 };
    expect(plan(everythingWrong)).toBe(RESPONSE_RATE_LIMITING_REFUSALS.leakRate);
    const { leakRate, ...withoutLeak } = everythingWrong;
    expect(leakRate).toBe(1);
    expect(plan(withoutLeak)).toBe(RESPONSE_RATE_LIMITING_REFUSALS.truncateRate);
    const { truncateRate, ...withoutTruncate } = withoutLeak;
    expect(truncateRate).toBe(1);
    expect(plan(withoutTruncate)).toBe(RESPONSE_RATE_LIMITING_REFUSALS.windowSize);
    const { windowSeconds, ...withoutWindow } = withoutTruncate;
    expect(windowSeconds).toBe(0);
    expect(plan(withoutWindow)).toBe(RESPONSE_RATE_LIMITING_REFUSALS.ipv4Prefix);
    const { ipv4PrefixLength, ...withoutIpv4 } = withoutWindow;
    expect(ipv4PrefixLength).toBe(33);
    expect(plan(withoutIpv4)).toBe(RESPONSE_RATE_LIMITING_REFUSALS.ipv6Prefix);
  });

  it('reports a Leak Rate below the TC Rate before a parameter that is not positive', () => {
    expect(plan({ leakRate: 2, truncateRate: 3, responsesPerSecond: 0 })).toBe(RESPONSE_RATE_LIMITING_REFUSALS.leakBelowTruncate);
  });

  it('reports a prefix length before a Leak Rate below the TC Rate', () => {
    expect(plan({ ipv6PrefixLength: 129, leakRate: 2, truncateRate: 3 })).toBe(RESPONSE_RATE_LIMITING_REFUSALS.ipv6Prefix);
  });
});
