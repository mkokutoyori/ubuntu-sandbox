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

export class LocalDatagramSockets {
  private readonly receivers = new Map<string, UnixDatagramReceiver>();

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
