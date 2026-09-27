export type Errno =
  | 'EACCES' | 'EADDRINUSE' | 'EADDRNOTAVAIL' | 'ECONNREFUSED' | 'EHOSTDOWN'
  | 'EHOSTUNREACH' | 'EMSGSIZE' | 'ENETUNREACH' | 'ENONET' | 'ENOPROTOOPT'
  | 'EOPNOTSUPP' | 'EPROTO' | 'ETIMEDOUT';

const LINUX_ERRNO: Readonly<Record<Errno, { number: number; text: string }>> = {
  EACCES: { number: 13, text: 'Permission denied' },
  EADDRINUSE: { number: 98, text: 'Address already in use' },
  EADDRNOTAVAIL: { number: 99, text: 'Cannot assign requested address' },
  ECONNREFUSED: { number: 111, text: 'Connection refused' },
  EHOSTDOWN: { number: 112, text: 'Host is down' },
  EHOSTUNREACH: { number: 113, text: 'No route to host' },
  EMSGSIZE: { number: 90, text: 'Message too long' },
  ENETUNREACH: { number: 101, text: 'Network is unreachable' },
  ENONET: { number: 64, text: 'Machine is not on the network' },
  ENOPROTOOPT: { number: 92, text: 'Protocol not available' },
  EOPNOTSUPP: { number: 95, text: 'Operation not supported' },
  EPROTO: { number: 71, text: 'Protocol error' },
  ETIMEDOUT: { number: 110, text: 'Connection timed out' },
};

export function strerror(errno: Errno): string {
  return LINUX_ERRNO[errno].text;
}

export function errnoNumber(errno: Errno): number {
  return LINUX_ERRNO[errno].number;
}
