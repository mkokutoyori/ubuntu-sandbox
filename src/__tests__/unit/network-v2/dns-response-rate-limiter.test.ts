/*
 * Structure — the engine behind Response Rate Limiting, as [MS-DNSP] DNS_RPC_RRL_PARAMS and ISC-TN-2012-1 describe it.
 * Two responses are "the same" when they share the requestor's address masked to IPv4PrefixLength or IPv6PrefixLength,
 * an imputed name, and an error flag. Per such response: at most ResponsesPerSec (ErrorsPerSec for an error) full
 * responses in any one-second span; beyond that, a query "would be dropped" and is instead answered with a truncated
 * response once per TruncateRate, with a full response once per LeakRate, and dropped otherwise; and at most
 * MaximumResponsesPerWindow responses of any kind (full, leaked, truncated) per WindowInSec, after which the count
 * restarts. State unused for a window is forgotten, and the table is bounded (least recently used goes first).
 * Discrimination (run on the tree before the change): every case falls, the module did not exist.
 */
import { describe, it, expect } from 'vitest';
import { IPAddress, IPv6Address } from '@/network/core/types';
import {
  ResponseRateLimiter, MAXIMUM_TRACKED_RESPONSES, sourceBucket, type RateLimits, type RateProbe, type RateVerdict,
} from '@/network/dns/rrl/ResponseRateLimiter';
import { DEFAULT_RESPONSE_RATE_LIMITING } from '@/network/devices/windows/server/dns/DnsResponseRateLimiting';

const DEFAULTS: RateLimits = DEFAULT_RESPONSE_RATE_LIMITING;

const v4 = (source: string, name = 'www.corp.test', error = false): RateProbe => ({ source: new IPAddress(source), imputedName: name, error });
const v6 = (source: string, name = 'www.corp.test', error = false): RateProbe => ({ source: new IPv6Address(source), imputedName: name, error });

function lab(capacity?: number) {
  let at = 0;
  const limiter = new ResponseRateLimiter(() => at, capacity);
  return {
    limiter,
    advance: (milliseconds: number): void => { at += milliseconds; },
    judge: (probe: RateProbe, limits: RateLimits = DEFAULTS): RateVerdict => limiter.judge(probe, limits),
    judgeMany: (probe: RateProbe, count: number, limits: RateLimits = DEFAULTS): RateVerdict[] =>
      Array.from({ length: count }, () => limiter.judge(probe, limits)),
  };
}

describe('the allowance of full responses', () => {
  it('lets ResponsesPerSec identical responses through and limits the next one', () => {
    const { judgeMany } = lab();
    const verdicts = judgeMany(v4('10.0.0.1'), 6);
    expect(verdicts.slice(0, 5)).toEqual(['send', 'send', 'send', 'send', 'send']);
    expect(verdicts[5]).not.toBe('send');
  });

  it('gives an allowance back when the response that used it is a full second old, not before', () => {
    const { judge, judgeMany, advance } = lab();
    judgeMany(v4('10.0.0.1'), 5);
    advance(999);
    expect(judge(v4('10.0.0.1'))).not.toBe('send');
    advance(1);
    expect(judge(v4('10.0.0.1'))).toBe('send');
  });

  it('keeps to the rate in every one-second span of a steady flood', () => {
    const { judge, advance } = lab();
    const sentAt: number[] = [];
    for (let step = 0; step < 50; step++) {
      if (judge(v4('10.0.0.1')) === 'send') sentAt.push(step * 100);
      advance(100);
    }
    expect(sentAt.length).toBe(25);
    for (const start of sentAt) expect(sentAt.filter(at => at >= start && at < start + 1000).length).toBeLessThanOrEqual(5);
  });

  it('counts an error response against ErrorsPerSec, apart from the full responses of the same name', () => {
    const { judgeMany } = lab();
    const limits = { ...DEFAULTS, errorsPerSecond: 2 };
    const errors = judgeMany(v4('10.0.0.1', 'corp.test', true), 3, limits);
    expect(errors).toEqual(['send', 'send', expect.not.stringMatching(/^send$/)]);
    expect(judgeMany(v4('10.0.0.1', 'corp.test', false), 5, limits)).toEqual(['send', 'send', 'send', 'send', 'send']);
  });
});

describe('what makes two responses the same', () => {
  it('ignores the case and the final dot of the imputed name', () => {
    const { judge, judgeMany } = lab();
    judgeMany(v4('10.0.0.1', 'www.corp.test'), 5);
    expect(judge(v4('10.0.0.1', 'WWW.Corp.Test.'))).not.toBe('send');
  });

  it('gives another imputed name its own allowance', () => {
    const { judge, judgeMany } = lab();
    judgeMany(v4('10.0.0.1', 'www.corp.test'), 5);
    expect(judge(v4('10.0.0.1', 'mail.corp.test'))).toBe('send');
  });

  it('groups the hosts of an IPv4 /24 and separates another /24', () => {
    const { judge, judgeMany } = lab();
    judgeMany(v4('10.0.0.1'), 5);
    expect(judge(v4('10.0.0.200'))).not.toBe('send');
    expect(judge(v4('10.0.1.1'))).toBe('send');
  });

  it('follows IPv4PrefixLength: 32 separates the hosts of a /24, 0 groups every address', () => {
    const { judge, judgeMany } = lab();
    judgeMany(v4('10.0.0.1'), 5, { ...DEFAULTS, ipv4PrefixLength: 32 });
    expect(judge(v4('10.0.0.2'), { ...DEFAULTS, ipv4PrefixLength: 32 })).toBe('send');
    judgeMany(v4('172.16.0.1', 'other.test'), 5, { ...DEFAULTS, ipv4PrefixLength: 0 });
    expect(judge(v4('203.0.113.9', 'other.test'), { ...DEFAULTS, ipv4PrefixLength: 0 })).not.toBe('send');
  });

  it('groups the hosts of an IPv6 /56 and separates another /56', () => {
    const { judge, judgeMany } = lab();
    judgeMany(v6('2001:db8:0:aa00::1'), 5);
    expect(judge(v6('2001:db8:0:aaff::ffff'))).not.toBe('send');
    expect(judge(v6('2001:db8:0:ab00::1'))).toBe('send');
  });

  it('follows IPv6PrefixLength: 128 separates addresses of the same /56', () => {
    const { judge, judgeMany } = lab();
    const limits = { ...DEFAULTS, ipv6PrefixLength: 128 };
    judgeMany(v6('2001:db8:0:aa00::1'), 5, limits);
    expect(judge(v6('2001:db8:0:aa00::2'), limits)).toBe('send');
  });

  it('never mixes an IPv4 requestor with an IPv6 one', () => {
    const { judge, judgeMany } = lab();
    const limits = { ...DEFAULTS, ipv4PrefixLength: 0, ipv6PrefixLength: 0 };
    judgeMany(v4('10.0.0.1'), 5, limits);
    expect(judge(v6('2001:db8::1'), limits)).toBe('send');
  });

  it('masks a requestor to its bucket address', () => {
    expect(sourceBucket(new IPAddress('10.1.2.3'), DEFAULTS)).toBe('10.1.2.0');
    expect(sourceBucket(new IPv6Address('2001:db8:0:aaff::1'), DEFAULTS)).toBe('2001:db8:0:aa00::');
  });
});

describe('a query that would be dropped', () => {
  const overRate = (limits: RateLimits, count: number): RateVerdict[] => {
    const { judgeMany } = lab();
    judgeMany(v4('10.0.0.1'), 5, limits);
    return judgeMany(v4('10.0.0.1'), count, limits);
  };

  it('is answered with a truncated response once per TruncateRate and a full one once per LeakRate', () => {
    expect(overRate(DEFAULTS, 9)).toEqual(['drop', 'truncate', 'leak', 'truncate', 'drop', 'truncate', 'drop', 'truncate', 'leak']);
  });

  it('prefers the truncated response when both are due', () => {
    expect(overRate(DEFAULTS, 6)[5]).toBe('truncate');
  });

  it('never leaks when LeakRate is 0', () => {
    expect(overRate({ ...DEFAULTS, leakRate: 0 }, 9)).not.toContain('leak');
    expect(overRate({ ...DEFAULTS, leakRate: 0 }, 9)).toContain('truncate');
  });

  it('never truncates when TruncateRate is 0', () => {
    expect(overRate({ ...DEFAULTS, truncateRate: 0 }, 9)).not.toContain('truncate');
    expect(overRate({ ...DEFAULTS, truncateRate: 0 }, 9)).toEqual(['drop', 'drop', 'leak', 'drop', 'drop', 'leak', 'drop', 'drop', 'leak']);
  });

  it('only drops when both rates are 0', () => {
    expect(new Set(overRate({ ...DEFAULTS, leakRate: 0, truncateRate: 0 }, 12))).toEqual(new Set(['drop']));
  });
});

describe('the window', () => {
  it('caps the responses of every kind given to one response at MaximumResponsesPerWindow', () => {
    const { judgeMany } = lab();
    const limits = { ...DEFAULTS, responsesPerSecond: 1000, maximumResponsesPerWindow: 3 };
    expect(judgeMany(v4('10.0.0.1'), 6, limits)).toEqual(['send', 'send', 'send', 'drop', 'drop', 'drop']);
  });

  it('counts leaked and truncated responses toward the cap', () => {
    const { judgeMany } = lab();
    const limits = { ...DEFAULTS, responsesPerSecond: 1, maximumResponsesPerWindow: 4 };
    expect(judgeMany(v4('10.0.0.1'), 8, limits)).toEqual(['send', 'drop', 'truncate', 'leak', 'truncate', 'drop', 'drop', 'drop']);
  });

  it('keeps the cap after the one-second allowance has come back', () => {
    const { judge, judgeMany, advance } = lab();
    const limits = { ...DEFAULTS, maximumResponsesPerWindow: 7 };
    judgeMany(v4('10.0.0.1'), 5, limits);
    advance(1000);
    expect(judgeMany(v4('10.0.0.1'), 3, limits)).toEqual(['send', 'send', 'drop']);
    expect(judge(v4('10.0.0.1'), limits)).toBe('drop');
  });

  it('restarts the count once WindowInSec has passed', () => {
    const { judgeMany, advance } = lab();
    const limits = { ...DEFAULTS, maximumResponsesPerWindow: 5 };
    judgeMany(v4('10.0.0.1'), 5, limits);
    expect(judgeMany(v4('10.0.0.1'), 3, limits)).toEqual(['drop', 'drop', 'drop']);
    advance(DEFAULTS.windowSeconds * 1000);
    expect(judgeMany(v4('10.0.0.1'), 7, limits)).toEqual(['send', 'send', 'send', 'send', 'send', 'drop', 'drop']);
  });

  it('restarts the leak and truncate cadence once WindowInSec has passed', () => {
    const { judgeMany, advance } = lab();
    judgeMany(v4('10.0.0.1'), 5);
    expect(judgeMany(v4('10.0.0.1'), 1)).toEqual(['drop']);
    advance(DEFAULTS.windowSeconds * 1000);
    expect(judgeMany(v4('10.0.0.1'), 7)).toEqual(['send', 'send', 'send', 'send', 'send', 'drop', 'truncate']);
  });

  it('starts the next window at the first query after the boundary, while the flood goes on', () => {
    const { judge, advance } = lab();
    const limits = { ...DEFAULTS, responsesPerSecond: 1000, maximumResponsesPerWindow: 3 };
    const verdicts: RateVerdict[] = [];
    for (let second = 0; second < 11; second++) {
      verdicts.push(judge(v4('10.0.0.1'), limits));
      advance(1000);
    }
    expect(verdicts).toEqual([
      'send', 'send', 'send', 'drop', 'drop', 'send', 'send', 'send', 'drop', 'drop', 'send',
    ]);
  });

  it('restarts the cadence of truncated responses at the boundary, while the flood goes on', () => {
    const { judge, advance } = lab();
    const limits = { ...DEFAULTS, responsesPerSecond: 1, windowSeconds: 2, truncateRate: 2, leakRate: 0 };
    const verdicts: RateVerdict[] = [];
    for (const step of [500, 500, 1000, 500]) {
      verdicts.push(judge(v4('10.0.0.1'), limits));
      advance(step);
    }
    verdicts.push(judge(v4('10.0.0.1'), limits));
    expect(verdicts).toEqual(['send', 'drop', 'send', 'send', 'drop']);
  });

  it('keeps the window running while it has not passed', () => {
    const { judgeMany, advance } = lab();
    const limits = { ...DEFAULTS, maximumResponsesPerWindow: 5 };
    judgeMany(v4('10.0.0.1'), 5, limits);
    advance(DEFAULTS.windowSeconds * 1000 - 1);
    expect(judgeMany(v4('10.0.0.1'), 1, limits)).toEqual(['drop']);
  });
});

describe('memory', () => {
  it('forgets a response that has not been seen for a whole window', () => {
    const { limiter, judge, advance } = lab();
    judge(v4('10.0.0.1', 'a.test'));
    advance(1000);
    judge(v4('10.0.0.1', 'b.test'));
    expect(limiter.tracked()).toBe(2);
    advance(DEFAULTS.windowSeconds * 1000 - 1000);
    judge(v4('10.0.0.1', 'c.test'));
    expect(limiter.tracked()).toBe(2);
  });

  it('keeps a response that was seen again within the window', () => {
    const { limiter, judge, advance } = lab();
    judge(v4('10.0.0.1', 'a.test'));
    advance(3000);
    judge(v4('10.0.0.1', 'a.test'));
    advance(3000);
    judge(v4('10.0.0.1', 'b.test'));
    expect(limiter.tracked()).toBe(2);
  });

  it('drops the least recently used response first when the table is full', () => {
    const small = lab(2);
    small.judgeMany(v4('10.0.0.1', 'a.test'), 5);
    small.judge(v4('10.0.0.1', 'b.test'));
    small.judge(v4('10.0.0.1', 'c.test'));
    expect(small.limiter.tracked()).toBe(2);
    expect(small.judge(v4('10.0.0.1', 'a.test'))).toBe('send');
  });

  it('counts a response seen again as recently used', () => {
    const small = lab(2);
    small.judgeMany(v4('10.0.0.1', 'a.test'), 5);
    small.judge(v4('10.0.0.1', 'b.test'));
    expect(small.judge(v4('10.0.0.1', 'a.test'))).not.toBe('send');
    small.judge(v4('10.0.0.1', 'c.test'));
    expect(small.judge(v4('10.0.0.1', 'a.test'))).not.toBe('send');
    expect(small.limiter.tracked()).toBe(2);
  });

  it('bounds the table at ten thousand responses by default', () => {
    expect(MAXIMUM_TRACKED_RESPONSES).toBe(10000);
    const { limiter, judge } = lab();
    for (let host = 0; host < MAXIMUM_TRACKED_RESPONSES + 5; host++) judge(v4('10.0.0.1', `host${host}.test`));
    expect(limiter.tracked()).toBe(MAXIMUM_TRACKED_RESPONSES);
  });

  it('starts over after reset', () => {
    const { limiter, judge, judgeMany } = lab();
    judgeMany(v4('10.0.0.1'), 5);
    limiter.reset();
    expect(limiter.tracked()).toBe(0);
    expect(judge(v4('10.0.0.1'))).toBe('send');
  });
});
