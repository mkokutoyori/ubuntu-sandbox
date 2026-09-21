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

export interface ScpArgs {
  readonly recursive: boolean;
  readonly port: number;
  readonly identityFiles: readonly string[];
  /** First source — kept for backward compatibility; same as `sources[0]`. */
  readonly source: ScpEndpoint;
  /** All sources (real OpenSSH allows `scp a b c dst`). */
  readonly sources: readonly ScpEndpoint[];
  readonly destination: ScpEndpoint;
  readonly preserve: boolean;
  readonly quiet: boolean;
  readonly verbose: boolean;
  readonly compression: boolean;
  readonly bandwidthLimitKbps: number | null;
  readonly jumpHost: string | null;
  readonly options: ReadonlyMap<string, string>;
  readonly skipFilenameCheck: boolean;
}

/**
 * Parse `scp [-rpqvCT] [-P port] [-i ident] [-l limit] [-J jumphost]
 *            [-o key=val] src dst`.
 * Returns null if the call is missing source/destination.
 */
export function parseScpArgs(args: readonly string[]): ScpArgs | null {
  let recursive = false;
  let preserve = false;
  let quiet = false;
  let verbose = false;
  let compression = false;
  let skipFilenameCheck = false;
  let port = 22;
  let bandwidthLimitKbps: number | null = null;
  let jumpHost: string | null = null;
  const identityFiles: string[] = [];
  const options = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-r') recursive = true;
    else if (a === '-p') preserve = true;
    else if (a === '-q') quiet = true;
    else if (a === '-v') verbose = true;
    else if (a === '-C') compression = true;
    else if (a === '-T') skipFilenameCheck = true;
    else if (a === '-P' && i + 1 < args.length) port = Number.parseInt(args[++i], 10) || 22;
    else if (a === '-i' && i + 1 < args.length) identityFiles.push(args[++i]);
    else if (a === '-l' && i + 1 < args.length) {
      const v = Number.parseInt(args[++i], 10);
      if (Number.isFinite(v) && v > 0) bandwidthLimitKbps = v;
    }
    else if (a === '-J' && i + 1 < args.length) jumpHost = args[++i];
    else if (a === '-o' && i + 1 < args.length) {
      const kv = args[++i];
      const eq = kv.indexOf('=');
      if (eq > 0) options.set(kv.slice(0, eq), kv.slice(eq + 1));
    }
    else if (!a.startsWith('-')) positional.push(a);
  }
  if (positional.length < 2) return null;
  const sources = positional.slice(0, -1).map(parseScpEndpoint);
  return {
    recursive, preserve, quiet, verbose, compression, skipFilenameCheck,
    port, bandwidthLimitKbps, jumpHost,
    identityFiles: Object.freeze(identityFiles),
    options,
    source: sources[0],
    sources: Object.freeze(sources),
    destination: parseScpEndpoint(positional[positional.length - 1]),
  };
}
