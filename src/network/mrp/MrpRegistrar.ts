export type RegistrarState = 'IN' | 'LV' | 'MT';

export type RegistrarEvent =
  | 'Begin' | 'rNew' | 'rJoinIn' | 'rJoinMt' | 'rLv' | 'rLA' | 'txLA' | 'ReDeclare' | 'Flush' | 'leavetimer';

export type RegistrarAdminControl =
  | 'normal' | 'fixed-new-ignored' | 'fixed-new-propagated' | 'forbidden';

export interface RegistrarOutcome {
  readonly state: RegistrarState;
  readonly indication?: 'new' | 'join' | 'lv';
  readonly leavetimer?: 'start' | 'stop';
}

export class RegistrarMachine {
  private current: RegistrarState = 'MT';

  constructor(
    private readonly control: RegistrarAdminControl = 'normal',
    private readonly pointToPoint = false,
  ) {
    if (control === 'fixed-new-ignored' || control === 'fixed-new-propagated') this.current = 'IN';
  }

  get state(): RegistrarState { return this.current; }

  get isRegistered(): boolean { return this.current !== 'MT'; }

  handle(event: RegistrarEvent): RegistrarOutcome {
    if (this.control === 'fixed-new-ignored' || this.control === 'forbidden') return { state: this.current };
    if (this.control === 'fixed-new-propagated' && event !== 'rNew') return { state: this.current };

    const before = this.current;
    switch (event) {
      case 'Begin':
        this.current = 'MT';
        return { state: this.current };
      case 'rNew':
        this.current = 'IN';
        return { state: 'IN', indication: 'new', leavetimer: before === 'LV' ? 'stop' : undefined };
      case 'rJoinIn':
      case 'rJoinMt':
        this.current = 'IN';
        if (before === 'MT') return { state: 'IN', indication: 'join' };
        return { state: 'IN', leavetimer: before === 'LV' ? 'stop' : undefined };
      case 'rLv':
      case 'rLA':
      case 'txLA':
      case 'ReDeclare':
        if (before !== 'IN') return { state: before };
        if (event === 'rLv' && this.pointToPoint) {
          this.current = 'MT';
          return { state: 'MT', indication: 'lv' };
        }
        this.current = 'LV';
        return { state: 'LV', leavetimer: 'start' };
      case 'Flush':
        this.current = 'MT';
        return { state: 'MT', indication: before === 'MT' ? undefined : 'lv' };
      case 'leavetimer':
        if (before !== 'LV') return { state: before };
        this.current = 'MT';
        return { state: 'MT', indication: 'lv' };
    }
  }
}
