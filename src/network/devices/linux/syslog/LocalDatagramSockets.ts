import type { VirtualFileSystem } from '../VirtualFileSystem';
import type { SocketInodes } from '../../../core/SocketInodes';
import { UnixSocketTable, type UnixSocket, type UnixSocketRow } from '../unix/UnixSocketTable';

export interface UnixOwner {
  readonly pid: number;
  readonly uid: number;
}

export interface UnixDatagram {
  readonly text: string;
  readonly pid: number;
  readonly uid: number;
  readonly gid: number;
  readonly receivedAtMs: number;
}

export type UnixDatagramReceiver = (datagram: UnixDatagram) => void;

export interface UnixBindOptions {
  readonly unlink: boolean;
  readonly createPath: boolean;
  readonly keepFile?: boolean;
  readonly mode?: number;
  readonly uid?: number;
  readonly gid?: number;
  readonly owner?: UnixOwner;
}

export type UnixBindOutcome = { readonly close: () => void; readonly socket: UnixSocket } | { readonly errno: 'EADDRINUSE' | 'ENOENT' | 'EACCES' };

export interface UnixStreamHandlers {
  readonly onData: (text: string) => void;
  readonly onClose: () => void;
}

export interface UnixStreamEnd {
  readonly open: boolean;
  write(text: string): boolean;
  shutdownWrite(): void;
  close(): void;
  setHandlers(handlers: UnixStreamHandlers): void;
}

export interface UnixStreamAccess {
  readonly uid: number;
  readonly gids: readonly number[];
}

export interface UnixStreamListenOptions {
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly unlink?: boolean;
  readonly backlog?: number;
  readonly serialAccept?: boolean;
  readonly owner?: UnixOwner;
}

export type UnixStreamErrno = 'EADDRINUSE' | 'ENOENT' | 'EACCES' | 'ECONNREFUSED' | 'EAGAIN' | 'EPROTOTYPE';

export interface UnixStreamListener {
  readonly close: () => void;
  readonly acceptNext: () => void;
  readonly socket: UnixSocket;
}

export type UnixStreamListenOutcome = UnixStreamListener | { readonly errno: UnixStreamErrno };
export type UnixStreamConnectOutcome = UnixStreamEnd | { readonly errno: UnixStreamErrno };

export type UnixDatagramErrno = 'ENOENT' | 'EACCES' | 'ECONNREFUSED' | 'EPROTOTYPE';

export type UnixDatagramBindErrno = 'ENOENT' | 'EACCES' | 'EADDRINUSE';

export interface UnixDatagramEndpoint {
  readonly socket: UnixSocket;
  readonly refused: boolean;
  bind(path: string, options: UnixBindOptions, receiver: UnixDatagramReceiver): UnixDatagramBindErrno | null;
  connect(path: string, access: UnixStreamAccess): UnixDatagramErrno | null;
  send(text: string, receivedAtMs: number): boolean;
  close(): void;
}

const NOOP_HANDLERS: UnixStreamHandlers = { onData: () => undefined, onClose: () => undefined };

const DEFAULT_STREAM_BACKLOG = 128;

class StreamEnd implements UnixStreamEnd {
  peer: StreamEnd | null = null;
  released: (() => void) | null = null;
  private handlers: UnixStreamHandlers = NOOP_HANDLERS;
  private isOpen = true;
  private writeShutdown = false;
  private pending: string[] = [];
  private closeNotified = false;
  private closeRequested = false;

  get open(): boolean {
    return this.isOpen;
  }

  setHandlers(handlers: UnixStreamHandlers): void {
    this.handlers = handlers;
    const queued = this.pending;
    this.pending = [];
    for (const text of queued) handlers.onData(text);
    if (this.closeRequested && !this.closeNotified) {
      this.closeNotified = true;
      handlers.onClose();
    }
  }

  write(text: string): boolean {
    if (!this.isOpen || this.writeShutdown || this.peer === null || !this.peer.isOpen) return false;
    this.peer.receive(text);
    return true;
  }

  shutdownWrite(): void {
    if (!this.isOpen || this.writeShutdown) return;
    this.writeShutdown = true;
    this.peer?.peerClosed();
  }

  receive(text: string): void {
    if (this.handlers === NOOP_HANDLERS) this.pending.push(text);
    else this.handlers.onData(text);
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.released?.();
    this.peer?.peerClosed();
  }

  peerClosed(): void {
    this.closeRequested = true;
    if (this.handlers === NOOP_HANDLERS || this.closeNotified) return;
    this.closeNotified = true;
    this.handlers.onClose();
  }
}

interface StreamListenerEntry {
  readonly socket: UnixSocket;
  readonly onConnection: (server: UnixStreamEnd) => void;
  readonly serial: boolean;
  readonly owner: UnixOwner | undefined;
  armed: boolean;
}

interface DatagramEntry {
  readonly socket: UnixSocket;
  readonly receiver: UnixDatagramReceiver;
}

export class LocalDatagramSockets {
  readonly table = new UnixSocketTable();
  private readonly receivers = new Map<string, DatagramEntry>();
  private readonly streamListeners = new Map<string, StreamListenerEntry>();
  private readonly ends = new Map<UnixSocket, StreamEnd>();

  constructor(private readonly vfs: VirtualFileSystem) {}

  shareInodes(inodes: SocketInodes): void {
    this.table.shareInodes(inodes);
  }

  rows(): UnixSocketRow[] {
    return this.table.rows();
  }

  inodesHeldBy(pid: number): number[] {
    return this.table.inodesHeldBy(pid);
  }

  releaseHolder(pid: number): void {
    for (const socket of this.table.holdersOf(pid)) {
      socket.holders = socket.holders.filter((holder) => holder !== pid);
      if (socket.holders.length === 0) this.destroy(socket);
    }
  }

  bind(path: string, options: UnixBindOptions, receiver: UnixDatagramReceiver): UnixBindOutcome {
    const socket = this.table.create({ type: 'dgram', uid: options.owner?.uid ?? options.uid ?? 0 }, options.owner?.pid);
    const errno = this.bindDatagram(socket, path, options, receiver);
    if (errno !== null) {
      this.table.remove(socket);
      return { errno };
    }
    return {
      close: () => {
        const entry = this.receivers.get(path);
        if (entry?.socket === socket) {
          this.receivers.delete(path);
          if (options.keepFile !== true) this.vfs.deleteFile(path);
        }
        this.destroy(socket);
      },
      socket,
    };
  }

  openDatagram(owner?: UnixOwner): UnixDatagramEndpoint {
    const socket = this.table.create({ type: 'dgram', uid: owner?.uid ?? 0 }, owner?.pid);
    return new DatagramEndpoint(this, socket);
  }

  listenStream(
    path: string, options: UnixStreamListenOptions, onConnection: (server: UnixStreamEnd) => void,
  ): UnixStreamListenOutcome {
    const slash = path.lastIndexOf('/');
    const directory = slash <= 0 ? '/' : path.slice(0, slash);
    if (options.unlink === true && this.vfs.existsNoFollow(path)) {
      this.streamListeners.delete(path);
      this.vfs.deleteFile(path);
    }
    if (this.vfs.exists(path)) return { errno: 'EADDRINUSE' };
    if (this.vfs.getType(directory) !== 'directory') return { errno: 'ENOENT' };
    if (!this.vfs.createSocket(path, options.mode, options.uid, options.gid)) return { errno: 'EACCES' };
    const socket = this.table.create({ type: 'stream', uid: options.owner?.uid ?? options.uid }, options.owner?.pid);
    socket.path = path;
    socket.fileInode = this.vfs.resolveInode(path, false)?.id ?? null;
    socket.listening = true;
    socket.backlog = options.backlog ?? DEFAULT_STREAM_BACKLOG;
    const entry: StreamListenerEntry = {
      socket, onConnection, serial: options.serialAccept === true, owner: options.owner, armed: true,
    };
    this.streamListeners.set(path, entry);
    return {
      close: () => this.destroy(socket),
      acceptNext: () => {
        entry.armed = true;
        this.dispatch(entry);
      },
      socket,
    };
  }

  connectStream(
    path: string, access: UnixStreamAccess, handlers: UnixStreamHandlers, owner?: UnixOwner,
  ): UnixStreamConnectOutcome {
    const inode = this.vfs.resolveInode(path);
    if (inode === null) return { errno: 'ENOENT' };
    if (!this.mayWrite(inode, access)) return { errno: 'EACCES' };
    const entry = inode.type === 'socket' ? this.streamListeners.get(path) : undefined;
    if (entry === undefined) return { errno: inode.type === 'socket' && this.receivers.has(path) ? 'EPROTOTYPE' : 'ECONNREFUSED' };
    if (entry.serial && !entry.armed && entry.socket.embryos.length > entry.socket.backlog) return { errno: 'EAGAIN' };
    const clientSocket = this.table.create({ type: 'stream', uid: owner?.uid ?? access.uid }, owner?.pid);
    const embryo = this.table.createEmbryo(entry.socket, clientSocket);
    const client = new StreamEnd();
    const server = new StreamEnd();
    client.peer = server;
    server.peer = client;
    this.ends.set(clientSocket, client);
    this.ends.set(embryo, server);
    client.released = () => this.forget(clientSocket);
    server.released = () => this.forget(embryo);
    client.setHandlers(handlers);
    this.dispatch(entry);
    return client;
  }

  bindDatagram(
    socket: UnixSocket, path: string, options: UnixBindOptions, receiver: UnixDatagramReceiver,
  ): UnixDatagramBindErrno | null {
    const slash = path.lastIndexOf('/');
    const directory = slash <= 0 ? '/' : path.slice(0, slash);
    if (this.vfs.exists(path) || this.receivers.has(path)) {
      if (!options.unlink) return 'EADDRINUSE';
      this.receivers.delete(path);
      this.vfs.deleteFile(path);
    }
    if (!this.vfs.exists(directory)) {
      if (!options.createPath) return 'ENOENT';
      this.vfs.mkdirp(directory, 0o755, 0, 0);
    }
    if (!this.vfs.createSocket(path, options.mode ?? 0o666, options.uid ?? options.owner?.uid ?? 0, options.gid ?? 0)) return 'EACCES';
    socket.path = path;
    socket.fileInode = this.vfs.resolveInode(path, false)?.id ?? null;
    this.receivers.set(path, { socket, receiver });
    return null;
  }

  connectDatagram(socket: UnixSocket, path: string, access: UnixStreamAccess): UnixDatagramErrno | null {
    const inode = this.vfs.resolveInode(path);
    if (inode === null) return 'ENOENT';
    if (!this.mayWrite(inode, access)) return 'EACCES';
    const entry = inode.type === 'socket' ? this.receivers.get(path) : undefined;
    if (entry === undefined) return inode.type === 'socket' && this.streamListeners.has(path) ? 'EPROTOTYPE' : 'ECONNREFUSED';
    this.detachDatagramPeer(socket);
    socket.connected = true;
    socket.peer = entry.socket;
    entry.socket.datagramPeers += 1;
    return null;
  }

  deliverFrom(socket: UnixSocket, text: string, receivedAtMs: number, uid: number): boolean {
    const target = socket.peer;
    if (target === null || target.path === null) return false;
    const entry = this.receivers.get(target.path);
    if (entry === undefined || entry.socket !== target) return false;
    entry.receiver({ text, pid: socket.holders[0] ?? 0, uid, gid: 0, receivedAtMs });
    return true;
  }

  isReachable(socket: UnixSocket): boolean {
    const target = socket.peer;
    return target !== null && target.path !== null && this.receivers.get(target.path)?.socket === target;
  }

  releaseDatagram(socket: UnixSocket): void {
    this.destroy(socket);
  }

  isBound(path: string): boolean {
    return this.receivers.has(path);
  }

  send(path: string, datagram: UnixDatagram): boolean {
    const entry = this.receivers.get(path);
    if (entry === undefined) return false;
    entry.receiver(datagram);
    return true;
  }

  private dispatch(entry: StreamListenerEntry): void {
    while (entry.armed && entry.socket.embryos.length > 0) {
      const embryo = entry.socket.embryos[0];
      const server = this.ends.get(embryo);
      this.table.accept(embryo, entry.owner?.pid);
      if (entry.serial) entry.armed = false;
      if (server !== undefined) entry.onConnection(server);
    }
  }

  private forget(socket: UnixSocket): void {
    this.ends.delete(socket);
    this.table.remove(socket);
  }

  private detachDatagramPeer(socket: UnixSocket): void {
    if (socket.connected && socket.peer !== null) socket.peer.datagramPeers = Math.max(0, socket.peer.datagramPeers - 1);
    socket.connected = false;
    socket.peer = null;
  }

  private destroy(socket: UnixSocket): void {
    if (socket.listening) {
      for (const embryo of [...socket.embryos]) {
        const server = this.ends.get(embryo);
        this.table.remove(embryo);
        server?.close();
        this.ends.delete(embryo);
      }
      for (const [path, entry] of this.streamListeners) if (entry.socket === socket) this.streamListeners.delete(path);
      this.table.remove(socket);
      return;
    }
    const end = this.ends.get(socket);
    if (end !== undefined) {
      end.close();
      return;
    }
    if (socket.type === 'dgram') {
      for (const [path, entry] of this.receivers) if (entry.socket === socket) this.receivers.delete(path);
      this.detachDatagramPeer(socket);
    }
    this.table.remove(socket);
  }

  private mayWrite(inode: { uid: number; gid: number; permissions: number }, access: UnixStreamAccess): boolean {
    if (access.uid === 0) return true;
    if (inode.uid === access.uid) return (inode.permissions & 0o200) !== 0;
    if (access.gids.includes(inode.gid)) return (inode.permissions & 0o020) !== 0;
    return (inode.permissions & 0o002) !== 0;
  }
}

class DatagramEndpoint implements UnixDatagramEndpoint {
  private access: UnixStreamAccess = { uid: 0, gids: [] };
  private closed = false;

  constructor(private readonly sockets: LocalDatagramSockets, readonly socket: UnixSocket) {}

  get refused(): boolean {
    return !this.sockets.isReachable(this.socket);
  }

  bind(path: string, options: UnixBindOptions, receiver: UnixDatagramReceiver): UnixDatagramBindErrno | null {
    return this.sockets.bindDatagram(this.socket, path, options, receiver);
  }

  connect(path: string, access: UnixStreamAccess): UnixDatagramErrno | null {
    this.access = access;
    return this.sockets.connectDatagram(this.socket, path, access);
  }

  send(text: string, receivedAtMs: number): boolean {
    if (this.closed) return false;
    return this.sockets.deliverFrom(this.socket, text, receivedAtMs, this.access.uid);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.sockets.releaseDatagram(this.socket);
  }
}
