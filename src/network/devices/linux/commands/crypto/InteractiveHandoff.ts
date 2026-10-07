import type { TlsPeerChannelPort, TlsStreamServerPort } from '@/network/crypto/openssl/OpenSslHost';

export interface TlsClientHandoff {
  readonly kind: 'tls-client';
  readonly channel: TlsPeerChannelPort;
  readonly version: string;
}

export interface TlsServerHandoff {
  readonly kind: 'tls-server';
  readonly controller: TlsStreamServerPort;
}

export type InteractiveHandoff = TlsClientHandoff | TlsServerHandoff;
