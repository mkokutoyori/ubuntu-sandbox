import type { SocketTable } from '../../../core/SocketTable';
import type { TcpStack } from '../../../tcp/TcpStack';
import type { SshPortForward } from './SshPortForward';
import type { SshSession } from '../../../protocols/ssh/session/SshSession';
import { SshLocalForwarder } from '../../../protocols/ssh/SshLocalForwarder';
import { SshDynamicForwarder } from '../../../protocols/ssh/SshDynamicForwarder';
import { SshRemoteForwarder } from '../../../protocols/ssh/SshRemoteForwarder';
import { tunnelThroughSession } from '../../../protocols/ssh/forwardRelay';
import type { ForwardOpening } from '../../../protocols/ssh/ForwardOpening';

interface LiveForward {
  readonly fwd: SshPortForward | null;
  readonly session: SshSession;
  readonly stop: () => void;
}

export class SshForwardingTable {
  private readonly active: LiveForward[] = [];
  private readonly owners = new Map<SshSession, number>();
  private released: (pid: number) => void = () => undefined;

  onClientReleased(listener: (pid: number) => void): void {
    this.released = listener;
  }

  adopt(session: SshSession, pid: number): void {
    this.owners.set(session, pid);
  }

  closeOwnedBy(pid: number): boolean {
    const sessions = [...this.owners].filter(([, owner]) => owner === pid).map(([session]) => session);
    for (const session of sessions) {
      this.owners.delete(session);
      for (const live of this.active.filter((candidate) => candidate.session === session)) {
        this.active.splice(this.active.indexOf(live), 1);
        live.stop();
      }
      session.disconnect();
    }
    return sessions.length > 0;
  }

  constructor(
    private readonly sockets: SocketTable,
    private readonly ownTcpStack?: TcpStack,
  ) {}

  openLocal(
    fwd: SshPortForward, session: SshSession, pid: number, ownerUid?: number,
  ): ForwardOpening {
    if (this.ownTcpStack === undefined || this.sockets.isPortBound(fwd.listenPort, 'tcp')) return 'address-in-use';
    const host = { getTcpStack: () => this.ownTcpStack! };
    const tunnel = tunnelThroughSession(session);
    const identity = { pid, processName: 'ssh' };
    const forwarder = fwd.kind === 'dynamic'
      ? new SshDynamicForwarder(host, tunnel, {
        socksPort: fwd.listenPort, bindAddress: fwd.bindAddress, sshHost: '',
      }, { identity })
      : new SshLocalForwarder(host, tunnel, {
        localPort: fwd.listenPort, remoteHost: fwd.destHost!, remotePort: fwd.destPort!, sshHost: '',
      }, { bindAddress: fwd.bindAddress, identity });
    const opening = forwarder.register(ownerUid);
    if (opening === 'opened') {
      this.active.push({ fwd, session, stop: () => forwarder.dispose() });
      this.owners.set(session, pid);
    }
    return opening;
  }

  openRemote(
    fwd: SshPortForward, session: SshSession, clientHost: { getTcpStack(): TcpStack },
    resolveHost: (name: string) => string | null,
  ): boolean {
    const forwarder = new SshRemoteForwarder(session, clientHost, {
      remotePort: fwd.listenPort, localHost: fwd.destHost!, localPort: fwd.destPort!, sshHost: '',
      bindAddress: fwd.bindAddress,
    }, resolveHost);
    if (forwarder.registerNow() !== true) return false;
    this.active.push({ fwd, session, stop: () => forwarder.dispose() });
    return true;
  }

  close(listenPort: number): boolean {
    const index = this.active.findIndex((live) => live.fwd?.listenPort === listenPort);
    if (index === -1) return false;
    const [live] = this.active.splice(index, 1);
    live.stop();
    this.releaseIfUnused(live.session);
    return true;
  }

  holds(session: SshSession): boolean {
    return this.active.some((live) => live.session === session);
  }

  holdOpen(session: SshSession): void {
    if (!this.holds(session)) this.active.push({ fwd: null, session, stop: () => {} });
  }

  list(): readonly SshPortForward[] {
    return this.active.flatMap((live) => (live.fwd === null ? [] : [live.fwd]));
  }

  has(listenPort: number): boolean {
    return this.active.some((live) => live.fwd?.listenPort === listenPort);
  }

  clear(): void {
    this.owners.clear();
    for (const live of this.active.splice(0)) {
      live.stop();
      live.session.disconnect();
    }
  }

  private releaseIfUnused(session: SshSession): void {
    if (this.active.some((live) => live.session === session)) return;
    session.disconnect();
    const owner = this.owners.get(session);
    this.owners.delete(session);
    if (owner !== undefined) this.released(owner);
  }
}
