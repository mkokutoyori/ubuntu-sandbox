/**
 * ISshInteractionHandler — abstracts user-facing prompts (host-key, password,
 * warnings, info messages). Tests can inject a silent implementation.
 *
 * Reference: DESIGN-SSH-SFTP.md section 6.
 */

import type { SshFingerprint } from '../SshFingerprint';

/**
 * Possible answers to the host-key prompt.
 * Per BRD SSH-01-R3/R6: the user may type yes / no / a fingerprint string.
 * Returning the raw fingerprint lets SshSession compare it against the
 * received host key without persisting an unwanted known_hosts entry.
 */
export type HostKeyResponse =
  | { kind: 'yes' }
  | { kind: 'no' }
  | { kind: 'fingerprint'; value: string };

export const hostKeyYes = (): HostKeyResponse => ({ kind: 'yes' });
export const hostKeyNo = (): HostKeyResponse => ({ kind: 'no' });
export const hostKeyFingerprint = (value: string): HostKeyResponse => ({
  kind: 'fingerprint',
  value,
});

export interface SshConnectionInfo {
  readonly host: string;
  readonly user: string;
  readonly port: number;
  readonly sessionId: string;
  readonly hostFingerprint: SshFingerprint;
  readonly connectedAt: number;
}

export interface ISshInteractionHandler {
  promptHostKeyConfirmation(
    host: string,
    fingerprint: string,
  ): Promise<HostKeyResponse>;
  promptPassword(user: string, host: string): Promise<string>;
  showWarning(message: string): void;
  showInfo(message: string): void;
  onConnected(info: SshConnectionInfo): void;
  /**
   * Surface a single-failed-attempt notice between two password prompts —
   * matches OpenSSH's "Permission denied, please try again." line. The
   * final terminal "Permission denied (publickey,password)." message is
   * emitted separately by SshSession.doAuthenticate after all attempts.
   *
   * Default implementations re-route the line through showWarning() so
   * existing handlers keep working without overriding.
   */
  showAuthFailure?(user: string, host: string): void;
}

/**
 * Silent handler — used in tests. Auto-accepts host keys, returns a static
 * password. Never writes to a terminal.
 */
export class SilentSshInteractionHandler implements ISshInteractionHandler {
  constructor(
    private readonly password: string = '',
    private readonly autoAccept: boolean = true,
  ) {}

  async promptHostKeyConfirmation(): Promise<HostKeyResponse> {
    return this.autoAccept ? hostKeyYes() : hostKeyNo();
  }

  async promptPassword(): Promise<string> {
    return this.password;
  }

  showWarning(_message: string): void {
    /* silent */
  }

  showInfo(_message: string): void {
    /* silent */
  }

  onConnected(_info: SshConnectionInfo): void {
    /* silent */
  }

  showAuthFailure(_user: string, _host: string): void {
    /* silent */
  }
}
