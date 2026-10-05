/**
 * SshDynamicForwarder — OpenSSH `-D` SOCKS proxy scaffold.
 *
 * Opens a TCP listener on `socksPort` on the local device. Each
 * accepted connection runs through a minimal SOCKS5 handshake to
 * extract the target host/port, which is requested from the SSH server in a
 * `direct-tcpip` channel (RFC 4254 §7.2) and piped both ways.
 *
 * Supported SOCKS surface (pedagogical subset):
 *   - Version negotiation: `05 NM METHODS` → `05 00` (no-auth).
 *   - CONNECT request with `atyp ∈ {1: IPv4, 3: domain, 4: IPv6}`.
 *   - Reply: `05 00 00 01 00 00 00 00 00 00` (success, bound to 0.0.0.0:0),
 *     or REP=0x05 (connection refused) when the far leg cannot be opened.
 *
 * UDP ASSOCIATE / BIND are not implemented — they are rare in tutorials.
 *
 * Reference: RFC 1928 (SOCKS5) — only the subset above is honoured.
 *            SSH-IMPLEMENTATION-ANALYSIS.md §5 P6 (suite).
 */

import { forwardFailureOf, type ForwardOpening } from './ForwardOpening';
import type { TcpStream as TcpConnection } from '@/network/tcp/types';
import type { EndHost } from '@/network/devices/EndHost';
import { joinWhenReady, type TunnelOpener } from './forwardRelay';

export interface DynamicForwardSpec {
  /** Port the SOCKS listener binds to on the local device. */
  readonly socksPort: number;
  /** Optional bind address (descriptive — sim listens on the device). */
  readonly bindAddress: string | null;
  /** The SSH server's hostname/IP — descriptive, for logging. */
  readonly sshHost: string;
}

interface ConnectTarget {
  readonly host: string;
  readonly port: number;
}

export class SshDynamicForwarder {
  private registered = false;
  private lastConnectTarget: ConnectTarget | null = null;

  constructor(
    private readonly localDevice: EndHost,
    private readonly tunnel: TunnelOpener | null,
    private readonly spec: DynamicForwardSpec,
  ) {}

  getSpec(): DynamicForwardSpec {
    return this.spec;
  }

  /**
   * Exposed for tests so the SOCKS5 handshake can be exercised without
   * driving a full TCP accept through the simulator's network stack.
   */
  getLastConnectTarget(): ConnectTarget | null {
    return this.lastConnectTarget;
  }

  register(ownerUid?: number): ForwardOpening {
    if (this.registered) return 'opened';
    try {
      this.localDevice.getTcpStack().listen(this.spec.socksPort, {
        onAccept: (socket) => this.handleAccept(socket as unknown as TcpConnection),
        ownerUid,
      });
    } catch (error) {
      return forwardFailureOf(error);
    }
    this.registered = true;
    return 'opened';
  }

  /**
   * Drop the local SOCKS listener. In-flight tunnels keep running
   * (parity with OpenSSH).
   */
  dispose(): void {
    if (!this.registered) return;
    this.localDevice.getTcpStack().closeListener(this.spec.socksPort);
    this.registered = false;
  }

  /** Test seam — same body as `handleAccept` but accessible from tests. */
  handleAcceptForTest(conn: TcpConnection): void {
    this.handleAccept(conn);
  }

  // ─── private ────────────────────────────────────────────────────

  private handleAccept(conn: TcpConnection): void {
    type Phase = 'greeting' | 'request' | 'bridging';
    let phase: Phase = 'greeting';
    conn.onData((data) => {
      if (phase === 'greeting') {
        // SOCKS5 greeting: 0x05, NMETHODS, METHODS[...]
        if (data.length < 2 || data.charCodeAt(0) !== 0x05) {
          conn.close();
          return;
        }
        // Always reply "no authentication required" (0x00). Auth methods
        // are out of scope for the pedagogical simulator.
        conn.write('\x05\x00');
        phase = 'request';
        return;
      }
      if (phase === 'request') {
        const target = parseSocks5Connect(data);
        if (!target) {
          // Reply with general SOCKS failure (0x01) and close.
          conn.write('\x05\x01\x00\x01\x00\x00\x00\x00\x00\x00');
          conn.close();
          return;
        }
        this.lastConnectTarget = target;
        if (this.tunnel === null) {
          conn.write('\x05\x05\x00\x01\x00\x00\x00\x00\x00\x00');
          conn.close();
          return;
        }
        phase = 'bridging';
        void this.tunnel(target.host, target.port).then((remote) => {
          if (remote === null) {
            conn.write('\x05\x05\x00\x01\x00\x00\x00\x00\x00\x00');
            conn.close();
            return;
          }
          conn.write('\x05\x00\x00\x01\x00\x00\x00\x00\x00\x00');
          joinWhenReady(conn, Promise.resolve(remote));
        });
        return;
      }
      // Bridging is handled by startBridge's installed handlers.
    });
  }
}

/**
 * Parse a SOCKS5 CONNECT request. Returns null when the request is
 * truncated, the command is not CONNECT (0x01), or the address type
 * is not supported (only IPv4 / domain / IPv6).
 */
function parseSocks5Connect(raw: string): ConnectTarget | null {
  if (raw.length < 4) return null;
  const version = raw.charCodeAt(0);
  const cmd = raw.charCodeAt(1);
  const atyp = raw.charCodeAt(3);
  if (version !== 0x05 || cmd !== 0x01) return null;
  if (atyp === 0x01) {
    // IPv4: 4 octets + 2-byte port.
    if (raw.length < 4 + 4 + 2) return null;
    const a = raw.charCodeAt(4);
    const b = raw.charCodeAt(5);
    const c = raw.charCodeAt(6);
    const d = raw.charCodeAt(7);
    const port = (raw.charCodeAt(8) << 8) | raw.charCodeAt(9);
    return { host: `${a}.${b}.${c}.${d}`, port };
  }
  if (atyp === 0x03) {
    // Domain: 1-byte length + name + 2-byte port.
    const len = raw.charCodeAt(4);
    if (raw.length < 4 + 1 + len + 2) return null;
    const host = raw.slice(5, 5 + len);
    const port =
      (raw.charCodeAt(5 + len) << 8) | raw.charCodeAt(5 + len + 1);
    return { host, port };
  }
  if (atyp === 0x04) {
    // IPv6: 16 octets + 2-byte port. Rendered compressed for brevity.
    if (raw.length < 4 + 16 + 2) return null;
    const groups: string[] = [];
    for (let i = 0; i < 8; i++) {
      const hi = raw.charCodeAt(4 + i * 2);
      const lo = raw.charCodeAt(4 + i * 2 + 1);
      groups.push(((hi << 8) | lo).toString(16));
    }
    const port =
      (raw.charCodeAt(4 + 16) << 8) | raw.charCodeAt(4 + 16 + 1);
    return { host: groups.join(':'), port };
  }
  return null;
}
