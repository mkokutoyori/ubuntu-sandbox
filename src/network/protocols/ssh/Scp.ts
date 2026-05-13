/**
 * scp — secure copy on top of the SSH/SFTP stack.
 *
 * Pure orchestration: callers wire a `SftpSession` (already authenticated)
 * to perform the actual transfer. parseScpEndpoint splits an argument into
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

/**
 * Parse `[user@]host:path` for remote endpoints, or any other token as a
 * local path. Detection mirrors OpenSSH: the first `:` BEFORE any `/`
 * marks a remote endpoint.
 */
export function parseScpEndpoint(arg: string): ScpEndpoint {
  const colon = arg.indexOf(':');
  const slash = arg.indexOf('/');
  if (colon === -1 || (slash !== -1 && slash < colon)) {
    return { remote: false, path: arg };
  }
  const left = arg.slice(0, colon);
  const path = arg.slice(colon + 1) || '.';
  const at = left.indexOf('@');
  if (at === -1) {
    return { remote: true, host: left, path };
  }
  return {
    remote: true,
    user: left.slice(0, at),
    host: left.slice(at + 1),
    path,
  };
}

export interface ScpArgs {
  readonly recursive: boolean;
  readonly port: number;
  readonly identityFiles: readonly string[];
  readonly source: ScpEndpoint;
  readonly destination: ScpEndpoint;
}

/**
 * Parse `scp [-r] [-P port] [-i ident] src dst`.
 * Returns null if the call is missing source/destination.
 */
export function parseScpArgs(args: readonly string[]): ScpArgs | null {
  let recursive = false;
  let port = 22;
  const identityFiles: string[] = [];
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-r') recursive = true;
    else if (a === '-P' && i + 1 < args.length) port = Number.parseInt(args[++i], 10) || 22;
    else if (a === '-i' && i + 1 < args.length) identityFiles.push(args[++i]);
    else if (!a.startsWith('-')) positional.push(a);
  }
  if (positional.length < 2) return null;
  return {
    recursive,
    port,
    identityFiles: Object.freeze(identityFiles),
    source: parseScpEndpoint(positional[0]),
    destination: parseScpEndpoint(positional[positional.length - 1]),
  };
}
