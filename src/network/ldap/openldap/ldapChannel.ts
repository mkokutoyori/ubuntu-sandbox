import type { LdapOptions } from './ldapOptions';

export type TlsDebug = (level: number, text: string) => void;

export interface TlsUpgradeRequest {
  readonly serverName: string;
  readonly tls: LdapOptions['tls'];
  readonly implicit: boolean;
  readonly debug: TlsDebug;
}

export type TlsUpgradeOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly detail: string | null; readonly errno: number | null };

export type ChannelRead =
  | { readonly kind: 'data'; readonly bytes: Uint8Array }
  | { readonly kind: 'eof' }
  | { readonly kind: 'again' };

export interface LdapTlsState {
  readonly strength: number;
  readonly clientDn: string | null;
  readonly serverEndPoint: Uint8Array | null;
  readonly unique: Uint8Array | null;
}

export interface LdapChannel {
  write(bytes: Uint8Array): boolean;
  read(want: number): ChannelRead;
  readable(): boolean;
  upgradeTls(request: TlsUpgradeRequest): Promise<TlsUpgradeOutcome>;
  readonly peerAddress: string;
  tlsState?(): LdapTlsState | null;
  readonly localEndpoint: string;
  close(): void;
}

export type ConnectOutcome =
  | { readonly kind: 'connected'; readonly channel: LdapChannel }
  | { readonly kind: 'failed'; readonly errno: number };

export interface LdapTransport {
  resolve(name: string): Promise<readonly string[] | null>;
  connect(address: string, port: number): ConnectOutcome;
  reverse?(address: string): Promise<string | null>;
}
