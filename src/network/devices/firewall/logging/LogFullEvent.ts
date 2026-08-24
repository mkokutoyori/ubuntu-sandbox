import type { FirewallLogDraft } from './FirewallLogStore';

export const LOG_FULL_FIRST_ID = '0100032023';
export const LOG_FULL_SECOND_ID = '0100032042';
export const LOG_FULL_FINAL_ID = '0100032043';

export type LogFullLevel = 'first' | 'second' | 'final';

export const DEFAULT_LOG_FULL_THRESHOLDS: Readonly<Record<LogFullLevel, number>> =
  Object.freeze({ first: 75, second: 90, final: 95 });

const IDENTIFIERS: Readonly<Record<LogFullLevel, string>> = Object.freeze({
  first: LOG_FULL_FIRST_ID,
  second: LOG_FULL_SECOND_ID,
  final: LOG_FULL_FINAL_ID,
});

const DESCRIPTIONS: Readonly<Record<LogFullLevel, string>> = Object.freeze({
  first: 'Memory log full over first warning level',
  second: 'Memory log full over second warning level',
  final: 'Memory log full over final warning level',
});

export const LOG_FULL_LEVELS: readonly LogFullLevel[] =
  Object.freeze(['first', 'second', 'final']);

export function logFullDraft(
  at: number, level: LogFullLevel, thresholdPercent: number, usedPercent: number,
): FirewallLogDraft {
  return {
    at,
    type: 'event',
    subtype: 'system',
    level: level === 'final' ? 'critical' : 'warning',
    id: IDENTIFIERS[level],
    fields: {
      logdesc: DESCRIPTIONS[level],
      service: 'kernel',
      threshold: `${thresholdPercent}%`,
      used: `${usedPercent}%`,
      msg: `Memory log usage reached ${usedPercent}% of the configured maximum`,
    },
  };
}
