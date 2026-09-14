import type { TcpStack, TcpSocket } from '@/network/tcp/TcpStack';
import { IPAddress } from '@/network/core/types';
import {
  MOUNT_PROGRAM, MOUNT_V3, MountProcedure, MountStatus, NFS_PORT, NFS_PROGRAM, NFS_V3,
  NfsProcedure, NfsStatus, StableHow, NFS3_MAXDATA, NFS3_COOKIEVERFSIZE, CreateMode3,
} from './wire/NfsConstants';
import {
  AUTH_NONE, RpcAcceptState, RpcReplyState, decodeRpcReply, encodeAuthSys, encodeRpcCall,
  frameRecord, readRecord, type RpcOpaqueAuth,
} from './wire/RpcMessage';
import {
  PORTMAP_PORT, PORTMAP_PROGRAM, PORTMAP_V2, PortmapProcedure, RpcProtocol,
  encodeMapping, decodePort,
} from './wire/PortmapCodec';
import * as codec from './wire/NfsCodec';
import type { DirEntry3, Fattr3, NfsFileHandle } from './wire/NfsTypes';

export interface NfsClientTransport {
  call(ip: IPAddress, port: number, request: Uint8Array): Uint8Array | null;
}

export class TcpRpcTransport implements NfsClientTransport {
  constructor(private readonly tcpStack: TcpStack) {}

  call(ip: IPAddress, port: number, request: Uint8Array): Uint8Array | null {
    let answer: Uint8Array | null = null;
    let pending = new Uint8Array(0);
    const socket: TcpSocket | null = this.tcpStack.connect(ip.toString(), port);
    if (!socket) return null;
    socket.onData((data) => {
      const chunk = data instanceof Uint8Array
        ? data
        : Uint8Array.from(String(data), (c) => c.charCodeAt(0) & 0xff);
      const merged = new Uint8Array(pending.length + chunk.length);
      merged.set(pending, 0);
      merged.set(chunk, pending.length);
      pending = merged;
      const record = readRecord(pending);
      if (record) {
        answer = record.message;
        pending = pending.subarray(record.consumed);
      }
    });
    socket.send(frameRecord(request));
    socket.close();
    return answer;
  }
}

export interface NfsClientIdentity {
  readonly machineName: string;
  readonly uid: number;
  readonly gid: number;
  readonly gids: readonly number[];
}

export class NfsClient {
  private xid = 1;

  constructor(
    private readonly transport: NfsClientTransport,
    private readonly identity: NfsClientIdentity,
  ) {}

  private credential(): RpcOpaqueAuth {
    return encodeAuthSys({
      stamp: 0,
      machineName: this.identity.machineName,
      uid: this.identity.uid,
      gid: this.identity.gid,
      gids: this.identity.gids,
    });
  }

  private invoke(
    ip: IPAddress, port: number, program: number, version: number,
    procedure: number, payload: Uint8Array,
  ): Uint8Array | null {
    const request = encodeRpcCall({
      xid: this.xid++,
      rpcVersion: 2,
      program,
      programVersion: version,
      procedure,
      credential: this.credential(),
      verifier: AUTH_NONE,
      payload,
    });
    const raw = this.transport.call(ip, port, request);
    if (!raw) return null;
    let reply;
    try {
      reply = decodeRpcReply(raw);
    } catch {
      return null;
    }
    if (reply.state !== RpcReplyState.MSG_ACCEPTED) return null;
    if (reply.acceptState !== RpcAcceptState.SUCCESS) return null;
    return reply.payload;
  }

  queryPort(ip: IPAddress, program: number, version: number): number {
    const payload = encodeMapping({ program, version, protocol: RpcProtocol.TCP, port: 0 });
    const answer = this.invoke(
      ip, PORTMAP_PORT, PORTMAP_PROGRAM, PORTMAP_V2, PortmapProcedure.GETPORT, payload);
    return answer ? decodePort(answer) : 0;
  }

  mount(ip: IPAddress, exportPath: string, mountPort: number): NfsFileHandle | MountStatus {
    const answer = this.invoke(
      ip, mountPort, MOUNT_PROGRAM, MOUNT_V3, MountProcedure.MNT,
      codec.encodeMountPath(exportPath));
    if (!answer) return MountStatus.MNT3ERR_SERVERFAULT;
    const result = codec.decodeMountResult(answer);
    return result.status === MountStatus.MNT3_OK ? result.fileHandle : result.status;
  }

  unmount(ip: IPAddress, exportPath: string, mountPort: number): void {
    this.invoke(ip, mountPort, MOUNT_PROGRAM, MOUNT_V3, MountProcedure.UMNT,
      codec.encodeMountPath(exportPath));
  }

  listMounts(ip: IPAddress, mountPort: number): ReturnType<typeof codec.decodeMountList> {
    const answer = this.invoke(
      ip, mountPort, MOUNT_PROGRAM, MOUNT_V3, MountProcedure.DUMP, new Uint8Array(0));
    return answer ? codec.decodeMountList(answer) : [];
  }

  listExports(ip: IPAddress, mountPort: number): ReturnType<typeof codec.decodeExportList> {
    const answer = this.invoke(
      ip, mountPort, MOUNT_PROGRAM, MOUNT_V3, MountProcedure.EXPORT, new Uint8Array(0));
    return answer ? codec.decodeExportList(answer) : [];
  }

  private nfs(ip: IPAddress, procedure: NfsProcedure, payload: Uint8Array): Uint8Array | null {
    return this.invoke(ip, NFS_PORT, NFS_PROGRAM, NFS_V3, procedure, payload);
  }

  getAttr(ip: IPAddress, handle: NfsFileHandle): Fattr3 | null {
    const answer = this.nfs(ip, NfsProcedure.GETATTR, codec.encodeGetAttrArgs({ object: handle }));
    if (!answer) return null;
    const result = codec.decodeGetAttrResult(answer);
    return result.status === NfsStatus.NFS3_OK ? result.attributes : null;
  }

  lookup(ip: IPAddress, dir: NfsFileHandle, name: string): NfsFileHandle | NfsStatus {
    const answer = this.nfs(ip, NfsProcedure.LOOKUP, codec.encodeLookupArgs({ what: { dir, name } }));
    if (!answer) return NfsStatus.NFS3ERR_IO;
    const result = codec.decodeLookupResult(answer);
    return result.status === NfsStatus.NFS3_OK ? result.object : result.status;
  }

  resolvePath(ip: IPAddress, root: NfsFileHandle, relative: string): NfsFileHandle | NfsStatus {
    let handle = root;
    for (const part of relative.split('/').filter((p) => p !== '' && p !== '.')) {
      const next = this.lookup(ip, handle, part);
      if (next instanceof Uint8Array) handle = next;
      else return next;
    }
    return handle;
  }

  read(ip: IPAddress, handle: NfsFileHandle, size: number): Uint8Array | NfsStatus {
    const chunks: Uint8Array[] = [];
    let offset = 0;
    for (;;) {
      const wanted = Math.min(NFS3_MAXDATA, Math.max(0, size - offset));
      if (wanted === 0) break;
      const answer = this.nfs(ip, NfsProcedure.READ, codec.encodeReadArgs({
        file: handle, offset: BigInt(offset), count: wanted,
      }));
      if (!answer) return NfsStatus.NFS3ERR_IO;
      const result = codec.decodeReadResult(answer);
      if (result.status !== NfsStatus.NFS3_OK) return result.status;
      chunks.push(result.data);
      offset += result.data.length;
      if (result.eof || result.data.length === 0) break;
    }
    const total = chunks.reduce((sum, c) => sum + c.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  }

  write(ip: IPAddress, handle: NfsFileHandle, data: Uint8Array): NfsStatus {
    let offset = 0;
    while (offset < data.length) {
      const slice = data.subarray(offset, offset + NFS3_MAXDATA);
      const answer = this.nfs(ip, NfsProcedure.WRITE, codec.encodeWriteArgs({
        file: handle,
        offset: BigInt(offset),
        count: slice.length,
        stable: StableHow.FILE_SYNC,
        data: slice,
      }));
      if (!answer) return NfsStatus.NFS3ERR_IO;
      const result = codec.decodeWriteResult(answer);
      if (result.status !== NfsStatus.NFS3_OK) return result.status;
      offset += result.count === 0 ? slice.length : result.count;
    }
    return NfsStatus.NFS3_OK;
  }

  create(ip: IPAddress, dir: NfsFileHandle, name: string, mode: number): NfsFileHandle | NfsStatus {
    const answer = this.nfs(ip, NfsProcedure.CREATE, codec.encodeCreateArgs({
      where: { dir, name },
      how: { mode: CreateMode3.UNCHECKED, attributes: { mode } },
    }));
    if (!answer) return NfsStatus.NFS3ERR_IO;
    const result = codec.decodeCreateResult(answer);
    if (result.status !== NfsStatus.NFS3_OK) return result.status;
    return result.object ?? NfsStatus.NFS3ERR_SERVERFAULT;
  }

  mkdir(ip: IPAddress, dir: NfsFileHandle, name: string, mode: number): NfsFileHandle | NfsStatus {
    const answer = this.nfs(ip, NfsProcedure.MKDIR, codec.encodeMkdirArgs({
      where: { dir, name }, attributes: { mode },
    }));
    if (!answer) return NfsStatus.NFS3ERR_IO;
    const result = codec.decodeCreateResult(answer);
    if (result.status !== NfsStatus.NFS3_OK) return result.status;
    return result.object ?? NfsStatus.NFS3ERR_SERVERFAULT;
  }

  remove(ip: IPAddress, dir: NfsFileHandle, name: string): NfsStatus {
    const answer = this.nfs(ip, NfsProcedure.REMOVE, codec.encodeRemoveArgs({
      object: { dir, name },
    }));
    if (!answer) return NfsStatus.NFS3ERR_IO;
    return codec.decodeRemoveResult(answer).status;
  }

  removeDirectory(ip: IPAddress, dir: NfsFileHandle, name: string): NfsStatus {
    const answer = this.nfs(ip, NfsProcedure.RMDIR, codec.encodeRemoveArgs({
      object: { dir, name },
    }));
    if (!answer) return NfsStatus.NFS3ERR_IO;
    return codec.decodeRemoveResult(answer).status;
  }

  rename(
    ip: IPAddress, fromDir: NfsFileHandle, fromName: string,
    toDir: NfsFileHandle, toName: string,
  ): NfsStatus {
    const answer = this.nfs(ip, NfsProcedure.RENAME, codec.encodeRenameArgs({
      from: { dir: fromDir, name: fromName },
      to: { dir: toDir, name: toName },
    }));
    if (!answer) return NfsStatus.NFS3ERR_IO;
    return codec.decodeRenameResult(answer).status;
  }

  readDir(ip: IPAddress, dir: NfsFileHandle): readonly DirEntry3[] | NfsStatus {
    const answer = this.nfs(ip, NfsProcedure.READDIR, codec.encodeReadDirArgs({
      dir,
      cookie: 0n,
      cookieVerifier: new Uint8Array(NFS3_COOKIEVERFSIZE),
      count: NFS3_MAXDATA,
    }));
    if (!answer) return NfsStatus.NFS3ERR_IO;
    const result = codec.decodeReadDirResult(answer);
    return result.status === NfsStatus.NFS3_OK ? result.entries : result.status;
  }

  fsStat(ip: IPAddress, root: NfsFileHandle): ReturnType<typeof codec.decodeFsStatResult> | null {
    const answer = this.nfs(ip, NfsProcedure.FSSTAT, codec.encodeFsStatArgs({ fsroot: root }));
    return answer ? codec.decodeFsStatResult(answer) : null;
  }
}
