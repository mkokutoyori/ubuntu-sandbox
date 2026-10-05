import type { LinuxPam, PamTransactionOptions } from './LinuxPam';
import type { LinuxPamHost } from './PamLinuxHost';
import { PamFlag, PamReturn } from './PamReturnCode';
import { PamTransaction, runPamSync, type PamConversation } from './PamTransaction';

export interface PamSessionSubject {
  readonly user: string;
  readonly ruser?: string;
  readonly rhost?: string;
  readonly tty?: string;
}

export class PamServiceSession {
  readonly transaction: PamTransaction<LinuxPamHost>;
  readonly user: string;
  private readonly loginMessages: string[] = [];
  maxTriesReached = false;
  sessionOpen = false;
  sessionMessages: string[] = [];

  constructor(pam: LinuxPam, service: string, options: PamTransactionOptions, subject: PamSessionSubject) {
    this.user = subject.user;
    this.transaction = pam.begin(service, options);
    this.transaction.handle.user = subject.user;
    if (subject.ruser !== undefined) this.transaction.handle.ruser = subject.ruser;
    if (subject.rhost !== undefined) this.transaction.handle.rhost = subject.rhost;
    if (subject.tty !== undefined) this.transaction.handle.tty = subject.tty;
  }

  private collect(text: string): void {
    if (text.length > 0) this.loginMessages.push(`${text}\n`);
  }

  conversation(answers: () => string | null): PamConversation {
    return (request) => request.map((message) => {
      if (message.style === 'prompt-echo-off') return { text: answers() };
      if (message.style === 'error' || message.style === 'info') {
        this.collect(message.text);
        return { text: '' };
      }
      return { text: null };
    });
  }

  authenticate(answers: () => string | null, permitEmptyPasswords: boolean): number {
    const flags = permitEmptyPasswords ? 0 : PamFlag.DISALLOW_NULL_AUTHTOK;
    const code = runPamSync(this.transaction.authenticate(flags), this.conversation(answers));
    if (code === PamReturn.MAXTRIES) this.maxTriesReached = true;
    return code;
  }

  account(): number {
    return runPamSync(this.transaction.acctMgmt(0), this.conversation(() => null));
  }

  takeLoginMessages(): string[] {
    return this.loginMessages.splice(0);
  }

  openSession(): void {
    const conversation = this.conversation(() => null);
    runPamSync(this.transaction.setcred(PamFlag.ESTABLISH_CRED), conversation);
    this.takeLoginMessages();
    const code = runPamSync(this.transaction.openSession(0), conversation);
    this.sessionOpen = code === PamReturn.SUCCESS;
    this.sessionMessages = this.takeLoginMessages();
  }

  closeSession(): void {
    if (!this.sessionOpen) return;
    const conversation = this.conversation(() => null);
    runPamSync(this.transaction.closeSession(0), conversation);
    runPamSync(this.transaction.setcred(PamFlag.DELETE_CRED), conversation);
    this.takeLoginMessages();
    this.sessionOpen = false;
  }

  end(): void {
    this.transaction.end();
  }
}
