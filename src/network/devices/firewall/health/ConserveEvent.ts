import type { FirewallLogDraft } from '../logging/FirewallLogStore';
import type { ConserveTransition } from './SystemLoad';

export const CONSERVE_ENTER_LOG_ID = '0100022011';
export const CONSERVE_LEAVE_LOG_ID = '0100022012';

function megabytes(kib: number): string {
  return `${Math.round(kib / 1024)} MB`;
}

export function conserveLogDraft(
  at: number, transition: ConserveTransition,
): FirewallLogDraft {
  const { memory, thresholds } = transition;
  const share = (percent: number) =>
    megabytes(Math.round((memory.totalKib * percent) / 100));

  return {
    at,
    type: 'event',
    subtype: 'system',
    level: 'critical',
    id: transition.entered ? CONSERVE_ENTER_LOG_ID : CONSERVE_LEAVE_LOG_ID,
    fields: {
      logdesc: transition.entered
        ? 'Memory conserve mode entered' : 'Memory conserve mode exited',
      service: 'kernel',
      conserve: transition.entered ? 'on' : 'exit',
      total: megabytes(memory.totalKib),
      used: megabytes(memory.usedKib),
      red: share(thresholds.redPercent),
      green: share(thresholds.greenPercent),
      msg: transition.entered
        ? 'Kernel enters memory conserve mode'
        : 'Kernel leaves memory conserve mode',
    },
  };
}
