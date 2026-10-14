export type LeaveAllState = 'Active' | 'Passive';

export type LeaveAllEvent = 'Begin' | 'tx' | 'rLA' | 'leavealltimer';

export interface LeaveAllOutcome {
  readonly state: LeaveAllState;
  readonly sendLeaveAll: boolean;
  readonly startTimer: boolean;
  readonly requestTransmit: boolean;
}

export class LeaveAllMachine {
  private current: LeaveAllState = 'Passive';

  get state(): LeaveAllState { return this.current; }

  handle(event: LeaveAllEvent): LeaveAllOutcome {
    switch (event) {
      case 'Begin':
      case 'rLA':
        this.current = 'Passive';
        return { state: 'Passive', sendLeaveAll: false, startTimer: true, requestTransmit: false };
      case 'tx': {
        const wasActive = this.current === 'Active';
        this.current = 'Passive';
        return { state: 'Passive', sendLeaveAll: wasActive, startTimer: false, requestTransmit: false };
      }
      case 'leavealltimer':
        this.current = 'Active';
        return { state: 'Active', sendLeaveAll: false, startTimer: true, requestTransmit: true };
    }
  }
}

export const MRP_TIMERS_CENTISECONDS = Object.freeze({
  joinTime: 20, leaveTime: 100, leaveAllTime: 1000,
});

export function leaveAllInterval(leaveAllTimeCs: number, random: () => number): number {
  return leaveAllTimeCs + random() * 0.5 * leaveAllTimeCs;
}
