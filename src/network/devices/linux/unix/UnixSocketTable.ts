import { SocketInodes } from '../../../core/SocketInodes';

export type UnixSocketType = 'stream' | 'dgram' | 'seqpacket';

export type UnixSocketState = 'unconnected' | 'listening' | 'connecting' | 'connected';

export interface UnixSocket {
  inode: number;
  readonly address: number;
  readonly type: UnixSocketType;
  readonly uid: number;
  path: string | null;
  fileInode: number | null;
  listening: boolean;
  backlog: number;
  connected: boolean;
  peer: UnixSocket | null;
  embryos: UnixSocket[];
  embryoOf: UnixSocket | null;
  holders: number[];
  datagramPeers: number;
  unread: number;
}

export interface UnixSocketRow {
  readonly inode: number;
  readonly address: number;
  readonly type: UnixSocketType;
  readonly state: UnixSocketState;
  readonly path: string | null;
  readonly fileInode: number | null;
  readonly peerInode: number;
  readonly refCount: number;
  readonly backlog: number;
  readonly pending: number;
  readonly pendingPeers: readonly number[];
  readonly holders: readonly number[];
  readonly uid: number;
  readonly unread: number;
}

export interface UnixSocketInit {
  readonly type: UnixSocketType;
  readonly uid: number;
}

const ADDRESS_STRIDE = 0x9e3779b1;

export class UnixSocketTable {
  private readonly sockets = new Set<UnixSocket>();
  private addressSeed = 0;
  private inodes: SocketInodes;

  constructor(inodes: SocketInodes = new SocketInodes()) {
    this.inodes = inodes;
  }

  shareInodes(inodes: SocketInodes): void {
    this.inodes = inodes;
  }

  create(init: UnixSocketInit, holder?: number): UnixSocket {
    const socket = this.blank(init, this.inodes.next());
    if (holder !== undefined) socket.holders.push(holder);
    this.sockets.add(socket);
    return socket;
  }

  createEmbryo(listener: UnixSocket, client: UnixSocket): UnixSocket {
    const embryo = this.blank({ type: listener.type, uid: listener.uid }, 0);
    embryo.path = listener.path;
    embryo.fileInode = listener.fileInode;
    embryo.connected = true;
    embryo.embryoOf = listener;
    embryo.peer = client;
    client.peer = embryo;
    client.connected = true;
    listener.embryos.push(embryo);
    this.sockets.add(embryo);
    return embryo;
  }

  accept(embryo: UnixSocket, holder?: number): void {
    const listener = embryo.embryoOf;
    if (listener !== null) listener.embryos = listener.embryos.filter((candidate) => candidate !== embryo);
    embryo.embryoOf = null;
    embryo.inode = this.inodes.next();
    if (holder !== undefined) embryo.holders.push(holder);
  }

  remove(socket: UnixSocket): void {
    this.sockets.delete(socket);
    if (socket.embryoOf !== null) {
      socket.embryoOf.embryos = socket.embryoOf.embryos.filter((candidate) => candidate !== socket);
      socket.embryoOf = null;
    }
    if (socket.peer !== null && socket.peer.peer === socket) socket.peer.peer = null;
    socket.peer = null;
  }

  hold(socket: UnixSocket, pid: number): void {
    if (!socket.holders.includes(pid)) socket.holders.push(pid);
  }

  holdersOf(pid: number): UnixSocket[] {
    return [...this.sockets].filter((socket) => socket.holders.includes(pid));
  }

  inodesHeldBy(pid: number): number[] {
    return this.holdersOf(pid).filter((socket) => socket.inode !== 0).map((socket) => socket.inode);
  }

  count(): number {
    return [...this.sockets].filter((socket) => socket.inode !== 0).length;
  }

  rows(): UnixSocketRow[] {
    return [...this.sockets].map((socket) => this.rowOf(socket));
  }

  clear(): void {
    this.sockets.clear();
  }

  private blank(init: UnixSocketInit, inode: number): UnixSocket {
    this.addressSeed += 1;
    return {
      inode, address: (this.addressSeed * ADDRESS_STRIDE) >>> 0, type: init.type, uid: init.uid, path: null, fileInode: null,
      listening: false, backlog: 0, connected: false, peer: null, embryos: [], embryoOf: null, holders: [], datagramPeers: 0, unread: 0,
    };
  }

  private stateOf(socket: UnixSocket): UnixSocketState {
    if (socket.listening) return 'listening';
    if (socket.embryoOf !== null) return 'connecting';
    if (socket.connected || socket.datagramPeers > 0) return 'connected';
    return 'unconnected';
  }

  private refCountOf(socket: UnixSocket): number {
    if (socket.listening) return 2;
    if (socket.type === 'dgram') return 2 + socket.datagramPeers;
    return 2 + (socket.peer !== null ? 1 : 0);
  }

  private rowOf(socket: UnixSocket): UnixSocketRow {
    return {
      inode: socket.inode,
      address: socket.address,
      type: socket.type,
      state: this.stateOf(socket),
      path: socket.path,
      fileInode: socket.fileInode,
      peerInode: socket.peer === null ? 0 : socket.peer.inode,
      refCount: this.refCountOf(socket),
      backlog: socket.backlog,
      pending: socket.embryos.length,
      pendingPeers: socket.embryos.map((embryo) => embryo.peer?.inode ?? 0),
      holders: [...socket.holders],
      uid: socket.uid,
      unread: socket.unread,
    };
  }
}
