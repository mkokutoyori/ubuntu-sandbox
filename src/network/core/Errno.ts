export type Errno =
  | 'EPERM' | 'ENOENT' | 'ENODEV' | 'EACCES' | 'EADDRINUSE' | 'EADDRNOTAVAIL' | 'EAFNOSUPPORT' | 'ECONNREFUSED' | 'EHOSTDOWN'
  | 'EHOSTUNREACH' | 'EINVAL' | 'EMSGSIZE' | 'ENETUNREACH' | 'ENONET' | 'ENOPROTOOPT'
  | 'EOPNOTSUPP' | 'EPIPE' | 'EPROTO' | 'ECONNRESET' | 'ETIMEDOUT' | 'EBADMSG' | 'ENODATA' | 'EPROTONOSUPPORT' | 'ENOKEY' | 'EIO' | 'ERANGE' | 'ESRCH' | 'ENOTDIR' | 'EFBIG' | 'ENOMEM' | 'EINPROGRESS' | 'EAGAIN' | 'ENAMETOOLONG' | 'EPROTOTYPE';

const LINUX_ERRNO: Readonly<Record<Errno, { number: number; text: string }>> = {
  EPERM: { number: 1, text: 'Operation not permitted' },
  ENOENT: { number: 2, text: 'No such file or directory' },
  ESRCH: { number: 3, text: 'No such process' },
  ENODEV: { number: 19, text: 'No such device' },
  EACCES: { number: 13, text: 'Permission denied' },
  EADDRINUSE: { number: 98, text: 'Address already in use' },
  EADDRNOTAVAIL: { number: 99, text: 'Cannot assign requested address' },
  EAFNOSUPPORT: { number: 97, text: 'Address family not supported by protocol' },
  ECONNREFUSED: { number: 111, text: 'Connection refused' },
  EHOSTDOWN: { number: 112, text: 'Host is down' },
  EHOSTUNREACH: { number: 113, text: 'No route to host' },
  EINVAL: { number: 22, text: 'Invalid argument' },
  EMSGSIZE: { number: 90, text: 'Message too long' },
  ENETUNREACH: { number: 101, text: 'Network is unreachable' },
  ENONET: { number: 64, text: 'Machine is not on the network' },
  ENOPROTOOPT: { number: 92, text: 'Protocol not available' },
  EOPNOTSUPP: { number: 95, text: 'Operation not supported' },
  EPIPE: { number: 32, text: 'Broken pipe' },
  EPROTO: { number: 71, text: 'Protocol error' },
  ECONNRESET: { number: 104, text: 'Connection reset by peer' },
  ETIMEDOUT: { number: 110, text: 'Connection timed out' },
  EBADMSG: { number: 74, text: 'Bad message' },
  ENODATA: { number: 61, text: 'No data available' },
  EPROTONOSUPPORT: { number: 93, text: 'Protocol not supported' },
  ENOKEY: { number: 126, text: 'Required key not available' },
  EIO: { number: 5, text: 'Input/output error' },
  ERANGE: { number: 34, text: 'Numerical result out of range' },
  ENOTDIR: { number: 20, text: 'Not a directory' },
  EFBIG: { number: 27, text: 'File too large' },
  ENOMEM: { number: 12, text: 'Cannot allocate memory' },
  EINPROGRESS: { number: 115, text: 'Operation now in progress' },
  EAGAIN: { number: 11, text: 'Resource temporarily unavailable' },
  ENAMETOOLONG: { number: 36, text: 'File name too long' },
  EPROTOTYPE: { number: 91, text: 'Protocol wrong type for socket' },
};

export interface MessageTooLong {
  readonly origin: 'local';
  readonly errno: 'EMSGSIZE';
  readonly mtu: number;
}

export function strerror(errno: Errno): string {
  return LINUX_ERRNO[errno].text;
}

export function errnoText(name: string): string {
  return name in LINUX_ERRNO ? LINUX_ERRNO[name as Errno].text : name;
}

export function errnoNumber(errno: Errno): number {
  return LINUX_ERRNO[errno].number;
}
