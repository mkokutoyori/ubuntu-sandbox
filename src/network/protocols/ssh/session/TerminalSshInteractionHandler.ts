/**
 * TerminalSshInteractionHandler — Adapter that bridges ISshInteractionHandler
 * to a terminal-style I/O surface.
 *
 * The handler is intentionally decoupled from any concrete TerminalSession.
 * The caller must provide a small ITerminalIO surface (writeLine + a way to
 * collect a single input). This keeps the SSH layer independent from the UI
 * stack while still letting LinuxTerminalSession plug in via a thin wrapper.
 *
 * Reference: DESIGN-SSH-SFTP.md section 6.
 */

import {
  hostKeyFingerprint,
  hostKeyNo,
  hostKeyYes,
  type HostKeyResponse,
  type ISshInteractionHandler,
  type SshConnectionInfo,
} from './ISshInteractionHandler';

/**
 * Minimal terminal contract the handler depends on. A LinuxTerminalSession
 * adapter implements this by forwarding to addLine() and collecting input
 * via its existing inputMode pipeline.
 */
export interface ITerminalIO {
  writeLine(text: string, type?: 'normal' | 'warning' | 'info' | 'prompt'): void;
  /**
   * Display a prompt and resolve with the user's answer.
   * `secret = true` instructs the UI to mask input (password mode).
   */
  readInput(prompt: string, secret: boolean): Promise<string>;
}

export class TerminalSshInteractionHandler implements ISshInteractionHandler {
  constructor(private readonly io: ITerminalIO) {}

  async promptHostKeyConfirmation(
    host: string,
    fingerprint: string,
  ): Promise<HostKeyResponse> {
    this.io.writeLine(
      `The authenticity of host '${host}' can't be established.`,
    );
    this.io.writeLine(`ED25519 key fingerprint is ${fingerprint}.`);
    this.io.writeLine(
      `This key is not known by any other names.`,
    );
    const answer = (
      await this.io.readInput(
        `Are you sure you want to continue connecting (yes/no/[fingerprint])? `,
        false,
      )
    ).trim();
    const lowered = answer.toLowerCase();
    if (lowered === 'yes' || lowered === 'y') return hostKeyYes();
    if (lowered === 'no' || lowered === 'n' || lowered === '') return hostKeyNo();
    // Anything else is interpreted as a fingerprint to compare against.
    return hostKeyFingerprint(answer);
  }

  async promptPassword(user: string, host: string): Promise<string> {
    return this.io.readInput(`${user}@${host}'s password: `, true);
  }

  showWarning(message: string): void {
    for (const line of message.split('\n')) {
      this.io.writeLine(line, 'warning');
    }
  }

  showInfo(message: string): void {
    this.io.writeLine(message, 'info');
  }

  // Connection details are shown via MOTD and lastlog in the caller;
  // printing a separate "Connected to…" line here would not match real OpenSSH.
  onConnected(_info: SshConnectionInfo): void {}
}

/**
 * Convenience factory: build an ITerminalIO surface from an object that
 * already exposes the addLine() / readInput primitives. Callers can also
 * pass any other shim that conforms to ITerminalIO.
 */
export const createTerminalIO = (
  writeLine: ITerminalIO['writeLine'],
  readInput: ITerminalIO['readInput'],
): ITerminalIO => ({ writeLine, readInput });
