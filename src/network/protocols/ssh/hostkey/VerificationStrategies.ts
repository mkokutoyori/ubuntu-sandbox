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
} from './IHostKeyVerificationStrategy';

export class AskVerificationStrategy implements IHostKeyVerificationStrategy {
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
    return rejectChangedKey(host);
  }
}

export class StrictVerificationStrategy implements IHostKeyVerificationStrategy {
  verify(
    host: string,
    key: SshHostKey,
    store: KnownHostsStore,
  ): VerificationDecision {
    const known = store.get(host);
    if (!known) return { action: 'refuse_unknown', host };
    if (known.matches(key)) return { action: 'accept_silent' };
    return rejectChangedKey(host);
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
    return rejectChangedKey(host);
  }
}

export class NoVerificationStrategy implements IHostKeyVerificationStrategy {
  verify(
    host: string,
    _key: SshHostKey,
    store: KnownHostsStore,
  ): VerificationDecision {
    return store.get(host) ? { action: 'accept_silent' } : { action: 'accept_and_save' };
  }
}

export function createVerificationStrategy(
  mode: StrictHostKeyChecking,
): IHostKeyVerificationStrategy {
  switch (mode) {
    case 'yes':
      return new StrictVerificationStrategy();
    case 'ask':
      return new AskVerificationStrategy();
    case 'no':
      return new NoVerificationStrategy();
    case 'accept-new':
      return new AcceptNewVerificationStrategy();
  }
}

function rejectChangedKey(host: string): VerificationDecision {
  return { action: 'reject', reason: `host key for ${host} has changed` };
}
