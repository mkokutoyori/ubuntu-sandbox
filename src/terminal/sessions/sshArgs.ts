/**
 * Pure parsing helpers for the in-terminal `ssh` command.
 *
 * Extracted from `LinuxTerminalSession` so the same logic can be
 * exercised in unit tests without spinning up a full session.
 *
 * Supported flags (OpenSSH subset):
 *   -p <port>                  Remote port.
 *   -i <identity_file>         Identity (private key) path. Repeatable.
 *   -o StrictHostKeyChecking=  yes | no | accept-new.
 *   -o HashKnownHosts=         yes | no.
 *   -o ProxyJump=<spec>        Same as `-J <spec>`.
 *   -J <spec>                  Comma-separated jump-host chain.
 *   -L <localPort:host:port>   Local port forwarding (repeatable).
 *
 * The parser is intentionally tolerant — unknown `-o key=value`
 * directives are ignored so a `~/.ssh/config` snippet pasted on the
 * command line does not crash the terminal.
 */

export type StrictHostKeyChecking = 'yes' | 'no' | 'accept-new';

export interface LocalForward {
  /** Port opened on the local machine. */
  readonly localPort: number;
  /** Host the remote end resolves the connection to (often `localhost`). */
  readonly remoteHost: string;
  /** Port at `remoteHost` (relative to the SSH server). */
  readonly remotePort: number;
}

export interface ParsedSshArgs {
  /** `user@host` or just `host`. */
  readonly userAtHost: string;
  readonly port: number;
  readonly identityFiles: readonly string[];
  readonly strict: StrictHostKeyChecking;
  /** Inline command (`ssh user@host whoami`). `null` for interactive. */
  readonly command: string | null;
  /** When true, persist new entries to known_hosts hashed. */
  readonly hashKnownHosts?: boolean;
  /**
   * ProxyJump chain (`-J h1[,h2,...]` or `-o ProxyJump=`). Each entry
   * keeps the `[user@]host` form for downstream rendering.
   */
  readonly jumpHosts: readonly string[];
  /** Local port forwards from `-L`. */
  readonly localForwards: readonly LocalForward[];
}

export interface ProxyHop {
  readonly user: string | null;
  readonly host: string;
}

/**
 * Split a `-J` value into structured hops. Empty input → empty list.
 * Order is preserved (first hop is the first SSH connection opened).
 */
export function parseProxyJumpSpec(spec: string): readonly ProxyHop[] {
  if (!spec) return [];
  return spec
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((entry) => {
      const at = entry.indexOf('@');
      return at >= 0
        ? { user: entry.slice(0, at), host: entry.slice(at + 1) }
        : { user: null, host: entry };
    });
}

/**
 * Parse a `-L` spec. Accepts the OpenSSH forms:
 *   localPort:remoteHost:remotePort
 *   bindAddress:localPort:remoteHost:remotePort  (bindAddress ignored)
 * Returns null on malformed input.
 */
export function parseLocalForwardSpec(spec: string): LocalForward | null {
  const parts = spec.split(':').map((s) => s.trim());
  // Drop bindAddress when present (4-part form).
  const normalised = parts.length === 4 ? parts.slice(1) : parts;
  if (normalised.length !== 3) return null;
  const [lp, host, rp] = normalised;
  const localPort = Number.parseInt(lp, 10);
  const remotePort = Number.parseInt(rp, 10);
  if (!Number.isFinite(localPort) || localPort <= 0) return null;
  if (!Number.isFinite(remotePort) || remotePort <= 0) return null;
  if (!host) return null;
  return { localPort, remoteHost: host, remotePort };
}

/**
 * Parse `ssh [options] [user@]host [command...]`. Returns `null` only
 * when no host argument is present (matches OpenSSH usage-error path).
 */
export function parseSshArgs(args: readonly string[]): ParsedSshArgs | null {
  let port = 22;
  const identityFiles: string[] = [];
  let strict: StrictHostKeyChecking = 'accept-new';
  let hashKnownHosts: boolean | undefined;
  const jumpHostsRaw: string[] = [];
  const localForwards: LocalForward[] = [];
  let host: string | null = null;
  const commandTokens: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (host) {
      commandTokens.push(arg);
      continue;
    }
    if (arg === '-p' && i + 1 < args.length) {
      port = Number.parseInt(args[++i], 10) || 22;
    } else if (arg === '-i' && i + 1 < args.length) {
      identityFiles.push(args[++i]);
    } else if (arg === '-J' && i + 1 < args.length) {
      const spec = args[++i];
      for (const hop of parseProxyJumpSpec(spec)) {
        jumpHostsRaw.push(hop.user ? `${hop.user}@${hop.host}` : hop.host);
      }
    } else if (arg === '-L' && i + 1 < args.length) {
      const fwd = parseLocalForwardSpec(args[++i]);
      if (fwd) localForwards.push(fwd);
    } else if (arg === '-o' && i + 1 < args.length) {
      const next = args[++i];
      const strictMatch = /^StrictHostKeyChecking=(yes|no|accept-new)$/i.exec(
        next,
      );
      if (strictMatch) {
        strict = strictMatch[1].toLowerCase() as StrictHostKeyChecking;
        continue;
      }
      const hashMatch = /^HashKnownHosts=(yes|no|true|false)$/i.exec(next);
      if (hashMatch) {
        hashKnownHosts = /^(yes|true)$/i.test(hashMatch[1]);
        continue;
      }
      const proxyMatch = /^ProxyJump=(.+)$/i.exec(next);
      if (proxyMatch) {
        for (const hop of parseProxyJumpSpec(proxyMatch[1])) {
          jumpHostsRaw.push(hop.user ? `${hop.user}@${hop.host}` : hop.host);
        }
        continue;
      }
      const lfMatch = /^LocalForward=(.+)$/i.exec(next);
      if (lfMatch) {
        const fwd = parseLocalForwardSpec(lfMatch[1]);
        if (fwd) localForwards.push(fwd);
      }
    } else if (!arg.startsWith('-')) {
      host = arg;
    }
  }
  if (!host) return null;
  return {
    userAtHost: host,
    port,
    identityFiles: Object.freeze([...identityFiles]),
    strict,
    command: commandTokens.length > 0 ? commandTokens.join(' ') : null,
    hashKnownHosts,
    jumpHosts: Object.freeze([...jumpHostsRaw]),
    localForwards: Object.freeze([...localForwards]),
  };
}
