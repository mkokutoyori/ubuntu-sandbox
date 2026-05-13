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

export interface RemoteForward {
  /** Port opened on the SSH server (remote end). */
  readonly remotePort: number;
  /** Host the local end resolves the connection to. */
  readonly localHost: string;
  /** Port at `localHost` (relative to the SSH client). */
  readonly localPort: number;
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
  /** Remote port forwards from `-R`. */
  readonly remoteForwards: readonly RemoteForward[];
  /**
   * OpenSSH `-A` — forward the local ssh-agent connection so commands
   * on the remote machine can authenticate further hops with the
   * client's keys.
   */
  readonly forwardAgent: boolean;
  /**
   * OpenSSH `-t` / `-T` / `-tt`. `'yes'` requests a PTY; `'force'`
   * insists even when stdin is not a TTY (`-tt`); `'no'` disables PTY
   * allocation (`-T`). `undefined` leaves the server's default in
   * effect — request a PTY only for interactive sessions.
   */
  readonly requestTty?: 'yes' | 'no' | 'force';
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
 * Parse a `-R` spec. Mirror of `parseLocalForwardSpec`:
 *   remotePort:localHost:localPort
 *   bindAddress:remotePort:localHost:localPort  (bindAddress ignored)
 */
export function parseRemoteForwardSpec(spec: string): RemoteForward | null {
  const parts = spec.split(':').map((s) => s.trim());
  const normalised = parts.length === 4 ? parts.slice(1) : parts;
  if (normalised.length !== 3) return null;
  const [rp, host, lp] = normalised;
  const remotePort = Number.parseInt(rp, 10);
  const localPort = Number.parseInt(lp, 10);
  if (!Number.isFinite(remotePort) || remotePort <= 0) return null;
  if (!Number.isFinite(localPort) || localPort <= 0) return null;
  if (!host) return null;
  return { remotePort, localHost: host, localPort };
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
  const remoteForwards: RemoteForward[] = [];
  let forwardAgent = false;
  let requestTty: 'yes' | 'no' | 'force' | undefined;
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
    } else if (arg === '-R' && i + 1 < args.length) {
      const fwd = parseRemoteForwardSpec(args[++i]);
      if (fwd) remoteForwards.push(fwd);
    } else if (arg === '-A') {
      forwardAgent = true;
    } else if (arg === '-t') {
      // -tt forces a TTY (real OpenSSH); a single -t is plain "yes".
      requestTty = requestTty === 'yes' ? 'force' : 'yes';
    } else if (arg === '-tt') {
      requestTty = 'force';
    } else if (arg === '-T') {
      requestTty = 'no';
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
        continue;
      }
      const rfMatch = /^RemoteForward=(.+)$/i.exec(next);
      if (rfMatch) {
        const fwd = parseRemoteForwardSpec(rfMatch[1]);
        if (fwd) remoteForwards.push(fwd);
        continue;
      }
      const faMatch = /^ForwardAgent=(yes|no|true|false)$/i.exec(next);
      if (faMatch) {
        forwardAgent = /^(yes|true)$/i.test(faMatch[1]);
        continue;
      }
      const ttyMatch = /^RequestTTY=(yes|no|force|auto)$/i.exec(next);
      if (ttyMatch) {
        const v = ttyMatch[1].toLowerCase();
        if (v === 'yes' || v === 'no' || v === 'force') {
          requestTty = v as 'yes' | 'no' | 'force';
        }
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
    remoteForwards: Object.freeze([...remoteForwards]),
    forwardAgent,
    requestTty,
  };
}
