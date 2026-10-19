/**
 * scp — secure copy on top of the SSH/SFTP stack.
 *
 * parseScpEndpoint splits an argument into
 * either a local path or a remote `user@host:path` pair, mirroring OpenSSH.
 *
 * Reference: BRD-SSH-SFTP.md SSH-08.
 */

export interface ScpEndpoint {
  readonly remote: boolean;
  readonly user?: string;
  readonly host?: string;
  readonly path: string;
}

export interface SshAuthority {
  readonly user?: string;
  readonly host: string;
}

export function parseSshAuthority(token: string): SshAuthority | null {
  const at = token.lastIndexOf('@');
  const user = at === -1 ? undefined : token.slice(0, at);
  const authority = at === -1 ? token : token.slice(at + 1);
  if (authority === '') return null;
  if (authority.startsWith('[')) {
    if (!authority.endsWith(']')) return null;
    const host = authority.slice(1, -1);
    return host === '' ? null : { user, host };
  }
  return authority.includes(':') ? null : { user, host: authority };
}

function splitAuthorityAndPath(arg: string): { authority: string; path: string } | null {
  const bracket = arg.indexOf(']');
  if (bracket !== -1 && arg.indexOf('[') !== -1 && arg.indexOf('[') < bracket) {
    const colon = arg.indexOf(':', bracket);
    return colon === -1
      ? null
      : { authority: arg.slice(0, colon), path: arg.slice(colon + 1) };
  }
  const colon = arg.indexOf(':');
  const slash = arg.indexOf('/');
  if (colon === -1 || (slash !== -1 && slash < colon)) return null;
  return { authority: arg.slice(0, colon), path: arg.slice(colon + 1) };
}

export function parseScpEndpoint(arg: string): ScpEndpoint {
  if (/^[A-Za-z]:[\\/]/.test(arg) || /^[A-Za-z]:$/.test(arg)) {
    return { remote: false, path: arg };
  }
  const split = splitAuthorityAndPath(arg);
  if (!split) return { remote: false, path: arg };
  const authority = parseSshAuthority(split.authority);
  if (!authority) return { remote: false, path: arg };
  return {
    remote: true,
    user: authority.user,
    host: authority.host,
    path: split.path || '.',
  };
}
