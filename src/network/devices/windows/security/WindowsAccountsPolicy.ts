/**
 * WindowsAccountsPolicy — mutable per-machine LSA account policy.
 *
 * Mirrors what `net accounts /<flag>:<value>` adjusts on a real
 * Windows host: minimum/maximum password age, password length, history,
 * lockout threshold / duration / observation window, force-logoff.
 * Rendered by `net accounts` (no args) exactly the way the real CLI
 * prints the policy.
 */

export interface WindowsAccountsPolicyState {
  forceLogoffMinutes: number;        // /forcelogoff
  minPasswordAge: number;            // /minpwage  (days)
  maxPasswordAge: number;            // /maxpwage  (days, -1 = unlimited)
  minPasswordLength: number;         // /minpwlen
  passwordHistoryLength: number;     // /uniquepw
  lockoutThreshold: number;          // /lockoutthreshold (0 = never)
  lockoutDurationMinutes: number;    // /lockoutduration
  lockoutWindowMinutes: number;      // /lockoutwindow
  computerRole: 'WORKSTATION' | 'SERVER' | 'DOMAIN CONTROLLER';
}

export class WindowsAccountsPolicy {
  private state: WindowsAccountsPolicyState = {
    forceLogoffMinutes: -1,
    minPasswordAge: 0,
    maxPasswordAge: 42,
    minPasswordLength: 0,
    passwordHistoryLength: 0,
    lockoutThreshold: 0,
    lockoutDurationMinutes: 30,
    lockoutWindowMinutes: 30,
    computerRole: 'WORKSTATION',
  };

  snapshot(): Readonly<WindowsAccountsPolicyState> {
    return Object.freeze({ ...this.state });
  }

  apply(flag: string, raw: string): string {
    const value = raw.trim();
    const numOrNever = (v: string): number => v.toLowerCase() === 'never' ? -1 : Number.parseInt(v, 10);
    switch (flag.toLowerCase()) {
      case 'forcelogoff':       this.state.forceLogoffMinutes = numOrNever(value); break;
      case 'minpwage':          this.state.minPasswordAge = Number.parseInt(value, 10); break;
      case 'maxpwage':          this.state.maxPasswordAge = numOrNever(value); break;
      case 'minpwlen':          this.state.minPasswordLength = Number.parseInt(value, 10); break;
      case 'uniquepw':          this.state.passwordHistoryLength = Number.parseInt(value, 10); break;
      case 'lockoutthreshold':  this.state.lockoutThreshold = numOrNever(value); break;
      case 'lockoutduration':   this.state.lockoutDurationMinutes = Number.parseInt(value, 10); break;
      case 'lockoutwindow':     this.state.lockoutWindowMinutes = Number.parseInt(value, 10); break;
      default: return `Invalid policy: ${flag}`;
    }
    return '';
  }

  /** Render the table `net accounts` prints with no args. */
  render(): string {
    const s = this.state;
    const never = (n: number) => n < 0 ? 'Never' : String(n);
    return [
      `Force user logoff how long after time expires?:       ${never(s.forceLogoffMinutes)}`,
      `Minimum password age (days):                          ${s.minPasswordAge}`,
      `Maximum password age (days):                          ${never(s.maxPasswordAge)}`,
      `Minimum password length:                              ${s.minPasswordLength}`,
      `Length of password history maintained:                ${s.passwordHistoryLength === 0 ? 'None' : s.passwordHistoryLength}`,
      `Lockout threshold:                                    ${s.lockoutThreshold === 0 ? 'Never' : s.lockoutThreshold}`,
      `Lockout duration (minutes):                           ${s.lockoutDurationMinutes}`,
      `Lockout observation window (minutes):                 ${s.lockoutWindowMinutes}`,
      `Computer role:                                        ${s.computerRole}`,
      `The command completed successfully.`,
    ].join('\n');
  }
}
