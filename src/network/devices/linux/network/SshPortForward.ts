/**
 * SshPortForward — one OpenSSH port-forwarding directive.
 *
 * Models the `-L`, `-R` and `-D` command-line options as an immutable
 * value object:
 *
 *   -L [bind:]port:host:hostport   local forwarding   (listener on the client)
 *   -R [bind:]port:host:hostport   remote forwarding  (listener on the server)
 *   -D [bind:]port                 dynamic SOCKS proxy (listener on the client)
 *
 * The simulator does not carry real bytes through the tunnel; it
 * reproduces the *observable* surface a tutorial cares about — a listening
 * socket that shows up in `ss -tln` / `netstat -tln` on whichever host
 * owns the listener — exactly as OpenSSH's forwarders do on a real system.
 */

export type SshForwardKind = 'local' | 'remote' | 'dynamic';

/** OpenSSH binds forwarding listeners to the loopback unless GatewayPorts. */
const DEFAULT_BIND_ADDRESS = '127.0.0.1';

export class SshPortForward {
  private constructor(
    /** Which `-X` flag produced this forward. */
    readonly kind: SshForwardKind,
    /** Address the listening socket binds to. */
    readonly bindAddress: string,
    /** Port the listening socket binds to. */
    readonly listenPort: number,
    /** Tunnel destination host (null for the dynamic SOCKS proxy). */
    readonly destHost: string | null,
    /** Tunnel destination port (null for the dynamic SOCKS proxy). */
    readonly destPort: number | null,
  ) {}

  /** Whether the listener lives on the SSH *server* — true only for `-R`. */
  get listensOnServer(): boolean {
    return this.kind === 'remote';
  }

  /**
   * Parse one forwarding spec for the given flag. Returns null when the
   * spec is malformed (bad port, missing field, …).
   */
  static parse(kind: SshForwardKind, spec: string): SshPortForward | null {
    const parts = spec.split(':');

    if (kind === 'dynamic') {
      // [bind:]port
      if (parts.length === 1) {
        const port = toPort(parts[0]);
        return port === null
          ? null
          : new SshPortForward(kind, DEFAULT_BIND_ADDRESS, port, null, null);
      }
      if (parts.length === 2) {
        const port = toPort(parts[1]);
        return port === null || !parts[0]
          ? null
          : new SshPortForward(kind, parts[0], port, null, null);
      }
      return null;
    }

    // local / remote: [bind:]port:host:hostport — 3 or 4 colon fields.
    let bindAddress = DEFAULT_BIND_ADDRESS;
    let rest = parts;
    if (parts.length === 4) {
      bindAddress = parts[0];
      rest = parts.slice(1);
    }
    if (rest.length !== 3) return null;
    const listenPort = toPort(rest[0]);
    const destPort = toPort(rest[2]);
    if (listenPort === null || destPort === null || !rest[1] || !bindAddress) {
      return null;
    }
    return new SshPortForward(kind, bindAddress, listenPort, rest[1], destPort);
  }

  /**
   * Scan an already-expanded `ssh` flag list and collect every `-L` /
   * `-R` / `-D` forwarding it requests. Malformed specs are skipped.
   */
  static collect(flags: string[]): SshPortForward[] {
    const flagKind: Record<string, SshForwardKind> = {
      '-L': 'local',
      '-R': 'remote',
      '-D': 'dynamic',
    };
    const out: SshPortForward[] = [];
    for (let i = 0; i < flags.length; i++) {
      const kind = flagKind[flags[i]];
      if (!kind) continue;
      const spec = flags[i + 1];
      if (spec === undefined) continue;
      i++;
      const fwd = SshPortForward.parse(kind, spec);
      if (fwd) out.push(fwd);
    }
    return out;
  }

  /** Human-readable form for logs — mirrors the flag that produced it. */
  describe(): string {
    const flag = this.kind === 'local' ? '-L' : this.kind === 'remote' ? '-R' : '-D';
    return this.kind === 'dynamic'
      ? `${flag} ${this.bindAddress}:${this.listenPort}`
      : `${flag} ${this.bindAddress}:${this.listenPort}:${this.destHost}:${this.destPort}`;
  }
}

/** Parse a string into a valid TCP port number, or null when invalid. */
function toPort(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}
