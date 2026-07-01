/**
 * SocketTable — per-device socket registry (Registry Pattern)
 *
 * Tracks listening and established sockets for a simulated host, mirroring
 * the kernel socket table that `netstat`/`ss` read from on a real Linux system.
 *
 * Design decisions:
 * - Port uniqueness key is `protocol:port` (same port on TCP and UDP is OK).
 * - Ephemeral ports are allocated from the RFC 6335 range (49152–65535).
 * - bind() throws EADDRINUSE when the port/protocol pair is already taken.
 * - connect() auto-allocates an ephemeral source port when localPort === 0.
 * - Each SocketEntry gets a monotonically-increasing numeric id for O(1) close.
 */

import { EPHEMERAL_PORT_MIN, EPHEMERAL_PORT_MAX } from './WellKnownPorts';

export type SocketProtocol = 'tcp' | 'udp';

/** TCP connection state machine values (RFC 793) */
export type SocketState =
  | 'LISTEN'
  | 'ESTABLISHED'
  | 'SYN_SENT'
  | 'SYN_RECEIVED'
  | 'FIN_WAIT_1'
  | 'FIN_WAIT_2'
  | 'CLOSE_WAIT'
  | 'CLOSING'
  | 'LAST_ACK'
  | 'TIME_WAIT'
  | 'CLOSED';

export interface SocketEntry {
  /** Unique numeric identifier within this SocketTable */
  readonly id: number;
  readonly protocol: SocketProtocol;
  /** Local bind address ('0.0.0.0' = all interfaces) */
  readonly localAddress: string;
  readonly localPort: number;
  /** Remote peer address ('*' for listening sockets) */
  readonly remoteAddress: string;
  readonly remotePort: number;
  state: SocketState;
  /** PID of the owning process (optional) */
  pid?: number;
  /** Human-readable process name (optional) */
  processName?: string;
  /**
   * Application-layer greeting the service writes as the first bytes on a
   * fresh TCP connection (e.g. `SSH-2.0-...\r\n`, `220 mail.example.com\r\n`).
   * Read by nc/nmap-style banner grabbers so a service on a non-standard
   * port stays identifiable by its protocol.
   */
  banner?: string;
}

// ─── SocketTable ───────────────────────────────────────────────────────

export class SocketTable {
  private readonly sockets: Map<number, SocketEntry> = new Map();
  private readonly bindings: Set<string> = new Set();
  private idCounter = 0;
  private ephemeralMin: number = EPHEMERAL_PORT_MIN;
  private ephemeralMax: number = EPHEMERAL_PORT_MAX;

  setEphemeralRange(min: number, max: number): void {
    if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max > 65535 || min > max) {
      throw new Error(`Invalid ephemeral range: [${min}, ${max}]`);
    }
    this.ephemeralMin = min;
    this.ephemeralMax = max;
  }

  getEphemeralRange(): { min: number; max: number } {
    return { min: this.ephemeralMin, max: this.ephemeralMax };
  }

  // ─── Helpers ────────────────────────────────────────────────────────

  private static isV6Address(addr: string): boolean {
    return addr.includes(':');
  }

  private bindKey(protocol: SocketProtocol, port: number, localAddress: string): string {
    const family = SocketTable.isV6Address(localAddress) ? 'v6' : 'v4';
    return `${protocol}:${family}:${port}`;
  }

  // ─── Core operations ────────────────────────────────────────────────

  /**
   * Bind a port for listening (passive open).
   * Throws EADDRINUSE if the port/protocol is already bound.
   */
  bind(
    protocol: SocketProtocol,
    localAddress: string,
    localPort: number,
    pid?: number,
    processName?: string,
    banner?: string,
  ): SocketEntry {
    const key = this.bindKey(protocol, localPort, localAddress);
    if (this.bindings.has(key)) {
      throw new Error(`EADDRINUSE: Port ${localPort}/${protocol} already in use`);
    }

    this.idCounter++;
    const entry: SocketEntry = {
      id: this.idCounter,
      protocol,
      localAddress,
      localPort,
      remoteAddress: '*',
      remotePort: 0,
      state: 'LISTEN',
      pid,
      processName,
      banner,
    };

    this.sockets.set(this.idCounter, entry);
    this.bindings.add(key);
    return entry;
  }

  getBannerForPort(protocol: SocketProtocol, port: number): string | null {
    for (const entry of this.sockets.values()) {
      if (entry.state !== 'LISTEN') continue;
      if (entry.protocol !== protocol) continue;
      if (entry.localPort !== port) continue;
      if (entry.banner) return entry.banner;
    }
    return null;
  }

  getListenerProcess(protocol: SocketProtocol, port: number): string | null {
    for (const entry of this.sockets.values()) {
      if (entry.state !== 'LISTEN') continue;
      if (entry.protocol !== protocol) continue;
      if (entry.localPort !== port) continue;
      if (entry.processName) return entry.processName;
    }
    return null;
  }

  /**
   * Open an active (outgoing) connection.
   * When localPort === 0 the OS allocates an ephemeral port automatically.
   */
  connect(
    protocol: SocketProtocol,
    localAddress: string,
    localPort: number,
    remoteAddress: string,
    remotePort: number,
    pid?: number,
    processName?: string,
  ): SocketEntry {
    const actualPort = localPort === 0 ? this.allocateEphemeralPort() : localPort;

    this.idCounter++;
    const entry: SocketEntry = {
      id: this.idCounter,
      protocol,
      localAddress,
      localPort: actualPort,
      remoteAddress,
      remotePort,
      state: 'ESTABLISHED',
      pid,
      processName,
    };

    this.sockets.set(this.idCounter, entry);
    this.bindings.add(this.bindKey(protocol, actualPort, localAddress));
    return entry;
  }

  transition(socketId: number, state: SocketState): boolean {
    const entry = this.sockets.get(socketId);
    if (!entry) return false;
    entry.state = state;
    return true;
  }

  /**
   * Find-or-create a 4-tuple (active) socket entry, updating its state.
   * Mirrors what the kernel's socket table does as a TCP connection
   * moves through SYN_SENT → ESTABLISHED → … → TIME_WAIT, so `ss -tan`
   * / `netstat -tan` show the live state. Listening sockets keep their
   * `remoteAddress = '*'` and are never matched here (use {@link bind}).
   */
  upsertConnection(params: {
    protocol: SocketProtocol;
    localAddress: string;
    localPort: number;
    remoteAddress: string;
    remotePort: number;
    state: SocketState;
    pid?: number;
    processName?: string;
  }): SocketEntry {
    for (const entry of this.sockets.values()) {
      if (entry.remoteAddress === '*') continue;
      if (entry.protocol !== params.protocol) continue;
      if (entry.localPort !== params.localPort) continue;
      if (entry.remoteAddress !== params.remoteAddress) continue;
      if (entry.remotePort !== params.remotePort) continue;
      entry.state = params.state;
      if (params.pid !== undefined) entry.pid = params.pid;
      if (params.processName !== undefined) entry.processName = params.processName;
      return entry;
    }
    this.idCounter++;
    const entry: SocketEntry = {
      id: this.idCounter,
      protocol: params.protocol,
      localAddress: params.localAddress,
      localPort: params.localPort,
      remoteAddress: params.remoteAddress,
      remotePort: params.remotePort,
      state: params.state,
      pid: params.pid,
      processName: params.processName,
    };
    this.sockets.set(this.idCounter, entry);
    return entry;
  }

  /**
   * Remove an active 4-tuple entry — invoked when a connection reaches
   * CLOSED (the kernel removes the TCB from the socket table). The
   * listening socket on the same port (if any) is untouched.
   */
  removeConnection(params: {
    protocol: SocketProtocol;
    localPort: number;
    remoteAddress: string;
    remotePort: number;
  }): boolean {
    for (const [id, entry] of this.sockets) {
      if (entry.remoteAddress === '*') continue;
      if (entry.protocol !== params.protocol) continue;
      if (entry.localPort !== params.localPort) continue;
      if (entry.remoteAddress !== params.remoteAddress) continue;
      if (entry.remotePort !== params.remotePort) continue;
      this.sockets.delete(id);
      return true;
    }
    return false;
  }

  /**
   * Remove any socket bound to (protocol, port) on the given local addr.
   * Returns the number of sockets removed. Used by service-lifecycle
   * reactors (e.g. `systemctl stop ssh` → unbind tcp:22).
   */
  unbind(protocol: SocketProtocol, localAddress: string, localPort: number): number {
    let removed = 0;
    for (const [id, entry] of this.sockets) {
      if (entry.protocol === protocol && entry.localAddress === localAddress && entry.localPort === localPort) {
        this.bindings.delete(this.bindKey(entry.protocol, entry.localPort, entry.localAddress));
        this.sockets.delete(id);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Close a socket by its id.
   * Returns true if the socket existed and was removed, false otherwise.
   */
  close(socketId: number): boolean {
    const entry = this.sockets.get(socketId);
    if (!entry) return false;

    this.bindings.delete(this.bindKey(entry.protocol, entry.localPort, entry.localAddress));
    this.sockets.delete(socketId);
    return true;
  }

  // ─── Queries ────────────────────────────────────────────────────────

  isPortBound(port: number, protocol: SocketProtocol, family: 'v4' | 'v6' | 'any' = 'any'): boolean {
    if (family === 'any') {
      return this.bindings.has(`${protocol}:v4:${port}`) || this.bindings.has(`${protocol}:v6:${port}`);
    }
    return this.bindings.has(`${protocol}:${family}:${port}`);
  }

  getAll(): SocketEntry[] {
    return Array.from(this.sockets.values());
  }

  getListening(): SocketEntry[] {
    return this.getAll().filter(s => s.state === 'LISTEN');
  }

  getEstablished(): SocketEntry[] {
    return this.getAll().filter(s => s.state === 'ESTABLISHED');
  }

  findByLocalPort(port: number, protocol?: SocketProtocol): SocketEntry | undefined {
    for (const s of this.sockets.values()) {
      if (s.localPort === port && (protocol === undefined || s.protocol === protocol)) {
        return s;
      }
    }
    return undefined;
  }

  get size(): number {
    return this.sockets.size;
  }

  // ─── Ephemeral port allocation ───────────────────────────────────────

  /**
   * Allocate an unused ephemeral port (RFC 6335 range: 49152–65535).
   * Tries a random port first, then falls back to linear scan.
   */
  allocateEphemeralPort(): number {
    const range = this.ephemeralMax - this.ephemeralMin + 1;
    for (let attempt = 0; attempt < 256; attempt++) {
      const port = this.ephemeralMin + Math.floor(Math.random() * range);
      if (!this.isPortBound(port, 'tcp') && !this.isPortBound(port, 'udp')) {
        return port;
      }
    }
    for (let port = this.ephemeralMin; port <= this.ephemeralMax; port++) {
      if (!this.isPortBound(port, 'tcp') && !this.isPortBound(port, 'udp')) {
        return port;
      }
    }
    throw new Error('EADDRINUSE: No ephemeral ports available');
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────

  clear(): void {
    this.sockets.clear();
    this.bindings.clear();
    this.idCounter = 0;
  }
}
