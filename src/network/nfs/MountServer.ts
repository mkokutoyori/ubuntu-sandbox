import type { RpcCallContext, RpcProgramHandler } from './RpcService';
import { MOUNT_PROGRAM, MOUNT_V3, MountProcedure, MountStatus, MNTPATHLEN } from './wire/NfsConstants';
import { RpcAuthFlavor } from './wire/RpcMessage';
import {
  decodeMountPath, encodeExportList, encodeMountList, encodeMountResult,
} from './wire/NfsCodec';
import type { ExportNode, MountEntryRecord, MountResult } from './wire/NfsTypes';
import { clientFor, type ExportEntry } from './ExportTable';
import type { NfsFileHandleTable } from './NfsFileHandleTable';
import type { NfsExportedFileSystem } from './NfsExportedFileSystem';
import { Ftype3 } from './wire/NfsConstants';

export interface MountServerHost {
  exports(): readonly ExportEntry[];
  fileSystem(): NfsExportedFileSystem;
  hostnameOf(ip: string): string | null;
}

export class MountServer implements RpcProgramHandler {
  readonly program = MOUNT_PROGRAM;
  readonly lowVersion = MOUNT_V3;
  readonly highVersion = MOUNT_V3;

  private readonly mounted: MountEntryRecord[] = [];

  constructor(
    private readonly host: MountServerHost,
    private readonly handles: NfsFileHandleTable,
  ) {}

  hasProcedure(_version: number, procedure: number): boolean {
    return procedure >= MountProcedure.NULL && procedure <= MountProcedure.EXPORT;
  }

  activeMounts(): readonly MountEntryRecord[] {
    return this.mounted;
  }

  invoke(context: RpcCallContext): Uint8Array {
    switch (context.call.procedure as MountProcedure) {
      case MountProcedure.NULL:
        return new Uint8Array(0);
      case MountProcedure.MNT:
        return encodeMountResult(this.mount(decodeMountPath(context.call.payload), context.peerIp));
      case MountProcedure.DUMP:
        return encodeMountList(this.mounted);
      case MountProcedure.UMNT:
        this.unmount(decodeMountPath(context.call.payload), context.peerIp);
        return new Uint8Array(0);
      case MountProcedure.UMNTALL:
        this.unmountAll(context.peerIp);
        return new Uint8Array(0);
      case MountProcedure.EXPORT:
        return encodeExportList(this.exportNodes());
      default:
        return new Uint8Array(0);
    }
  }

  mount(path: string, peerIp: string): MountResult {
    if (path.length > MNTPATHLEN) return { status: MountStatus.MNT3ERR_NAMETOOLONG };
    const entry = this.host.exports().find((e) => e.path === path);
    if (!entry) return { status: MountStatus.MNT3ERR_NOENT };
    const client = clientFor(entry, peerIp, this.host.hostnameOf(peerIp));
    if (!client) return { status: MountStatus.MNT3ERR_ACCES };
    const stat = this.host.fileSystem().statPath(path);
    if (!stat) return { status: MountStatus.MNT3ERR_NOENT };
    if (stat.type !== Ftype3.NF3DIR) return { status: MountStatus.MNT3ERR_NOTDIR };
    const hostname = this.host.hostnameOf(peerIp) ?? peerIp;
    if (!this.mounted.some((m) => m.hostname === hostname && m.directory === path)) {
      this.mounted.push({ hostname, directory: path });
    }
    return mountOutcome(this.handles.handleFor({ exportPath: path, path }));
  }

  private unmount(path: string, peerIp: string): void {
    const hostname = this.host.hostnameOf(peerIp) ?? peerIp;
    const index = this.mounted.findIndex((m) => m.hostname === hostname && m.directory === path);
    if (index >= 0) this.mounted.splice(index, 1);
  }

  private unmountAll(peerIp: string): void {
    const hostname = this.host.hostnameOf(peerIp) ?? peerIp;
    for (let i = this.mounted.length - 1; i >= 0; i--) {
      if (this.mounted[i].hostname === hostname) this.mounted.splice(i, 1);
    }
  }

  exportNodes(): ExportNode[] {
    return this.host.exports().map((entry) => ({
      directory: entry.path,
      groups: entry.clients.map((client) => client.pattern),
    }));
  }
}

function mountOutcome(fileHandle: Uint8Array): MountResult {
  return {
    status: MountStatus.MNT3_OK,
    fileHandle,
    authFlavors: [RpcAuthFlavor.AUTH_SYS, RpcAuthFlavor.AUTH_NONE],
  };
}
