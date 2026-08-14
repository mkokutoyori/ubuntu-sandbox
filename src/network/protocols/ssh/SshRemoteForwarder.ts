/**
 * SshRemoteForwarder — OpenSSH `-R remotePort:localHost:localPort` scaffold.
 *
 * Mirror of `SshLocalForwarder`. Opens a listener on the **remote**
 * device (the SSH server end) at `remotePort`; every accepted connection
 * is bridged back through the SSH session to `localHost:localPort` on
 * the client side.
 *
 * The client is the end that dials `localHost:localPort`, mirroring real
 * OpenSSH: `-R` reverses which side listens, so it also reverses which
 * side opens the far leg. See `forwardRelay.ts`.
 *
 * Reference: SSH-IMPLEMENTATION-ANALYSIS.md §5 P6.
 */

import type { TcpStream as TcpConnection } from '@/network/tcp/types';
import type { EndHost } from '@/network/devices/EndHost';
import type { SshSession } from './session/SshSession';
import { relayThroughDialer } from './forwardRelay';

export interface RemoteForwardSpec {
  /** Port opened on the remote (SSH server) device. */
  readonly remotePort: number;
  /** Host the client resolves the forwarded connection to. */
  readonly localHost: string;
  /** Port on the client side of the tunnel. */
  readonly localPort: number;
  /** Descriptive — the SSH server's hostname/IP, for logging. */
  readonly sshHost: string;
}

export class SshRemoteForwarder {
  private registered = false;

  constructor(
    private readonly remoteDevice: EndHost,
    private readonly session: SshSession | null,
    private readonly spec: RemoteForwardSpec,
    /**
     * The tunnel's OTHER end — for `-R` that is the CLIENT, which dials
     * `localHost:localPort` on the remote user's behalf.
     */
    private readonly dialDevice: EndHost | null = null,
  ) {}

  getSpec(): RemoteForwardSpec {
    return this.spec;
  }

  /** Idempotent — registering twice is a no-op. */
  register(): void {
    if (this.registered) return;
    this.remoteDevice.getTcpStack().listen(this.spec.remotePort, {
      onAccept: (socket) => this.handleAccept(socket as unknown as TcpConnection),
    });
    this.registered = true;
  }

  /**
   * Drop the remote-side listener. Existing in-flight tunnels keep
   * running until they close on their own (parity with OpenSSH).
   */
  dispose(): void {
    if (!this.registered) return;
    this.remoteDevice.getTcpStack().closeListener(this.spec.remotePort);
    this.registered = false;
  }

  // ─── private ────────────────────────────────────────────────────

  private handleAccept(conn: TcpConnection): void {
    relayThroughDialer(
      conn,
      this.dialDevice,
      this.spec.localHost,
      this.spec.localPort,
    );
  }
}
