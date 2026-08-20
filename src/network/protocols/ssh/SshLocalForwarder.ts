/**
 * SshLocalForwarder — OpenSSH `-L localPort:remoteHost:remotePort` scaffold.
 *
 * Lifecycle:
 *   const fwd = new SshLocalForwarder(localDevice, session, spec);
 *   fwd.register();   // listens on `localPort` on localDevice
 *   fwd.dispose();    // tears the listener down
 *
 * Wire semantics (simulator):
 *   On accept, the SSH server opens a real connection to
 *   `<spec.remoteHost>:<spec.remotePort>` and the two sockets are piped
 *   both ways — the server dials on the user's behalf, as real OpenSSH
 *   does over a `direct-tcpip` channel. See `forwardRelay.ts` for what
 *   stood here before and why it could never carry a byte.
 *
 * Reference: SSH-IMPLEMENTATION-ANALYSIS.md §5 P6.
 */

import type { TcpStream as TcpConnection } from '@/network/tcp/types';
import type { EndHost } from '@/network/devices/EndHost';
import type { SshSession } from './session/SshSession';
import { relayThroughDialer } from './forwardRelay';

export interface LocalForwardSpec {
  /** Port opened on the local device the user is ssh-ing from. */
  readonly localPort: number;
  /** Host the SSH server resolves on the user's behalf. */
  readonly remoteHost: string;
  /** Port at the remote host. */
  readonly remotePort: number;
  /** The SSH server hostname (purely descriptive — for logging). */
  readonly sshHost: string;
}

export class SshLocalForwarder {
  private registered = false;
  private readonly listenerKey: number;

  constructor(
    private readonly localDevice: EndHost,
    private readonly session: SshSession | null,
    private readonly spec: LocalForwardSpec,
    /**
     * The tunnel's OTHER end — the SSH server, which dials the target on
     * the user's behalf exactly as real OpenSSH does. Absent it, the
     * forwarder can only listen, which is what this path did until now.
     */
    private readonly dialDevice: EndHost | null = null,
  ) {
    this.listenerKey = spec.localPort;
  }

  getSpec(): LocalForwardSpec {
    return this.spec;
  }

  /** Idempotent — registering twice is a no-op. */
  register(): void {
    if (this.registered) return;
    this.localDevice.getTcpStack().listen(this.spec.localPort, {
      onAccept: (socket) => this.handleAccept(socket as unknown as TcpConnection),
    });
    this.registered = true;
  }

  /**
   * Drop the local listener. Existing in-flight tunnels are NOT aborted
   * — that mirrors OpenSSH: only new connections are refused.
   */
  dispose(): void {
    if (!this.registered) return;
    this.localDevice.getTcpStack().closeListener(this.spec.localPort);
    this.registered = false;
  }

  // ─── private ────────────────────────────────────────────────────

  private handleAccept(conn: TcpConnection): void {
    relayThroughDialer(
      conn,
      this.dialDevice,
      this.spec.remoteHost,
      this.spec.remotePort,
    );
  }
}
