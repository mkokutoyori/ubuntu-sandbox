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
  | { action: 'refuse_unknown'; host: string }
  | { action: 'reject'; reason: string };

export interface IHostKeyVerificationStrategy {
  verify(
    host: string,
    key: SshHostKey,
    store: KnownHostsStore,
  ): VerificationDecision;
}
