/**
 * SshForwardingTable — the active SSH port-forwards owned by one machine,
 * kept coherent with that machine's kernel socket table.
 *
 * `-L` / `-D` listeners live on the SSH *client* host; `-R` listeners
 * live on the *server* host. Either way the owning machine gains a
 * LISTEN entry in its {@link SocketTable}, so `ss -tln` / `netstat -tln`
 * report the tunnel — exactly as OpenSSH's forwarders do on a real host.
 *
 * The table is the single owner of the forwarding sockets: it binds them
 * on {@link open} and releases them on {@link close} / {@link clear},
 * so the socket view never drifts from the set of live forwards.
 */

import type { SocketTable } from '../../../core/SocketTable';
import type { SshPortForward } from './SshPortForward';

export class SshForwardingTable {
  /** Forwards currently live on this machine, in insertion order. */
  private readonly active: SshPortForward[] = [];
  /**
   * For each listen port, the IP of the SSH server that terminates the
   * tunnel. Lets non-SSH clients (e.g. `nc`) that hit the local listener
   * be re-sourced from that server's vantage point — modelling the fact
   * that the tunnel's outbound connection to `(destHost, destPort)` is
   * actually opened by the sshd process, NOT by the local kernel.
   */
  private readonly origins = new Map<number, string>();

  constructor(private readonly sockets: SocketTable) {}

  /**
   * Open a forward on this machine: record it and bind its listening
   * socket. `processName` is `ssh` for client-side (`-L`/`-D`) listeners
   * and `sshd` for server-side (`-R`) ones.
   *
   * Returns false when the listen port is already taken by an unrelated
   * socket (mirrors `bind(): EADDRINUSE`); a port already held by an
   * identical forward is treated as success (idempotent re-open).
   */
  open(fwd: SshPortForward, pid: number, processName: string): boolean {
    if (this.sockets.isPortBound(fwd.listenPort, 'tcp')) {
      const ownedByForward = this.active.some(
        (f) => f.listenPort === fwd.listenPort,
      );
      if (ownedByForward) {
        this.active.push(fwd);
        return true;
      }
      return false;
    }
    try {
      this.sockets.bind('tcp', fwd.bindAddress, fwd.listenPort, pid, processName);
    } catch {
      return false;
    }
    this.active.push(fwd);
    return true;
  }

  /** Tear a forward down by its listen port — drops the listening socket. */
  close(listenPort: number): boolean {
    const idx = this.active.findIndex((f) => f.listenPort === listenPort);
    if (idx === -1) return false;
    const fwd = this.active[idx];
    this.active.splice(idx, 1);
    // Only release the socket once the last forward on that port is gone.
    if (!this.active.some((f) => f.listenPort === listenPort)) {
      this.sockets.unbind('tcp', fwd.bindAddress, fwd.listenPort);
      this.origins.delete(listenPort);
    }
    return true;
  }

  /** A snapshot of every forward currently active on this machine. */
  list(): readonly SshPortForward[] {
    return [...this.active];
  }

  /** Whether a forward is listening on the given port. */
  has(listenPort: number): boolean {
    return this.active.some((f) => f.listenPort === listenPort);
  }

  /** Drop every forward and release every listening socket (host power-off). */
  clear(): void {
    for (const fwd of this.active) {
      this.sockets.unbind('tcp', fwd.bindAddress, fwd.listenPort);
    }
    this.active.length = 0;
    this.origins.clear();
  }

  /**
   * Tag an active client-side forward with the IP of the SSH server that
   * carries it. The forward must already be {@link open}ed.
   */
  setOrigin(listenPort: number, sshHostIp: string): void {
    if (!this.has(listenPort)) return;
    this.origins.set(listenPort, sshHostIp);
  }

  /** The IP of the SSH server tunnelling traffic for `listenPort`, if any. */
  getOrigin(listenPort: number): string | null {
    return this.origins.get(listenPort) ?? null;
  }
}
