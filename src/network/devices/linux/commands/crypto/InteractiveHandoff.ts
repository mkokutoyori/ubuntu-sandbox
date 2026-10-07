import type { TlsPeerChannelPort } from '@/network/crypto/openssl/OpenSslHost';

export interface TlsClientHandoff {
  readonly kind: 'tls-client';
  readonly channel: TlsPeerChannelPort;
  readonly version: string;
}
