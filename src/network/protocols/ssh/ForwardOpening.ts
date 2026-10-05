import type { TcpStack } from '@/network/tcp/TcpStack';
import type { ListenerIdentity } from '@/network/tcp/ListenerSocketSink';

export type ForwardOpening = 'opened' | 'address-in-use' | 'permission-denied';

export type ForwardFailure = Exclude<ForwardOpening, 'opened'>;

export const NO_LOCAL_FORWARDING = 'Could not request local forwarding.';

export function forwardFailureOf(error: unknown): ForwardFailure {
  return error instanceof Error && error.message.includes('EACCES') ? 'permission-denied' : 'address-in-use';
}

export function localListenerFailure(bindAddress: string, port: number, failure: ForwardFailure): string[] {
  const reason = failure === 'permission-denied' ? 'Permission denied' : 'Address already in use';
  return [
    `bind [${bindAddress}]:${port}: ${reason}`,
    `channel_setup_fwd_listener_tcpip: cannot listen to port: ${port}`,
  ];
}

export function remoteForwardFailure(port: number): string {
  return `Warning: remote port forwarding failed for listen port ${port}`;
}

const LOOPBACK_BIND = '127.0.0.1';
const WILDCARD_BIND = '0.0.0.0';

export function forwardBindIp(address: string | null | undefined): string {
  if (address === null || address === undefined || address === '' || address === 'localhost') return LOOPBACK_BIND;
  return address === '*' ? WILDCARD_BIND : address;
}

export interface ForwardHost {
  getTcpStack(): TcpStack;
}

export interface ForwardListenOptions {
  readonly bindAddress?: string | null;
  readonly identity?: ListenerIdentity;
}
