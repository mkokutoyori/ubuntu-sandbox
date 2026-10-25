import type { VirtualFileSystem } from '../VirtualFileSystem';

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
}

export type UnixBindOutcome = { readonly close: () => void } | { readonly errno: 'EADDRINUSE' | 'ENOENT' | 'EACCES' };

export interface UnixStreamHandlers {
  readonly onData: (text: string) => void;
  readonly onClose: () => void;
}

export interface UnixStreamEnd {
  readonly open: boolean;
  write(text: string): boolean;
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
}

export type UnixStreamErrno = 'EADDRINUSE' | 'ENOENT' | 'EACCES' | 'ECONNREFUSED';

export type UnixStreamListenOutcome = { readonly close: () => void } | { readonly errno: UnixStreamErrno };
export type UnixStreamConnectOutcome = UnixStreamEnd | { readonly errno: UnixStreamErrno };

const NOOP_HANDLERS: UnixStreamHandlers = { onData: () => undefined, onClose: () => undefined };

class StreamEnd implements UnixStreamEnd {
  peer: StreamEnd | null = null;
  private handlers: UnixStreamHandlers = NOOP_HANDLERS;
  private isOpen = true;
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
    if (!this.isOpen || this.peer === null || !this.peer.isOpen) return false;
    this.peer.receive(text);
    return true;
  }

  receive(text: string): void {
    if (this.handlers === NOOP_HANDLERS) this.pending.push(text);
    else this.handlers.onData(text);
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.peer?.peerClosed();
  }

  peerClosed(): void {
    this.closeRequested = true;
    if (this.handlers === NOOP_HANDLERS || this.closeNotified) return;
    this.closeNotified = true;
    this.handlers.onClose();
  }
}

export class LocalDatagramSockets {
  private readonly receivers = new Map<string, UnixDatagramReceiver>();
  private readonly streamListeners = new Map<string, (server: UnixStreamEnd) => void>();

  constructor(private readonly vfs: VirtualFileSystem) {}

  bind(path: string, options: UnixBindOptions, receiver: UnixDatagramReceiver): UnixBindOutcome {
    const slash = path.lastIndexOf('/');
    const directory = slash <= 0 ? '/' : path.slice(0, slash);
    if (this.vfs.exists(path) || this.receivers.has(path)) {
      if (!options.unlink) return { errno: 'EADDRINUSE' };
      this.receivers.delete(path);
      this.vfs.deleteFile(path);
    }
    if (!this.vfs.exists(directory)) {
      if (!options.createPath) return { errno: 'ENOENT' };
      this.vfs.mkdirp(directory, 0o755, 0, 0);
    }
    if (!this.vfs.createSocket(path, 0o666, 0, 0)) return { errno: 'EACCES' };
    this.receivers.set(path, receiver);
    return {
      close: () => {
        if (this.receivers.get(path) !== receiver) return;
        this.receivers.delete(path);
        this.vfs.deleteFile(path);
      },
    };
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
    this.streamListeners.set(path, onConnection);
    return {
      close: () => {
        if (this.streamListeners.get(path) === onConnection) this.streamListeners.delete(path);
      },
    };
  }

  connectStream(path: string, access: UnixStreamAccess, handlers: UnixStreamHandlers): UnixStreamConnectOutcome {
    const inode = this.vfs.resolveInode(path);
    if (inode === null) return { errno: 'ENOENT' };
    if (!this.mayWrite(inode, access)) return { errno: 'EACCES' };
    const listener = inode.type === 'socket' ? this.streamListeners.get(path) : undefined;
    if (listener === undefined) return { errno: 'ECONNREFUSED' };
    const client = new StreamEnd();
    const server = new StreamEnd();
    client.peer = server;
    server.peer = client;
    client.setHandlers(handlers);
    listener(server);
    return client;
  }

  private mayWrite(inode: { uid: number; gid: number; permissions: number }, access: UnixStreamAccess): boolean {
    if (access.uid === 0) return true;
    if (inode.uid === access.uid) return (inode.permissions & 0o200) !== 0;
    if (access.gids.includes(inode.gid)) return (inode.permissions & 0o020) !== 0;
    return (inode.permissions & 0o002) !== 0;
  }

  isBound(path: string): boolean {
    return this.receivers.has(path);
  }

  send(path: string, datagram: UnixDatagram): boolean {
    const receiver = this.receivers.get(path);
    if (receiver === undefined) return false;
    receiver(datagram);
    return true;
  }
}
