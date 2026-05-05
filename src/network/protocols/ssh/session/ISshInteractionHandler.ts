/**
 * ISshInteractionHandler — abstracts user-facing prompts (host-key, password,
 * warnings, info messages). Tests can inject a silent implementation.
 *
 * Reference: DESIGN-SSH-SFTP.md section 6.
 */

import type { SshFingerprint } from '../SshFingerprint';

export type HostKeyResponse = 'yes' | 'no';

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
    return this.autoAccept ? 'yes' : 'no';
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
}
