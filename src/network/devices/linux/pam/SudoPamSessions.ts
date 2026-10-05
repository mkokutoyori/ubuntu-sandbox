import type { LinuxPam } from './LinuxPam';
import type { PamCaller } from './PamLinuxHost';
import { PamServiceSession } from './PamServiceSession';
import { PamReturn } from './PamReturnCode';

const SUDO_SERVICE = 'sudo';
const SUDO_TTY = '/dev/pts/0';
const NO_SYSLOG_PID = 0;

export type SudoEntry =
  | { readonly ok: true; readonly begin: (runAs: string) => void; readonly close: () => void }
  | { readonly ok: false; readonly stage: 'authentication' | 'account'; readonly messages: string };

export class SudoPamSessions {
  private held: PamServiceSession | null = null;

  constructor(
    private readonly pam: LinuxPam,
    private readonly caller: () => PamCaller,
  ) {}

  private open(user: string): PamServiceSession {
    return new PamServiceSession(
      this.pam,
      SUDO_SERVICE,
      { caller: this.caller(), identity: { tag: 'sudo', pid: NO_SYSLOG_PID } },
      { user, ruser: user, tty: SUDO_TTY },
    );
  }

  authenticateAttempt(user: string, password: string): boolean {
    if (this.held === null || this.held.user !== user) {
      this.held?.end();
      this.held = this.open(user);
    }
    return this.held.authenticate(() => password, true) === PamReturn.SUCCESS;
  }

  abandonAuthentication(): void {
    this.held?.end();
    this.held = null;
  }

  enter(invoker: string, pipedPassword: string | null): SudoEntry {
    let session = this.held !== null && this.held.user === invoker ? this.held : null;
    this.held = null;
    if (pipedPassword !== null) {
      session?.end();
      session = this.open(invoker);
      if (session.authenticate(() => pipedPassword, true) !== PamReturn.SUCCESS) {
        const messages = session.takeLoginMessages().join('');
        session.end();
        return { ok: false, stage: 'authentication', messages };
      }
    }
    const transaction = session ?? this.open(invoker);
    if (transaction.account() !== PamReturn.SUCCESS) {
      const messages = transaction.takeLoginMessages().join('');
      transaction.end();
      return { ok: false, stage: 'account', messages };
    }
    transaction.takeLoginMessages();
    return {
      ok: true,
      begin: (runAs) => {
        transaction.transaction.handle.user = runAs;
        transaction.openSession();
      },
      close: () => {
        transaction.closeSession();
        transaction.end();
      },
    };
  }
}
