/**
 * Host key verification strategy + decision discriminated union.
 *
 * Reference: DESIGN-SSH-SFTP.md section 5.
 */

import type { SshHostKey } from '../SshHostKey';
import type { KnownHostsStore } from './KnownHostsStore';

export type VerificationDecision =
  | { action: 'accept_silent' }
  | { action: 'accept_and_save' }
  | { action: 'prompt'; fingerprint: string; host: string }
  | { action: 'reject'; reason: string; warningBlock: string };

export interface IHostKeyVerificationStrategy {
  verify(
    host: string,
    key: SshHostKey,
    store: KnownHostsStore,
  ): VerificationDecision;
}

export function buildHostKeyChangedWarning(
  host: string,
  expectedFp: string,
  actualFp: string,
): string {
  return [
    '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
    '@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @',
    '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
    'IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!',
    `Someone could be eavesdropping on you right now (man-in-the-middle attack)!`,
    `It is also possible that a host key has just been changed.`,
    `The fingerprint for the host key sent by the remote host is`,
    actualFp,
    `Please contact your system administrator.`,
    `Add correct host key in known_hosts to get rid of this message.`,
    `Offending key for ${host}: ${expectedFp}`,
    `Host key verification failed.`,
  ].join('\n');
}
