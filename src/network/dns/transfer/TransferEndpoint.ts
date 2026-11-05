import type { X509Certificate } from '@/network/pki/X509Certificate';

export interface TransferTls {
  readonly anchors: readonly X509Certificate[] | null;
  readonly serverName: string | null;
  readonly setupFailed: boolean;
  readonly report?: (failure: 'verification' | 'setup') => void;
}

export interface TransferEndpoint {
  readonly port: number | null;
  readonly tls: TransferTls | null;
}
