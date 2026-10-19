export const APPLICANT_STATES = ['VO', 'VP', 'VN', 'AN', 'AA', 'QA', 'LA', 'AO', 'QO', 'AP', 'QP', 'LO'] as const;
export type ApplicantState = (typeof APPLICANT_STATES)[number];

export type ApplicantEvent =
  | 'Begin' | 'New' | 'Join' | 'Lv' | 'rNew' | 'rJoinIn' | 'rIn' | 'rJoinMt' | 'rMt'
  | 'rLv' | 'rLA' | 'ReDeclare' | 'periodic' | 'tx' | 'txLA' | 'txLAF';

export type TransmitAction = 's' | 'sJ' | 'sN' | 'sL';

export interface ApplicantParticipation {
  readonly pointToPoint: boolean;
  readonly applicantOnly: boolean;
  readonly mode: 'normal' | 'new-only' | 'non-participant';
}

export const DEFAULT_PARTICIPATION: ApplicantParticipation = Object.freeze({
  pointToPoint: false, applicantOnly: false, mode: 'normal' as const,
});

export interface ApplicantOutcome {
  readonly state: ApplicantState;
  readonly send?: TransmitAction;
  readonly requestTransmit: boolean;
}

type Row = readonly (ApplicantState | undefined)[];

const ROW = (cells: readonly (ApplicantState | '-')[]): Row =>
  cells.map(cell => (cell === '-' ? undefined : cell));

const NEXT: Readonly<Record<string, Row>> = Object.freeze({
  Begin: ROW(['VO', 'VO', 'VO', 'VO', 'VO', 'VO', 'VO', 'VO', 'VO', 'VO', 'VO', 'VO']),
  New: ROW(['VN', 'VN', '-', '-', 'VN', 'VN', 'VN', 'VN', 'VN', 'VN', 'VN', 'VN']),
  Join: ROW(['VP', '-', '-', '-', '-', '-', 'AA', 'AP', 'QP', '-', '-', 'VP']),
  Lv: ROW(['-', 'VO', 'LA', 'LA', 'LA', 'LA', '-', '-', '-', 'AO', 'QO', '-']),
  rNew: ROW(['-', '-', '-', '-', '-', '-', '-', '-', '-', '-', '-', '-']),
  rJoinIn: ROW(['AO', 'AP', '-', '-', 'QA', '-', '-', 'QO', '-', 'QP', '-', '-']),
  rIn: ROW(['-', '-', '-', '-', 'QA', '-', '-', '-', '-', '-', '-', '-']),
  rMt: ROW(['-', '-', '-', '-', '-', 'AA', '-', '-', 'AO', '-', 'AP', 'VO']),
  rLv: ROW(['LO', '-', '-', 'VN', 'VP', 'VP', '-', 'LO', 'LO', 'VP', 'VP', '-']),
  periodic: ROW(['-', '-', '-', '-', '-', 'AA', '-', '-', '-', '-', 'AP', '-']),
  txLAF: ROW(['LO', 'VP', 'VN', 'VN', 'VP', 'VP', 'LO', 'LO', 'LO', 'VP', 'VP', '-']),
});

interface Transmission { readonly send?: TransmitAction; readonly next?: ApplicantState }

const T = (send: TransmitAction | undefined, next?: ApplicantState): Transmission => ({ send, next });

const TX: readonly Transmission[] = Object.freeze([
  T(undefined), T('sJ', 'AA'), T('sN', 'AN'), T('sN', 'QA'), T('sJ', 'QA'), T(undefined),
  T('sL', 'VO'), T(undefined), T(undefined), T('sJ', 'QA'), T(undefined), T('s', 'VO'),
]);

const TX_LEAVE_ALL: readonly Transmission[] = Object.freeze([
  T(undefined, 'LO'), T('s', 'AA'), T('sN', 'AN'), T('sN', 'QA'), T('sJ', 'QA'), T('sJ'),
  T(undefined, 'LO'), T(undefined, 'LO'), T(undefined, 'LO'), T('sJ', 'QA'), T('sJ', 'QA'), T(undefined),
]);

const REQUESTS_TRANSMIT: ReadonlySet<ApplicantState> = new Set(['VN', 'AN', 'AA', 'LA', 'VP', 'AP', 'LO']);

const NEW_ONLY_EVENTS: ReadonlySet<ApplicantEvent> = new Set(['Begin', 'New', 'tx']);

const ROW_OF: Readonly<Record<ApplicantEvent, string | undefined>> = Object.freeze({
  Begin: 'Begin', New: 'New', Join: 'Join', Lv: 'Lv', rNew: 'rNew', rJoinIn: 'rJoinIn', rIn: 'rIn',
  rJoinMt: 'rMt', rMt: 'rMt', rLv: 'rLv', rLA: 'rLv', ReDeclare: 'rLv', periodic: 'periodic',
  tx: undefined, txLA: undefined, txLAF: 'txLAF',
});

export class ApplicantMachine {
  private current: ApplicantState = 'VO';

  constructor(private readonly participation: ApplicantParticipation = DEFAULT_PARTICIPATION) {}

  get state(): ApplicantState { return this.current; }

  handle(event: ApplicantEvent, registrarIn: boolean): ApplicantOutcome {
    const before = this.current;
    if (this.participation.mode === 'non-participant' && event !== 'Begin') {
      return { state: before, requestTransmit: false };
    }
    if (this.participation.mode === 'new-only' && !NEW_ONLY_EVENTS.has(event)) {
      return { state: before, requestTransmit: false };
    }
    if (this.participation.applicantOnly && (event === 'txLA' || event === 'txLAF')) {
      return { state: before, requestTransmit: false };
    }

    const index = APPLICANT_STATES.indexOf(before);
    let send: TransmitAction | undefined;
    let next: ApplicantState | undefined;

    if (event === 'tx' || event === 'txLA') {
      const cell = (event === 'tx' ? TX : TX_LEAVE_ALL)[index];
      if (this.participation.mode === 'new-only' && cell.send !== undefined && cell.send !== 'sN') {
        send = undefined;
        next = cell.next === 'AN' || cell.next === 'QA' ? cell.next : undefined;
      } else {
        send = cell.send;
        next = cell.next;
      }
      if (event === 'tx' && before === 'AN') next = registrarIn ? 'QA' : 'AA';
    } else {
      next = NEXT[ROW_OF[event] as string][index];
      if (event === 'rJoinIn' && this.participation.pointToPoint
        && (before === 'VO' || before === 'VP')) {
        next = undefined;
      }
      if (event === 'rIn' && !this.participation.pointToPoint) next = undefined;
    }

    if (next !== undefined) {
      this.current = this.participation.applicantOnly && next === 'LO' ? 'VO' : next;
    }
    return {
      state: this.current,
      send,
      requestTransmit: next !== undefined && REQUESTS_TRANSMIT.has(next),
    };
  }
}

export function attributeEventFor(
  action: TransmitAction, registrarIn: boolean,
): 'new' | 'joinIn' | 'in' | 'joinMt' | 'mt' | 'lv' {
  if (action === 'sN') return 'new';
  if (action === 'sL') return 'lv';
  if (action === 'sJ') return registrarIn ? 'joinIn' : 'joinMt';
  return registrarIn ? 'in' : 'mt';
}
