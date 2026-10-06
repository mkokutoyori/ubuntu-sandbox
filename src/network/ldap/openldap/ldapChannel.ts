import type { LdapOptions } from './ldapOptions';

export interface TlsUpgradeRequest {
  readonly serverName: string;
  readonly tls: LdapOptions['tls'];
  readonly implicit: boolean;
}

export type TlsUpgradeOutcome = { readonly ok: true } | { readonly ok: false; readonly detail: string };

export type ChannelRead =
  | { readonly kind: 'data'; readonly bytes: Uint8Array }
  | { readonly kind: 'eof' }
  | { readonly kind: 'again' };

export interface LdapChannel {
  write(bytes: Uint8Array): boolean;
  read(want: number): ChannelRead;
  readable(): boolean;
  upgradeTls(request: TlsUpgradeRequest): TlsUpgradeOutcome;
  readonly peerAddress: string;
  readonly localEndpoint: string;
  close(): void;
}

export type ConnectOutcome =
  | { readonly kind: 'connected'; readonly channel: LdapChannel }
  | { readonly kind: 'failed'; readonly errno: number };

export interface LdapTransport {
  resolve(name: string): Promise<readonly string[] | null>;
  connect(address: string, port: number): ConnectOutcome;
}
