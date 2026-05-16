/**
 * SshSessionState — discriminated union representing the connection lifecycle.
 *
 * Pure data: transitions create a new value rather than mutating in place.
 *
 * Reference: DESIGN-SSH-SFTP.md section 6.
 */

export type SshSessionState =
  | { kind: 'idle' }
  | { kind: 'connecting'; host: string; port: number }
  | { kind: 'verifying_host_key'; host: string; fingerprint: string }
  | {
      kind: 'authenticating';
      user: string;
      host: string;
      attemptsLeft: number;
    }
  | { kind: 'connected'; user: string; host: string; sessionId: string }
  | { kind: 'disconnected'; reason: string };

export const idle = (): SshSessionState => ({ kind: 'idle' });
export const connecting = (host: string, port: number): SshSessionState => ({
  kind: 'connecting',
  host,
  port,
});
export const verifyingHostKey = (
  host: string,
  fingerprint: string,
): SshSessionState => ({ kind: 'verifying_host_key', host, fingerprint });
export const authenticating = (
  user: string,
  host: string,
  attemptsLeft: number,
): SshSessionState => ({
  kind: 'authenticating',
  user,
  host,
  attemptsLeft,
});
export const connected = (
  user: string,
  host: string,
  sessionId: string,
): SshSessionState => ({ kind: 'connected', user, host, sessionId });
export const disconnected = (reason: string): SshSessionState => ({
  kind: 'disconnected',
  reason,
});
