/**
 * Concrete host key verification strategies + factory.
 *
 * Reference: DESIGN-SSH-SFTP.md section 5.
 */

import type { StrictHostKeyChecking } from '../SshConnectOptions';
import type { SshHostKey } from '../SshHostKey';
import type { KnownHostsStore } from './KnownHostsStore';
import {
  type IHostKeyVerificationStrategy,
  type VerificationDecision,
  buildHostKeyChangedWarning,
} from './IHostKeyVerificationStrategy';

export class StrictVerificationStrategy implements IHostKeyVerificationStrategy {
  verify(
    host: string,
    key: SshHostKey,
    store: KnownHostsStore,
  ): VerificationDecision {
    const known = store.get(host);
    if (!known) {
      return {
        action: 'prompt',
        fingerprint: key.fingerprint.toString(),
        host,
      };
    }
    if (known.matches(key)) return { action: 'accept_silent' };
    return rejectChangedKey(host, known, key);
  }
}

export class AcceptNewVerificationStrategy
  implements IHostKeyVerificationStrategy
{
  verify(
    host: string,
    key: SshHostKey,
    store: KnownHostsStore,
  ): VerificationDecision {
    const known = store.get(host);
    if (!known) return { action: 'accept_and_save' };
    if (known.matches(key)) return { action: 'accept_silent' };
    return rejectChangedKey(host, known, key);
  }
}

export class NoVerificationStrategy implements IHostKeyVerificationStrategy {
  verify(): VerificationDecision {
    return { action: 'accept_silent' };
  }
}

export function createVerificationStrategy(
  mode: StrictHostKeyChecking,
): IHostKeyVerificationStrategy {
  switch (mode) {
    case 'yes':
      return new StrictVerificationStrategy();
    case 'no':
      return new NoVerificationStrategy();
    case 'accept-new':
      return new AcceptNewVerificationStrategy();
  }
}

function rejectChangedKey(
  host: string,
  expected: SshHostKey,
  got: SshHostKey,
): VerificationDecision {
  const expectedFp = expected.fingerprint.toString();
  const actualFp = got.fingerprint.toString();
  return {
    action: 'reject',
    reason: `host key for ${host} has changed`,
    warningBlock: buildHostKeyChangedWarning(host, expectedFp, actualFp),
  };
}
