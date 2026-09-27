import type { ArgumentSpec } from '../../ArgumentTypes';
import type { CommandSpec } from '../../CommandTable';

export type UnreachableRateLimitTimer = 'df' | 'general';

export interface IcmpRateLimitHost {
  setIcmpUnreachableRateLimit(timer: UnreachableRateLimitTimer, intervalMs: number | null): void;
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
];

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
  ];
}
