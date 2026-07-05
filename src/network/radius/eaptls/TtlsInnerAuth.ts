/**
 * RFC 5281 EAP-TTLS inner authentication — simplified to plaintext
 * username/password ("TTLS-PAP", the most common real-world inner method)
 * carried as a JSON credentials message inside the tunnel, rather than
 * real Diameter AVPs (RFC 5281 §9). The tunnel already protects this from
 * on-the-wire eavesdropping in the same sense every other simulated-crypto
 * layer in this project does.
 */
import { utf8ToBytes, bytesToUtf8 } from '@/crypto/encoding';
import type { InnerAuthServer, InnerAuthPeer } from './InnerAuth';
import type { RadiusUser } from '../types';

interface TtlsCredentials {
  readonly username: string;
  readonly password: string;
}

const CREDENTIALS_PROMPT = 'send-credentials';

export class TtlsPapInnerAuthServer implements InnerAuthServer {
  constructor(private readonly lookupUser: (username: string) => RadiusUser | undefined) {}

  start(): Uint8Array {
    return utf8ToBytes(CREDENTIALS_PROMPT);
  }

  handle(incoming: Uint8Array): { next: Uint8Array | null; result: 'accept' | 'reject' | null } {
    try {
      const creds = JSON.parse(bytesToUtf8(incoming)) as TtlsCredentials;
      const user = this.lookupUser(creds.username);
      const accepted = !!user && user.password === creds.password;
      return { next: null, result: accepted ? 'accept' : 'reject' };
    } catch {
      return { next: null, result: 'reject' };
    }
  }
}

export class TtlsPapInnerAuthPeer implements InnerAuthPeer {
  constructor(private readonly username: string, private readonly password: string) {}

  handle(_incoming: Uint8Array): { next: Uint8Array; result: 'success' | 'failure' | null } {
    const creds: TtlsCredentials = { username: this.username, password: this.password };
    return { next: utf8ToBytes(JSON.stringify(creds)), result: null };
  }
}
