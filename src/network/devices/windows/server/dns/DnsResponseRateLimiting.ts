import type { RateLimits } from '@/network/dns/rrl/ResponseRateLimiter';

export type ResponseRateLimitingMode = 'LogOnly' | 'Enable' | 'Disable';

export const RESPONSE_RATE_LIMITING_MODES: readonly ResponseRateLimitingMode[] = ['LogOnly', 'Enable', 'Disable'];

export interface ResponseRateLimitingSettings extends RateLimits {
  readonly mode: ResponseRateLimitingMode;
}

export interface ResponseRateLimitingChanges extends Partial<RateLimits> {
  readonly mode?: ResponseRateLimitingMode;
  readonly resetToDefault?: boolean;
}

export const DEFAULT_RESPONSE_RATE_LIMITING: ResponseRateLimitingSettings = {
  responsesPerSecond: 5,
  errorsPerSecond: 5,
  windowSeconds: 5,
  ipv4PrefixLength: 24,
  ipv6PrefixLength: 56,
  leakRate: 3,
  truncateRate: 2,
  maximumResponsesPerWindow: 1024,
  mode: 'Disable',
};

export const RESPONSE_RATE_LIMITING_REFUSALS = {
  leakRate: 'The Leak Rate parameter is invalid. It should be either 0, or between 2 and 10.',
  truncateRate: 'The TC Rate parameter is invalid. It should be 0, or between 2 and 10.',
  windowSize: 'The window size parameter is invalid. It should be greater than or equal to 1.',
  ipv4Prefix: 'The IPv4 prefix length parameter is invalid. It should be less than or equal to 32.',
  ipv6Prefix: 'The IPv6 prefix length parameter is invalid. It should be less than or equal to 128.',
  leakBelowTruncate: 'The Leak Rate or TC Rate parameter is invalid. Leak Rate should be greater than TC Rate.',
  notPositive: 'The parameter is incorrect.',
} as const;

const MINIMUM_RATE = 2;
const MAXIMUM_RATE = 10;
const MAXIMUM_IPV4_PREFIX = 32;
const MAXIMUM_IPV6_PREFIX = 128;

const isRate = (rate: number): boolean => rate === 0 || (rate >= MINIMUM_RATE && rate <= MAXIMUM_RATE);

function refusalOf(settings: ResponseRateLimitingSettings): string | null {
  if (!isRate(settings.leakRate)) return RESPONSE_RATE_LIMITING_REFUSALS.leakRate;
  if (!isRate(settings.truncateRate)) return RESPONSE_RATE_LIMITING_REFUSALS.truncateRate;
  if (settings.windowSeconds < 1) return RESPONSE_RATE_LIMITING_REFUSALS.windowSize;
  if (settings.ipv4PrefixLength > MAXIMUM_IPV4_PREFIX) return RESPONSE_RATE_LIMITING_REFUSALS.ipv4Prefix;
  if (settings.ipv6PrefixLength > MAXIMUM_IPV6_PREFIX) return RESPONSE_RATE_LIMITING_REFUSALS.ipv6Prefix;
  if (settings.leakRate !== 0 && settings.leakRate < settings.truncateRate) {
    return RESPONSE_RATE_LIMITING_REFUSALS.leakBelowTruncate;
  }
  const counts = [settings.responsesPerSecond, settings.errorsPerSecond, settings.maximumResponsesPerWindow];
  return counts.every(count => count >= 1) ? null : RESPONSE_RATE_LIMITING_REFUSALS.notPositive;
}

export function planResponseRateLimiting(
  current: ResponseRateLimitingSettings, changes: ResponseRateLimitingChanges,
): ResponseRateLimitingSettings | string {
  if (changes.resetToDefault === true) return { ...DEFAULT_RESPONSE_RATE_LIMITING, mode: current.mode };
  const planned: ResponseRateLimitingSettings = {
    responsesPerSecond: changes.responsesPerSecond ?? current.responsesPerSecond,
    errorsPerSecond: changes.errorsPerSecond ?? current.errorsPerSecond,
    windowSeconds: changes.windowSeconds ?? current.windowSeconds,
    ipv4PrefixLength: changes.ipv4PrefixLength ?? current.ipv4PrefixLength,
    ipv6PrefixLength: changes.ipv6PrefixLength ?? current.ipv6PrefixLength,
    leakRate: changes.leakRate ?? current.leakRate,
    truncateRate: changes.truncateRate ?? current.truncateRate,
    maximumResponsesPerWindow: changes.maximumResponsesPerWindow ?? current.maximumResponsesPerWindow,
    mode: changes.mode ?? current.mode,
  };
  return refusalOf(planned) ?? planned;
}
