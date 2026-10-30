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
import { allocateEphemeralPort } from '../layers/transport/EphemeralPorts';
import type { PortBindingPolicy } from './ports/PortBindingPolicy';
import { SocketInodes } from './SocketInodes';

export type SocketProtocol = 'tcp' | 'udp' | 'udplite';

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
  | 'BOUND'
  | 'CLOSED';

export type ProtocolSocketState = Exclude<SocketState, 'BOUND'>;

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
  serviceName?: string;
  uid?: number;
  boundDevice?: string;
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
  constructor(readonly inodes: SocketInodes = new SocketInodes()) {}

  private readonly sockets: Map<number, SocketEntry> = new Map();
  private readonly bindings: Set<string> = new Set();
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
    options?: { reuseAddr?: boolean; ownerUid?: number; boundDevice?: string; serviceName?: string },
  ): SocketEntry {
    if (localPort !== 0 && options?.ownerUid !== undefined && this.bindingPolicy !== null
      && !this.bindingPolicy.permits(localPort, { uid: options.ownerUid })) {
      throw new Error(`EACCES: Permission denied binding port ${localPort}/${protocol}`);
    }
    const key = this.bindKey(protocol, localPort, localAddress);
    if (this.bindings.has(key)) {
      const holder = this.findByBinding(protocol, localPort, localAddress);
      const timeWaitOnly = holder !== undefined && holder.state === 'TIME_WAIT';
      const reuse = options?.reuseAddr === true || this.twReuseEnabled;
      if (!timeWaitOnly || !reuse) {
        throw new Error(`EADDRINUSE: Port ${localPort}/${protocol} already in use`);
      }
      this.evictTimeWait(holder);
    }

    // §F9.3 — une socket EST un descripteur. Le refus vient du garde que
    // la couche Linux injecte, parce que `SocketTable` ne connaît ni les
    // rlimits ni les processus : elle ne fait que demander la permission.
    if (pid !== undefined && this.descriptorGuard && !this.descriptorGuard(pid)) {
      throw new Error('EMFILE: Too many open files');
    }

    const id = this.inodes.next();
    const entry: SocketEntry = {
      id,
      protocol,
      localAddress,
      localPort,
      remoteAddress: '*',
      remotePort: 0,
      state: 'LISTEN',
      pid,
      processName,
      serviceName: options?.serviceName,
      banner,
      uid: options?.ownerUid,
      boundDevice: options?.boundDevice,
    };

    this.put(entry);
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

    const id = this.inodes.next();
    const entry: SocketEntry = {
      id,
      protocol,
      localAddress,
      localPort: actualPort,
      remoteAddress,
      remotePort,
      state: 'ESTABLISHED',
      pid,
      processName,
    };

    this.put(entry);
    this.bindings.add(this.bindKey(protocol, actualPort, localAddress));
    return entry;
  }

  setListenerState(protocol: SocketProtocol, localAddress: string, localPort: number, state: SocketState): boolean {
    for (const entry of this.sockets.values()) {
      if (entry.remoteAddress !== '*' || entry.protocol !== protocol) continue;
      if (entry.localAddress !== localAddress || entry.localPort !== localPort) continue;
      entry.state = state;
      return true;
    }
    return false;
  }

  transition(socketId: number, state: SocketState): boolean {
    const entry = this.sockets.get(socketId);
    if (!entry) return false;
    entry.state = state;
    return true;
  }

  /**
   * Le processus nommé peut-il consommer un descripteur de plus ? Injecté
   * par la couche qui tient les rlimits ; absent, rien n'est plafonné —
   * une `SocketTable` sans machine autour ne peut pas inventer de limite.
   */
  private descriptorGuard?: (pid: number) => boolean;

  /** Brancher le garde de descripteurs (§F9.3). */
  setDescriptorGuard(guard: (pid: number) => boolean): void {
    this.descriptorGuard = guard;
  }

  private bindingPolicy: PortBindingPolicy | null = null;

  setBindingPolicy(policy: PortBindingPolicy): void {
    this.bindingPolicy = policy;
  }

  private twReuseEnabled = false;
  private twTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private twDurationMs = 60_000;

  setTcpTwReuse(enabled: boolean): void {
    this.twReuseEnabled = enabled;
  }

  getTcpTwReuse(): boolean {
    return this.twReuseEnabled;
  }

  setTimeWaitDuration(ms: number): void {
    if (Number.isFinite(ms) && ms >= 0) this.twDurationMs = ms;
  }

  startTimeWait(socketId: number, durationMs?: number): boolean {
    const entry = this.sockets.get(socketId);
    if (!entry) return false;
    entry.state = 'TIME_WAIT';
    const existing = this.twTimers.get(socketId);
    if (existing) clearTimeout(existing);
    const ms = durationMs ?? this.twDurationMs;
    const timer = setTimeout(() => {
      this.twTimers.delete(socketId);
      const held = this.sockets.get(socketId);
      if (held && held.state === 'TIME_WAIT') this.evictTimeWait(held);
    }, ms);
    if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
      (timer as unknown as { unref: () => void }).unref();
    }
    this.twTimers.set(socketId, timer);
    return true;
  }

  private findByBinding(protocol: SocketProtocol, port: number, localAddress: string): SocketEntry | undefined {
    for (const s of this.sockets.values()) {
      if (s.protocol === protocol && s.localPort === port && s.localAddress === localAddress) return s;
    }
    for (const s of this.sockets.values()) {
      if (s.protocol === protocol && s.localPort === port) return s;
    }
    return undefined;
  }

  private evictTimeWait(entry: SocketEntry): void {
    const timer = this.twTimers.get(entry.id);
    if (timer) { clearTimeout(timer); this.twTimers.delete(entry.id); }
    this.bindings.delete(this.bindKey(entry.protocol, entry.localPort, entry.localAddress));
    this.drop(entry);
  }

  /**
   * Find-or-create a 4-tuple (active) socket entry, updating its state.
   * Mirrors what the kernel's socket table does as a TCP connection
   * moves through SYN_SENT → ESTABLISHED → … → TIME_WAIT, so `ss -tan`
   * / `netstat -tan` show the live state. Listening sockets keep their
   * `remoteAddress = '*'` and are never matched here (use {@link bind}).
   */
  private readonly connections = new Map<string, SocketEntry[]>();

  private connectionKey(entry: { protocol: SocketProtocol; localPort: number; remoteAddress: string; remotePort: number }): string {
    return `${entry.protocol}|${entry.localPort}|${entry.remoteAddress}|${entry.remotePort}`;
  }

  private indexConnection(entry: SocketEntry): void {
    if (entry.remoteAddress === '*') return;
    const key = this.connectionKey(entry);
    const bucket = this.connections.get(key);
    if (bucket === undefined) this.connections.set(key, [entry]);
    else bucket.push(entry);
  }

  private unindexConnection(entry: SocketEntry): void {
    if (entry.remoteAddress === '*') return;
    const key = this.connectionKey(entry);
    const bucket = this.connections.get(key);
    if (bucket === undefined) return;
    const at = bucket.indexOf(entry);
    if (at >= 0) bucket.splice(at, 1);
    if (bucket.length === 0) this.connections.delete(key);
  }

  private put(entry: SocketEntry): void {
    this.sockets.set(entry.id, entry);
    this.indexConnection(entry);
  }

  private drop(entry: SocketEntry): void {
    this.sockets.delete(entry.id);
    this.unindexConnection(entry);
  }

  private findConnection(params: { protocol: SocketProtocol; localPort: number; remoteAddress: string; remotePort: number }): SocketEntry | undefined {
    return this.connections.get(this.connectionKey(params))?.[0];
  }

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
    const existing = params.remoteAddress === '*' ? undefined : this.findConnection(params);
    if (existing !== undefined) {
      existing.state = params.state;
      if (params.pid !== undefined) existing.pid = params.pid;
      if (params.processName !== undefined) existing.processName = params.processName;
      return existing;
    }
    const id = this.inodes.next();
    const entry: SocketEntry = {
      id,
      protocol: params.protocol,
      localAddress: params.localAddress,
      localPort: params.localPort,
      remoteAddress: params.remoteAddress,
      remotePort: params.remotePort,
      state: params.state,
      pid: params.pid,
      processName: params.processName,
    };
    this.put(entry);
    return entry;
  }

  connectDatagram(socketId: number, localAddress: string, remoteAddress: string, remotePort: number): boolean {
    const entry = this.sockets.get(socketId) as { -readonly [K in keyof SocketEntry]: SocketEntry[K] } | undefined;
    if (entry === undefined) return false;
    this.bindings.delete(this.bindKey(entry.protocol, entry.localPort, entry.localAddress));
    this.unindexConnection(entry);
    entry.localAddress = localAddress;
    entry.remoteAddress = remoteAddress;
    entry.remotePort = remotePort;
    entry.state = 'ESTABLISHED';
    this.indexConnection(entry);
    this.bindings.add(this.bindKey(entry.protocol, entry.localPort, entry.localAddress));
    return true;
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
    const entry = params.remoteAddress === '*' ? undefined : this.findConnection(params);
    if (entry === undefined) return false;
    this.drop(entry);
    return true;
  }

  setConnectionOwner(params: {
    protocol: SocketProtocol;
    localPort: number;
    remoteAddress: string;
    remotePort: number;
  }, pid: number, serviceName?: string): boolean {
    const entry = params.remoteAddress === '*' ? undefined : this.findConnection(params);
    if (entry === undefined) return false;
    entry.pid = pid;
    entry.serviceName = serviceName;
    return true;
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
        this.drop(entry);
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
    this.drop(entry);
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

  /** Sockets owned by a given process — used to project `/proc/<pid>/fd/`
   *  entries that agree with the same socket's `/proc/net/{tcp,udp}` id. */
  listByPid(pid: number): SocketEntry[] {
    return this.getAll().filter(s => s.pid === pid);
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
    return allocateEphemeralPort(this.ephemeralMin, this.ephemeralMax,
      (port) => this.isPortBound(port, 'tcp') || this.isPortBound(port, 'udp')
        || this.isPortBound(port, 'udplite'));
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────

  clear(): void {
    this.sockets.clear();
    this.connections.clear();
    this.bindings.clear();
    this.inodes.reset();
  }
}
