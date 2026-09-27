import type { ArgumentSpec } from '../../ArgumentTypes';
import type { CommandSpec } from '../../CommandTable';

export type UnreachableRateLimitTimer = 'df' | 'general';

export interface Icmpv6ErrorInterval {
  readonly intervalMs: number;
  readonly bucketSize?: number;
}

export interface IcmpRateLimitHost {
  setIcmpUnreachableRateLimit(timer: UnreachableRateLimitTimer, intervalMs: number | null): void;
  setIcmpv6ErrorInterval(setting: Icmpv6ErrorInterval | null): void;
}

const MODES = ['config'] as const;

const PREFIX = ['ip', 'icmp', 'rate-limit', 'unreachable'] as const;

const INTERVAL: ArgumentSpec = {
  name: 'milliseconds', type: 'INT', range: [1, 4294967295], description: 'Once per milliseconds',
};

export const ICMP_RATE_LIMIT_LEGENDS: ReadonlyArray<readonly [readonly string[], string]> = [
  [['ip', 'icmp'], 'ICMP options'],
  [['ip', 'icmp', 'rate-limit'], 'Rate limit ICMP messages'],
  [[...PREFIX], 'Rate limit unreachable messages'],
  [[...PREFIX, 'df'], 'Rate limit unreachables with DF set (code 4)'],
  [['ipv6', 'icmp'], 'Configure ICMP parameters'],
  [['ipv6', 'icmp', 'error-interval'], 'Specify error-interval for ICMPv6 error messages'],
];

const IPV6_ERROR_INTERVAL = ['ipv6', 'icmp', 'error-interval'] as const;

const TOKEN_INTERVAL: ArgumentSpec = {
  name: 'milliseconds', type: 'INT', range: [0, 2147483647],
  description: 'Interval between tokens in milliseconds',
};

const BUCKET_SIZE: ArgumentSpec = {
  name: 'bucketsize', type: 'INT', range: [1, 200], description: 'Max number of tokens stored in the bucket',
};

function errorIntervalSpecs(ctx: () => IcmpRateLimitHost): CommandSpec[] {
  const description = 'Specify error-interval for ICMPv6 error messages';
  const restore = (): string => { ctx().setIcmpv6ErrorInterval(null); return ''; };
  const apply = (args: Record<string, string>): string => {
    ctx().setIcmpv6ErrorInterval({
      intervalMs: Number(args.milliseconds),
      ...(args.bucketsize === undefined ? {} : { bucketSize: Number(args.bucketsize) }),
    });
    return '';
  };
  const common = {
    description, undoDescription: 'Restore the default ICMPv6 error interval',
    modes: MODES, minPrivilege: 15, undo: restore,
  } as const;
  return [
    { ...common, id: 'ipv6-icmp-error-interval', path: [...IPV6_ERROR_INTERVAL, TOKEN_INTERVAL],
      run: (_session, args) => apply(args) },
    { ...common, id: 'ipv6-icmp-error-interval-bucket', path: [...IPV6_ERROR_INTERVAL, TOKEN_INTERVAL, BUCKET_SIZE],
      run: (_session, args) => apply(args) },
    { ...common, id: 'ipv6-icmp-error-interval-no', path: [...IPV6_ERROR_INTERVAL],
      existsOnlyNegated: true, run: () => '% Incomplete command.' },
  ];
}

function timerSpecs(
  ctx: () => IcmpRateLimitHost, timer: UnreachableRateLimitTimer, words: readonly string[],
): CommandSpec[] {
  const id = timer === 'df' ? 'ip-icmp-rate-limit-unreachable-df' : 'ip-icmp-rate-limit-unreachable';
  const description = timer === 'df'
    ? 'Rate limit unreachables with DF set (code 4)'
    : 'Rate limit unreachable messages';
  const disable = (): string => { ctx().setIcmpUnreachableRateLimit(timer, null); return ''; };
  return [
    {
      id,
      path: [...words, INTERVAL],
      description,
      undoDescription: 'Remove the unreachable rate limit',
      modes: MODES, minPrivilege: 15,
      run: (_session, args) => {
        ctx().setIcmpUnreachableRateLimit(timer, Number(args.milliseconds));
        return '';
      },
      undo: disable,
    },
    {
      id: `${id}-no`,
      path: [...words],
      description,
      undoDescription: 'Remove the unreachable rate limit',
      modes: MODES, minPrivilege: 15,
      existsOnlyNegated: true,
      run: () => '% Incomplete command.',
      undo: disable,
    },
  ];
}

export function icmpRateLimitFamily(ctx: () => IcmpRateLimitHost): CommandSpec[] {
  return [
    ...timerSpecs(ctx, 'general', PREFIX),
    ...timerSpecs(ctx, 'df', [...PREFIX, 'df']),
    ...errorIntervalSpecs(ctx),
  ];
}
