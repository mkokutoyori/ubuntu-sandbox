/**
 * IEEE Std 802.1Q-2022, 10.7 (docs/rfc/dot1q/8021Q-2022.pdf p.292-296): the
 * Applicant state machine (Table 10-3), the Registrar state machine
 * (Table 10-4), the LeaveAll state machine (Table 10-5) and the timer
 * defaults (Table 10-7: JoinTime 20 cs, LeaveTime 60-100 cs, LeaveAllTime
 * 1000 cs).
 *
 * The expected tables below are transcribed from the standard's own text,
 * cell by cell, independently of the implementation, and every cell is run.
 * Footnotes honoured: 4 (rJoinIn ignored from VO and VP on point-to-point),
 * 5 (rIn ignored unless point-to-point), 6 (a transmit opportunity is
 * requested on entry to VN AN AA LA VP AP LO), 8 (tx from AN goes to QA if the
 * Registrar is IN, AA otherwise), 1 (Applicant-Only participants never reach
 * LO), 12 (a New-Only participant reacts to Begin!, New! and tx! only).
 * Footnote a of Table 10-4 is read as the point-to-point shortcut of rLv!.
 * Bracketed actions ([s], [sJ], [sL]) are optimisations of the encoding and
 * are not sent.
 *
 * Measured on a git worktree of HEAD before the change: mrp/ does not exist,
 * so the file cannot load. No witness: new state machines.
 */
import { describe, it, expect } from 'vitest';
import {
  ApplicantMachine, APPLICANT_STATES, attributeEventFor,
  type ApplicantEvent, type ApplicantState, type TransmitAction,
} from '@/network/mrp/MrpApplicant';
import { RegistrarMachine, type RegistrarState } from '@/network/mrp/MrpRegistrar';
import { LeaveAllMachine, MRP_TIMERS_CENTISECONDS, leaveAllInterval } from '@/network/mrp/MrpLeaveAll';

const STATES = APPLICANT_STATES;

const NEXT_TABLE: Readonly<Record<string, string>> = {
  Begin: 'VO VO VO VO VO VO VO VO VO VO VO VO',
  New: 'VN VN - - VN VN VN VN VN VN VN VN',
  Join: 'VP - - - - - AA AP QP - - VP',
  Lv: '- VO LA LA LA LA - - - AO QO -',
  rNew: '- - - - - - - - - - - -',
  rJoinIn: 'AO AP - - QA - - QO - QP - -',
  rJoinMt: '- - - - - AA - - AO - AP VO',
  rMt: '- - - - - AA - - AO - AP VO',
  rLv: 'LO - - VN VP VP - LO LO VP VP -',
  rLA: 'LO - - VN VP VP - LO LO VP VP -',
  ReDeclare: 'LO - - VN VP VP - LO LO VP VP -',
  periodic: '- - - - - AA - - - - AP -',
  txLAF: 'LO VP VN VN VP VP LO LO LO VP VP -',
};

const TX_TABLE = '- sJ>AA sN>AN sN>QA sJ>QA - sL>VO - - sJ>QA - s>VO'.split(' ');
const TX_LA_TABLE = '-:LO s>AA sN>AN sN>QA sJ>QA sJ -:LO -:LO -:LO sJ>QA sJ>QA -'.split(' ');

function run(state: ApplicantState, event: ApplicantEvent, options: { pointToPoint?: boolean; registrarIn?: boolean } = {}) {
  const machine = new ApplicantMachine({
    pointToPoint: options.pointToPoint ?? true, applicantOnly: false, mode: 'normal',
  });
  seed(machine, state);
  return machine.handle(event, options.registrarIn ?? true);
}

function seed(machine: ApplicantMachine, state: ApplicantState): void {
  (machine as unknown as { current: ApplicantState }).current = state;
}

describe('Table 10-3: next state, one cell at a time', () => {
  for (const [event, row] of Object.entries(NEXT_TABLE)) {
    const cells = row.split(' ');
    STATES.forEach((state, index) => {
      const expected = cells[index] === '-' ? state : cells[index];
      it(`${event} in ${state} gives ${expected}`, () => {
        expect(run(state, event as ApplicantEvent, { pointToPoint: event !== 'rJoinIn' }).state).toBe(expected);
      });
    });
  }
});

describe('Table 10-3: tx! and txLA!', () => {
  STATES.forEach((state, index) => {
    const tx = TX_TABLE[index];
    it(`tx! in ${state}`, () => {
      const [send, next] = tx === '-' ? [undefined, state] : tx.split('>');
      const outcome = run(state, 'tx', { registrarIn: true });
      expect(outcome.send).toBe(send as TransmitAction | undefined);
      expect(outcome.state).toBe(state === 'AN' ? 'QA' : next);
    });

    const txLa = TX_LA_TABLE[index];
    it(`txLA! in ${state}`, () => {
      let send: string | undefined;
      let next: string;
      if (txLa === '-') { send = undefined; next = state; }
      else if (txLa.startsWith('-:')) { send = undefined; next = txLa.slice(2); }
      else if (txLa.includes('>')) { [send, next] = txLa.split('>'); }
      else { send = txLa; next = state; }
      const outcome = run(state, 'txLA');
      expect(outcome.send).toBe(send as TransmitAction | undefined);
      expect(outcome.state).toBe(next);
    });
  });

  it('footnote 8: tx! from AN goes to QA if the Registrar is IN, AA otherwise', () => {
    expect(run('AN', 'tx', { registrarIn: true }).state).toBe('QA');
    expect(run('AN', 'tx', { registrarIn: false }).state).toBe('AA');
  });
});

describe('Table 10-3: footnotes', () => {
  it('4: rJoinIn! is ignored from VO and VP on a point-to-point LAN', () => {
    expect(run('VO', 'rJoinIn', { pointToPoint: true }).state).toBe('VO');
    expect(run('VP', 'rJoinIn', { pointToPoint: true }).state).toBe('VP');
    expect(run('VO', 'rJoinIn', { pointToPoint: false }).state).toBe('AO');
  });

  it('5: rIn! is ignored when the LAN is shared media', () => {
    expect(run('AA', 'rIn', { pointToPoint: false }).state).toBe('AA');
    expect(run('AA', 'rIn', { pointToPoint: true }).state).toBe('QA');
  });

  it('6: a transmit opportunity is requested on entry to VN AN AA LA VP AP LO only', () => {
    expect(run('VO', 'New').requestTransmit).toBe(true);
    expect(run('QA', 'Lv').requestTransmit).toBe(true);
    expect(run('VO', 'Join').requestTransmit).toBe(true);
    expect(run('VO', 'rJoinIn', { pointToPoint: false }).requestTransmit).toBe(false);
  });

  it('1: an Applicant-Only participant goes to VO instead of LO', () => {
    const machine = new ApplicantMachine({ pointToPoint: true, applicantOnly: true, mode: 'normal' });
    expect(machine.handle('rLv', true).state).toBe('VO');
  });

  it('12: a New-Only participant reacts to Begin!, New! and tx! only', () => {
    const machine = new ApplicantMachine({ pointToPoint: true, applicantOnly: false, mode: 'new-only' });
    machine.handle('Join', true);
    expect(machine.state).toBe('VO');
    machine.handle('New', true);
    expect(machine.state).toBe('VN');
    expect(machine.handle('tx', true).send).toBe('sN');
  });

  it('a Non-Participant sends nothing and never moves', () => {
    const machine = new ApplicantMachine({ pointToPoint: true, applicantOnly: false, mode: 'non-participant' });
    expect(machine.handle('New', true)).toMatchObject({ state: 'VO', requestTransmit: false });
  });
});

describe('10.7.6.2 to 10.7.6.5: the AttributeEvent a transmit action carries', () => {
  it('maps sN, sL, and the Registrar-dependent sJ and s', () => {
    expect(attributeEventFor('sN', true)).toBe('new');
    expect(attributeEventFor('sL', false)).toBe('lv');
    expect(attributeEventFor('sJ', true)).toBe('joinIn');
    expect(attributeEventFor('sJ', false)).toBe('joinMt');
    expect(attributeEventFor('s', true)).toBe('in');
    expect(attributeEventFor('s', false)).toBe('mt');
  });
});

describe('Table 10-4: Registrar', () => {
  function registrar(state: RegistrarState, pointToPoint = false): RegistrarMachine {
    const machine = new RegistrarMachine('normal', pointToPoint);
    (machine as unknown as { current: RegistrarState }).current = state;
    return machine;
  }

  it('Begin! leaves every state at MT', () => {
    for (const state of ['IN', 'LV', 'MT'] as const) expect(registrar(state).handle('Begin').state).toBe('MT');
  });

  it('rNew! gives IN with a New indication, and stops the leavetimer from LV', () => {
    expect(registrar('IN').handle('rNew')).toMatchObject({ state: 'IN', indication: 'new' });
    expect(registrar('LV').handle('rNew')).toMatchObject({ state: 'IN', indication: 'new', leavetimer: 'stop' });
    expect(registrar('MT').handle('rNew')).toMatchObject({ state: 'IN', indication: 'new' });
  });

  it('rJoinIn! and rJoinMt!: IN stays IN, LV stops the leavetimer, MT indicates Join', () => {
    for (const event of ['rJoinIn', 'rJoinMt'] as const) {
      expect(registrar('IN').handle(event)).toEqual({ state: 'IN', leavetimer: undefined });
      expect(registrar('LV').handle(event)).toEqual({ state: 'IN', leavetimer: 'stop' });
      expect(registrar('MT').handle(event)).toEqual({ state: 'IN', indication: 'join' });
    }
  });

  it('rLv!, rLA!, txLA! and Re-declare! start the leavetimer from IN and do nothing elsewhere', () => {
    for (const event of ['rLv', 'rLA', 'txLA', 'ReDeclare'] as const) {
      expect(registrar('IN').handle(event)).toEqual({ state: 'LV', leavetimer: 'start' });
      expect(registrar('LV').handle(event)).toEqual({ state: 'LV' });
      expect(registrar('MT').handle(event)).toEqual({ state: 'MT' });
    }
  });

  it('Flush! deregisters from IN and LV with a Lv indication, MT stays', () => {
    expect(registrar('IN').handle('Flush')).toMatchObject({ state: 'MT', indication: 'lv' });
    expect(registrar('LV').handle('Flush')).toMatchObject({ state: 'MT', indication: 'lv' });
    expect(registrar('MT').handle('Flush')).toEqual({ state: 'MT', indication: undefined });
  });

  it('leavetimer! deregisters from LV only', () => {
    expect(registrar('LV').handle('leavetimer')).toMatchObject({ state: 'MT', indication: 'lv' });
    expect(registrar('IN').handle('leavetimer')).toEqual({ state: 'IN' });
    expect(registrar('MT').handle('leavetimer')).toEqual({ state: 'MT' });
  });

  it('footnote a: on a point-to-point LAN rLv! skips the leavetimer', () => {
    expect(registrar('IN', true).handle('rLv')).toEqual({ state: 'MT', indication: 'lv' });
  });
});

describe('10.7.2: Registrar Administrative Controls', () => {
  it('Registration Fixed (New ignored) stays IN and ignores every message', () => {
    const machine = new RegistrarMachine('fixed-new-ignored');
    expect(machine.state).toBe('IN');
    expect(machine.handle('rLv')).toEqual({ state: 'IN' });
    expect(machine.handle('rNew')).toEqual({ state: 'IN' });
  });

  it('Registration Fixed (New propagated) stays IN but accepts New', () => {
    const machine = new RegistrarMachine('fixed-new-propagated');
    expect(machine.handle('rLv')).toEqual({ state: 'IN' });
    expect(machine.handle('rNew')).toMatchObject({ state: 'IN', indication: 'new' });
  });

  it('Registration Forbidden stays MT and ignores every message', () => {
    const machine = new RegistrarMachine('forbidden');
    expect(machine.state).toBe('MT');
    expect(machine.handle('rJoinIn')).toEqual({ state: 'MT' });
    expect(machine.handle('rNew')).toEqual({ state: 'MT' });
  });
});

describe('Table 10-5 and Table 10-7', () => {
  it('Begin! and rLA! start the timer and go Passive; leavealltimer! goes Active and asks to transmit; tx! from Active sends LeaveAll', () => {
    const machine = new LeaveAllMachine();
    expect(machine.handle('Begin')).toMatchObject({ state: 'Passive', startTimer: true });
    expect(machine.handle('leavealltimer')).toMatchObject({ state: 'Active', startTimer: true, requestTransmit: true });
    expect(machine.handle('tx')).toMatchObject({ state: 'Passive', sendLeaveAll: true });
    expect(machine.handle('tx')).toMatchObject({ state: 'Passive', sendLeaveAll: false });
    machine.handle('leavealltimer');
    expect(machine.handle('rLA')).toMatchObject({ state: 'Passive', startTimer: true });
  });

  it('defaults: JoinTime 20 cs, LeaveTime within 60-100 cs, LeaveAllTime 1000 cs', () => {
    expect(MRP_TIMERS_CENTISECONDS.joinTime).toBe(20);
    expect(MRP_TIMERS_CENTISECONDS.leaveTime).toBeGreaterThanOrEqual(60);
    expect(MRP_TIMERS_CENTISECONDS.leaveTime).toBeLessThanOrEqual(100);
    expect(MRP_TIMERS_CENTISECONDS.leaveAllTime).toBe(1000);
  });

  it('10.7.4.3: the Leave All period is between LeaveAllTime and 1.5 times it', () => {
    expect(leaveAllInterval(1000, () => 0)).toBe(1000);
    expect(leaveAllInterval(1000, () => 0.999)).toBeLessThan(1500);
    expect(leaveAllInterval(1000, () => 0.5)).toBe(1250);
  });
});
