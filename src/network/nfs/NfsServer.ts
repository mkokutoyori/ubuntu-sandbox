import type { RpcCallContext, RpcProgramHandler } from './RpcService';
import {
  ACCESS3_DELETE, ACCESS3_EXTEND, ACCESS3_MODIFY, CreateMode3, FSF3_CANSETTIME,
  FSF3_HOMOGENEOUS, FSF3_LINK, FSF3_SYMLINK, Ftype3, NFS3_MAXDATA, NFS3_MAXNAMLEN,
  NFS_PROGRAM, NFS_V3, NfsProcedure, NfsStatus, StableHow, TimeHow,
} from './wire/NfsConstants';
import * as codec from './wire/NfsCodec';
import type {
  DirEntry3, DirEntryPlus3, DirOpArgs3, Fattr3, NfsTime3, Sattr3, WccData,
} from './wire/NfsTypes';
import { decodeAuthSys } from './wire/RpcMessage';
import type { NfsCredentials, NfsExportedFileSystem, NfsFileStat } from './NfsExportedFileSystem';
import { clientFor, exportCovering, type ExportClient, type ExportEntry } from './ExportTable';
import { NfsFileHandleTable, type NfsHandleTarget } from './NfsFileHandleTable';

const ANONYMOUS: NfsCredentials = { uid: 65534, gid: 65534, gids: [] };
const WRITE_VERIFIER = Uint8Array.from([0x55, 0x62, 0x75, 0x6e, 0x74, 0x75, 0x4e, 0x66]);

export interface NfsServerHost {
  exports(): readonly ExportEntry[];
  fileSystem(): NfsExportedFileSystem;
  hostnameOf(ip: string): string | null;
  fsid(): number;
}

function timeOf(date: Date): NfsTime3 {
  const millis = date.getTime();
  return { seconds: Math.floor(millis / 1000), nseconds: (millis % 1000) * 1_000_000 };
}

function joinPath(directory: string, name: string): string {
  const base = directory.replace(/\/+$/, '');
  return `${base}/${name}`;
}

function parentOf(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const cut = trimmed.lastIndexOf('/');
  return cut <= 0 ? '/' : trimmed.slice(0, cut);
}

export class NfsServer implements RpcProgramHandler {
  readonly program = NFS_PROGRAM;
  readonly lowVersion = NFS_V3;
  readonly highVersion = NFS_V3;

  constructor(
    private readonly host: NfsServerHost,
    private readonly handles: NfsFileHandleTable,
  ) {}

  hasProcedure(_version: number, procedure: number): boolean {
    return procedure >= NfsProcedure.NULL && procedure <= NfsProcedure.COMMIT;
  }

  invoke(context: RpcCallContext): Uint8Array {
    const fs = this.host.fileSystem();
    const who = this.credentialsOf(context);
    const payload = context.call.payload;
    switch (context.call.procedure as NfsProcedure) {
      case NfsProcedure.NULL: return new Uint8Array(0);
      case NfsProcedure.GETATTR: return this.getAttr(payload, fs);
      case NfsProcedure.SETATTR: return this.setAttr(payload, fs, who, context);
      case NfsProcedure.LOOKUP: return this.lookup(payload, fs);
      case NfsProcedure.ACCESS: return this.access(payload, fs, who, context);
      case NfsProcedure.READLINK: return this.readLink(payload, fs);
      case NfsProcedure.READ: return this.read(payload, fs, who, context);
      case NfsProcedure.WRITE: return this.write(payload, fs, who, context);
      case NfsProcedure.CREATE: return this.create(payload, fs, who, context);
      case NfsProcedure.MKDIR: return this.mkdir(payload, fs, who, context);
      case NfsProcedure.SYMLINK: return this.symlink(payload, fs, who, context);
      case NfsProcedure.MKNOD: return this.mknod(payload);
      case NfsProcedure.REMOVE: return this.remove(payload, fs, who, context, false);
      case NfsProcedure.RMDIR: return this.remove(payload, fs, who, context, true);
      case NfsProcedure.RENAME: return this.rename(payload, fs, who, context);
      case NfsProcedure.LINK: return this.link(payload);
      case NfsProcedure.READDIR: return this.readDir(payload, fs);
      case NfsProcedure.READDIRPLUS: return this.readDirPlus(payload, fs);
      case NfsProcedure.FSSTAT: return this.fsStat(payload, fs);
      case NfsProcedure.FSINFO: return this.fsInfo(payload, fs);
      case NfsProcedure.PATHCONF: return this.pathConf(payload, fs);
      case NfsProcedure.COMMIT: return this.commit(payload, fs);
      default: return new Uint8Array(0);
    }
  }

  private credentialsOf(context: RpcCallContext): NfsCredentials {
    const auth = decodeAuthSys(context.call.credential);
    if (!auth) return ANONYMOUS;
    return { uid: auth.uid, gid: auth.gid, gids: auth.gids };
  }

  private clientOf(target: NfsHandleTarget, context: RpcCallContext): ExportClient | null {
    const entry = exportCovering(this.host.exports(), target.path)
      ?? this.host.exports().find((e) => e.path === target.exportPath)
      ?? null;
    if (!entry) return null;
    return clientFor(entry, context.peerIp, this.host.hostnameOf(context.peerIp));
  }

  private effective(who: NfsCredentials, client: ExportClient | null): NfsCredentials {
    if (!client) return ANONYMOUS;
    if (client.allSquash) return { uid: client.anonUid, gid: client.anonGid, gids: [] };
    if (client.rootSquash && who.uid === 0) return { uid: client.anonUid, gid: client.anonGid, gids: [] };
    return who;
  }

  private attributesOf(path: string, fs: NfsExportedFileSystem): Fattr3 | null {
    const stat = fs.statPath(path);
    return stat ? this.toFattr3(stat) : null;
  }

  private toFattr3(stat: NfsFileStat): Fattr3 {
    return {
      type: stat.type,
      mode: stat.mode & 0o7777,
      nlink: stat.nlink,
      uid: stat.uid,
      gid: stat.gid,
      size: BigInt(stat.size),
      used: BigInt(Math.ceil(stat.size / 512) * 512),
      rdev: { specdata1: 0, specdata2: 0 },
      fsid: BigInt(this.host.fsid()),
      fileid: BigInt(stat.fileid),
      atime: timeOf(stat.atime),
      mtime: timeOf(stat.mtime),
      ctime: timeOf(stat.ctime),
    };
  }

  private wccOf(path: string, before: Fattr3 | null, fs: NfsExportedFileSystem): WccData {
    return {
      before: before ? { size: before.size, mtime: before.mtime, ctime: before.ctime } : null,
      after: this.attributesOf(path, fs),
    };
  }

  private resolveDir(args: DirOpArgs3): { target: NfsHandleTarget; child: string } | null {
    const parent = this.handles.resolve(args.dir);
    if (!parent) return null;
    return { target: parent, child: joinPath(parent.path, args.name) };
  }

  private getAttr(payload: Uint8Array, fs: NfsExportedFileSystem): Uint8Array {
    const args = codec.decodeGetAttrArgs(payload);
    const target = this.handles.resolve(args.object);
    if (!target) return codec.encodeGetAttrResult({ status: NfsStatus.NFS3ERR_BADHANDLE });
    const attributes = this.attributesOf(target.path, fs);
    return codec.encodeGetAttrResult(attributes
      ? { status: NfsStatus.NFS3_OK, attributes }
      : { status: NfsStatus.NFS3ERR_STALE });
  }

  private setAttr(
    payload: Uint8Array, fs: NfsExportedFileSystem,
    who: NfsCredentials, context: RpcCallContext,
  ): Uint8Array {
    const args = codec.decodeSetAttrArgs(payload);
    const target = this.handles.resolve(args.object);
    if (!target) {
      return codec.encodeSetAttrResult({
        status: NfsStatus.NFS3ERR_BADHANDLE, objectWcc: { before: null, after: null },
      });
    }
    const before = this.attributesOf(target.path, fs);
    const client = this.clientOf(target, context);
    if (!client) {
      return codec.encodeSetAttrResult({
        status: NfsStatus.NFS3ERR_ACCES, objectWcc: this.wccOf(target.path, before, fs),
      });
    }
    if (client.readOnly || fs.isReadOnly(target.path)) {
      return codec.encodeSetAttrResult({
        status: NfsStatus.NFS3ERR_ROFS, objectWcc: this.wccOf(target.path, before, fs),
      });
    }
    if (args.guardCtime && before
      && (before.ctime.seconds !== args.guardCtime.seconds
        || before.ctime.nseconds !== args.guardCtime.nseconds)) {
      return codec.encodeSetAttrResult({
        status: NfsStatus.NFS3ERR_NOT_SYNC, objectWcc: this.wccOf(target.path, before, fs),
      });
    }
    const effective = this.effective(who, client);
    let status = fs.setAttributes(target.path, sattrToChanges(args.newAttributes), effective);
    if (status === NfsStatus.NFS3_OK && args.newAttributes.size !== undefined) {
      status = fs.truncateFile(target.path, Number(args.newAttributes.size), effective);
    }
    return codec.encodeSetAttrResult({ status, objectWcc: this.wccOf(target.path, before, fs) });
  }

  private lookup(payload: Uint8Array, fs: NfsExportedFileSystem): Uint8Array {
    const args = codec.decodeLookupArgs(payload);
    const resolved = this.resolveDir(args.what);
    if (!resolved) {
      return codec.encodeLookupResult({ status: NfsStatus.NFS3ERR_BADHANDLE, dirAttributes: null });
    }
    const dirAttributes = this.attributesOf(resolved.target.path, fs);
    if (args.what.name.length > NFS3_MAXNAMLEN) {
      return codec.encodeLookupResult({ status: NfsStatus.NFS3ERR_NAMETOOLONG, dirAttributes });
    }
    const childPath = args.what.name === '..'
      ? parentOf(resolved.target.path)
      : args.what.name === '.' ? resolved.target.path : resolved.child;
    const objectAttributes = this.attributesOf(childPath, fs);
    if (!objectAttributes) {
      return codec.encodeLookupResult({ status: NfsStatus.NFS3ERR_NOENT, dirAttributes });
    }
    return codec.encodeLookupResult({
      status: NfsStatus.NFS3_OK,
      object: this.handles.handleFor({ exportPath: resolved.target.exportPath, path: childPath }),
      objectAttributes,
      dirAttributes,
    });
  }

  private access(
    payload: Uint8Array, fs: NfsExportedFileSystem,
    who: NfsCredentials, context: RpcCallContext,
  ): Uint8Array {
    const args = codec.decodeAccessArgs(payload);
    const target = this.handles.resolve(args.object);
    if (!target) {
      return codec.encodeAccessResult({ status: NfsStatus.NFS3ERR_BADHANDLE, objectAttributes: null });
    }
    const objectAttributes = this.attributesOf(target.path, fs);
    if (!objectAttributes) {
      return codec.encodeAccessResult({ status: NfsStatus.NFS3ERR_STALE, objectAttributes: null });
    }
    const client = this.clientOf(target, context);
    let granted = fs.accessMask(target.path, this.effective(who, client));
    if (client?.readOnly || fs.isReadOnly(target.path)) {
      granted &= ~(ACCESS3_MODIFY | ACCESS3_EXTEND | ACCESS3_DELETE);
    }
    return codec.encodeAccessResult({
      status: NfsStatus.NFS3_OK, objectAttributes, access: granted & args.access,
    });
  }

  private readLink(payload: Uint8Array, fs: NfsExportedFileSystem): Uint8Array {
    const args = codec.decodeReadLinkArgs(payload);
    const target = this.handles.resolve(args.symlink);
    if (!target) {
      return codec.encodeReadLinkResult({
        status: NfsStatus.NFS3ERR_BADHANDLE, symlinkAttributes: null,
      });
    }
    const symlinkAttributes = this.attributesOf(target.path, fs);
    const data = fs.readSymlink(target.path);
    if (data === null) {
      return codec.encodeReadLinkResult({ status: NfsStatus.NFS3ERR_INVAL, symlinkAttributes });
    }
    return codec.encodeReadLinkResult({ status: NfsStatus.NFS3_OK, symlinkAttributes, data });
  }

  private read(
    payload: Uint8Array, fs: NfsExportedFileSystem,
    who: NfsCredentials, context: RpcCallContext,
  ): Uint8Array {
    const args = codec.decodeReadArgs(payload);
    const target = this.handles.resolve(args.file);
    if (!target) {
      return codec.encodeReadResult({ status: NfsStatus.NFS3ERR_BADHANDLE, fileAttributes: null });
    }
    const fileAttributes = this.attributesOf(target.path, fs);
    if (!fileAttributes) {
      return codec.encodeReadResult({ status: NfsStatus.NFS3ERR_STALE, fileAttributes: null });
    }
    if (fileAttributes.type === Ftype3.NF3DIR) {
      return codec.encodeReadResult({ status: NfsStatus.NFS3ERR_ISDIR, fileAttributes });
    }
    const client = this.clientOf(target, context);
    if ((fs.accessMask(target.path, this.effective(who, client)) & 0x0001) === 0) {
      return codec.encodeReadResult({ status: NfsStatus.NFS3ERR_ACCES, fileAttributes });
    }
    const offset = Number(args.offset);
    const wanted = Math.min(args.count, NFS3_MAXDATA);
    const data = fs.readFile(target.path, offset, wanted) ?? new Uint8Array(0);
    return codec.encodeReadResult({
      status: NfsStatus.NFS3_OK,
      fileAttributes,
      count: data.length,
      eof: BigInt(offset + data.length) >= fileAttributes.size,
      data,
    });
  }

  private write(
    payload: Uint8Array, fs: NfsExportedFileSystem,
    who: NfsCredentials, context: RpcCallContext,
  ): Uint8Array {
    const args = codec.decodeWriteArgs(payload);
    const target = this.handles.resolve(args.file);
    if (!target) {
      return codec.encodeWriteResult({
        status: NfsStatus.NFS3ERR_BADHANDLE, fileWcc: { before: null, after: null },
      });
    }
    const before = this.attributesOf(target.path, fs);
    if (!before) {
      return codec.encodeWriteResult({
        status: NfsStatus.NFS3ERR_STALE, fileWcc: { before: null, after: null },
      });
    }
    const client = this.clientOf(target, context);
    if (!client) {
      return codec.encodeWriteResult({
        status: NfsStatus.NFS3ERR_ACCES, fileWcc: this.wccOf(target.path, before, fs),
      });
    }
    if (client.readOnly || fs.isReadOnly(target.path)) {
      return codec.encodeWriteResult({
        status: NfsStatus.NFS3ERR_ROFS, fileWcc: this.wccOf(target.path, before, fs),
      });
    }
    const status = fs.writeFile(
      target.path, Number(args.offset), args.data, this.effective(who, client));
    const fileWcc = this.wccOf(target.path, before, fs);
    if (status !== NfsStatus.NFS3_OK) {
      return codec.encodeWriteResult({ status, fileWcc });
    }
    return codec.encodeWriteResult({
      status: NfsStatus.NFS3_OK,
      fileWcc,
      count: args.data.length,
      committed: client.sync ? StableHow.FILE_SYNC : args.stable,
      verifier: WRITE_VERIFIER,
    });
  }

  private create(
    payload: Uint8Array, fs: NfsExportedFileSystem,
    who: NfsCredentials, context: RpcCallContext,
  ): Uint8Array {
    const args = codec.decodeCreateArgs(payload);
    const resolved = this.resolveDir(args.where);
    if (!resolved) {
      return codec.encodeCreateResult({
        status: NfsStatus.NFS3ERR_BADHANDLE, dirWcc: { before: null, after: null },
      });
    }
    const before = this.attributesOf(resolved.target.path, fs);
    const client = this.clientOf(resolved.target, context);
    const dirWcc = () => this.wccOf(resolved.target.path, before, fs);
    if (!client) return codec.encodeCreateResult({ status: NfsStatus.NFS3ERR_ACCES, dirWcc: dirWcc() });
    if (client.readOnly || fs.isReadOnly(resolved.child)) {
      return codec.encodeCreateResult({ status: NfsStatus.NFS3ERR_ROFS, dirWcc: dirWcc() });
    }
    const existing = fs.statPath(resolved.child);
    if (existing && args.how.mode !== CreateMode3.UNCHECKED) {
      return codec.encodeCreateResult({ status: NfsStatus.NFS3ERR_EXIST, dirWcc: dirWcc() });
    }
    const mode = args.how.mode === CreateMode3.EXCLUSIVE ? 0o644 : (args.how.attributes.mode ?? 0o644);
    const status = existing
      ? NfsStatus.NFS3_OK
      : fs.createFile(resolved.child, mode, this.effective(who, client));
    if (status !== NfsStatus.NFS3_OK) {
      return codec.encodeCreateResult({ status, dirWcc: dirWcc() });
    }
    return codec.encodeCreateResult({
      status: NfsStatus.NFS3_OK,
      object: this.handles.handleFor({ exportPath: resolved.target.exportPath, path: resolved.child }),
      objectAttributes: this.attributesOf(resolved.child, fs),
      dirWcc: dirWcc(),
    });
  }

  private mkdir(
    payload: Uint8Array, fs: NfsExportedFileSystem,
    who: NfsCredentials, context: RpcCallContext,
  ): Uint8Array {
    const args = codec.decodeMkdirArgs(payload);
    const resolved = this.resolveDir(args.where);
    if (!resolved) {
      return codec.encodeCreateResult({
        status: NfsStatus.NFS3ERR_BADHANDLE, dirWcc: { before: null, after: null },
      });
    }
    const before = this.attributesOf(resolved.target.path, fs);
    const client = this.clientOf(resolved.target, context);
    const dirWcc = () => this.wccOf(resolved.target.path, before, fs);
    if (!client) return codec.encodeCreateResult({ status: NfsStatus.NFS3ERR_ACCES, dirWcc: dirWcc() });
    if (client.readOnly || fs.isReadOnly(resolved.child)) {
      return codec.encodeCreateResult({ status: NfsStatus.NFS3ERR_ROFS, dirWcc: dirWcc() });
    }
    if (fs.statPath(resolved.child)) {
      return codec.encodeCreateResult({ status: NfsStatus.NFS3ERR_EXIST, dirWcc: dirWcc() });
    }
    const status = fs.makeDirectory(
      resolved.child, args.attributes.mode ?? 0o755, this.effective(who, client));
    if (status !== NfsStatus.NFS3_OK) {
      return codec.encodeCreateResult({ status, dirWcc: dirWcc() });
    }
    return codec.encodeCreateResult({
      status: NfsStatus.NFS3_OK,
      object: this.handles.handleFor({ exportPath: resolved.target.exportPath, path: resolved.child }),
      objectAttributes: this.attributesOf(resolved.child, fs),
      dirWcc: dirWcc(),
    });
  }

  private symlink(
    payload: Uint8Array, fs: NfsExportedFileSystem,
    who: NfsCredentials, context: RpcCallContext,
  ): Uint8Array {
    const args = codec.decodeSymlinkArgs(payload);
    const resolved = this.resolveDir(args.where);
    if (!resolved) {
      return codec.encodeCreateResult({
        status: NfsStatus.NFS3ERR_BADHANDLE, dirWcc: { before: null, after: null },
      });
    }
    const before = this.attributesOf(resolved.target.path, fs);
    const client = this.clientOf(resolved.target, context);
    const dirWcc = () => this.wccOf(resolved.target.path, before, fs);
    if (!client) return codec.encodeCreateResult({ status: NfsStatus.NFS3ERR_ACCES, dirWcc: dirWcc() });
    if (client.readOnly || fs.isReadOnly(resolved.child)) {
      return codec.encodeCreateResult({ status: NfsStatus.NFS3ERR_ROFS, dirWcc: dirWcc() });
    }
    const status = fs.createSymlink(resolved.child, args.symlinkData, this.effective(who, client));
    if (status !== NfsStatus.NFS3_OK) {
      return codec.encodeCreateResult({ status, dirWcc: dirWcc() });
    }
    return codec.encodeCreateResult({
      status: NfsStatus.NFS3_OK,
      object: this.handles.handleFor({ exportPath: resolved.target.exportPath, path: resolved.child }),
      objectAttributes: this.attributesOf(resolved.child, fs),
      dirWcc: dirWcc(),
    });
  }

  private mknod(payload: Uint8Array): Uint8Array {
    codec.decodeMknodArgs(payload);
    return codec.encodeCreateResult({
      status: NfsStatus.NFS3ERR_NOTSUPP, dirWcc: { before: null, after: null },
    });
  }

  private remove(
    payload: Uint8Array, fs: NfsExportedFileSystem,
    who: NfsCredentials, context: RpcCallContext, directory: boolean,
  ): Uint8Array {
    const args = codec.decodeRemoveArgs(payload);
    const resolved = this.resolveDir(args.object);
    if (!resolved) {
      return codec.encodeRemoveResult({
        status: NfsStatus.NFS3ERR_BADHANDLE, dirWcc: { before: null, after: null },
      });
    }
    const before = this.attributesOf(resolved.target.path, fs);
    const client = this.clientOf(resolved.target, context);
    const dirWcc = () => this.wccOf(resolved.target.path, before, fs);
    if (!client) return codec.encodeRemoveResult({ status: NfsStatus.NFS3ERR_ACCES, dirWcc: dirWcc() });
    if (client.readOnly || fs.isReadOnly(resolved.child)) {
      return codec.encodeRemoveResult({ status: NfsStatus.NFS3ERR_ROFS, dirWcc: dirWcc() });
    }
    const stat = fs.statPath(resolved.child);
    if (!stat) return codec.encodeRemoveResult({ status: NfsStatus.NFS3ERR_NOENT, dirWcc: dirWcc() });
    if (directory && stat.type !== Ftype3.NF3DIR) {
      return codec.encodeRemoveResult({ status: NfsStatus.NFS3ERR_NOTDIR, dirWcc: dirWcc() });
    }
    if (!directory && stat.type === Ftype3.NF3DIR) {
      return codec.encodeRemoveResult({ status: NfsStatus.NFS3ERR_ISDIR, dirWcc: dirWcc() });
    }
    const effective = this.effective(who, client);
    const status = directory
      ? fs.removeDirectory(resolved.child, effective)
      : fs.removeFile(resolved.child, effective);
    if (status === NfsStatus.NFS3_OK) {
      this.handles.forget({ exportPath: resolved.target.exportPath, path: resolved.child });
    }
    return codec.encodeRemoveResult({ status, dirWcc: dirWcc() });
  }

  private rename(
    payload: Uint8Array, fs: NfsExportedFileSystem,
    who: NfsCredentials, context: RpcCallContext,
  ): Uint8Array {
    const args = codec.decodeRenameArgs(payload);
    const from = this.resolveDir(args.from);
    const to = this.resolveDir(args.to);
    const empty: WccData = { before: null, after: null };
    if (!from || !to) {
      return codec.encodeRenameResult({
        status: NfsStatus.NFS3ERR_BADHANDLE, fromDirWcc: empty, toDirWcc: empty,
      });
    }
    const fromBefore = this.attributesOf(from.target.path, fs);
    const toBefore = this.attributesOf(to.target.path, fs);
    const client = this.clientOf(from.target, context);
    const wccPair = () => ({
      fromDirWcc: this.wccOf(from.target.path, fromBefore, fs),
      toDirWcc: this.wccOf(to.target.path, toBefore, fs),
    });
    if (!client) return codec.encodeRenameResult({ status: NfsStatus.NFS3ERR_ACCES, ...wccPair() });
    if (client.readOnly || fs.isReadOnly(from.child)) {
      return codec.encodeRenameResult({ status: NfsStatus.NFS3ERR_ROFS, ...wccPair() });
    }
    if (from.target.exportPath !== to.target.exportPath) {
      return codec.encodeRenameResult({ status: NfsStatus.NFS3ERR_XDEV, ...wccPair() });
    }
    const status = fs.renamePath(from.child, to.child, this.effective(who, client));
    if (status === NfsStatus.NFS3_OK) {
      this.handles.forget({ exportPath: from.target.exportPath, path: from.child });
    }
    return codec.encodeRenameResult({ status, ...wccPair() });
  }

  private link(payload: Uint8Array): Uint8Array {
    codec.decodeLinkArgs(payload);
    return codec.encodeLinkResult({
      status: NfsStatus.NFS3ERR_NOTSUPP,
      fileAttributes: null,
      linkDirWcc: { before: null, after: null },
    });
  }

  private directoryEntries(
    target: NfsHandleTarget, fs: NfsExportedFileSystem, cookie: bigint,
  ): { entries: DirEntry3[]; eof: boolean } | null {
    const names = fs.listDirectory(target.path);
    if (!names) return null;
    const all = ['.', '..', ...names];
    const start = Number(cookie);
    const entries: DirEntry3[] = [];
    for (let i = start; i < all.length; i++) {
      const name = all[i];
      const path = name === '.' ? target.path
        : name === '..' ? parentOf(target.path)
          : joinPath(target.path, name);
      const stat = fs.statPath(path);
      entries.push({ fileid: BigInt(stat?.fileid ?? 0), name, cookie: BigInt(i + 1) });
    }
    return { entries, eof: true };
  }

  private readDir(payload: Uint8Array, fs: NfsExportedFileSystem): Uint8Array {
    const args = codec.decodeReadDirArgs(payload);
    const target = this.handles.resolve(args.dir);
    if (!target) {
      return codec.encodeReadDirResult({ status: NfsStatus.NFS3ERR_BADHANDLE, dirAttributes: null });
    }
    const dirAttributes = this.attributesOf(target.path, fs);
    const listing = this.directoryEntries(target, fs, args.cookie);
    if (!listing) {
      return codec.encodeReadDirResult({ status: NfsStatus.NFS3ERR_NOTDIR, dirAttributes });
    }
    return codec.encodeReadDirResult({
      status: NfsStatus.NFS3_OK,
      dirAttributes,
      cookieVerifier: args.cookieVerifier,
      entries: listing.entries,
      eof: listing.eof,
    });
  }

  private readDirPlus(payload: Uint8Array, fs: NfsExportedFileSystem): Uint8Array {
    const args = codec.decodeReadDirPlusArgs(payload);
    const target = this.handles.resolve(args.dir);
    if (!target) {
      return codec.encodeReadDirPlusResult({
        status: NfsStatus.NFS3ERR_BADHANDLE, dirAttributes: null,
      });
    }
    const dirAttributes = this.attributesOf(target.path, fs);
    const listing = this.directoryEntries(target, fs, args.cookie);
    if (!listing) {
      return codec.encodeReadDirPlusResult({ status: NfsStatus.NFS3ERR_NOTDIR, dirAttributes });
    }
    const entries: DirEntryPlus3[] = listing.entries.map((entry) => {
      const path = entry.name === '.' ? target.path
        : entry.name === '..' ? parentOf(target.path)
          : joinPath(target.path, entry.name);
      return {
        ...entry,
        nameAttributes: this.attributesOf(path, fs),
        nameHandle: this.handles.handleFor({ exportPath: target.exportPath, path }),
      };
    });
    return codec.encodeReadDirPlusResult({
      status: NfsStatus.NFS3_OK,
      dirAttributes,
      cookieVerifier: args.cookieVerifier,
      entries,
      eof: listing.eof,
    });
  }

  private fsStat(payload: Uint8Array, fs: NfsExportedFileSystem): Uint8Array {
    const args = codec.decodeFsStatArgs(payload);
    const target = this.handles.resolve(args.fsroot);
    if (!target) {
      return codec.encodeFsStatResult({ status: NfsStatus.NFS3ERR_BADHANDLE, objectAttributes: null });
    }
    const totals = fs.spaceTotals();
    return codec.encodeFsStatResult({
      status: NfsStatus.NFS3_OK,
      objectAttributes: this.attributesOf(target.path, fs),
      totalBytes: BigInt(totals.totalBytes),
      freeBytes: BigInt(totals.freeBytes),
      availableBytes: BigInt(totals.freeBytes),
      totalFiles: BigInt(totals.totalFiles),
      freeFiles: BigInt(totals.freeFiles),
      availableFiles: BigInt(totals.freeFiles),
      invarSeconds: 0,
    });
  }

  private fsInfo(payload: Uint8Array, fs: NfsExportedFileSystem): Uint8Array {
    const args = codec.decodeFsInfoArgs(payload);
    const target = this.handles.resolve(args.fsroot);
    if (!target) {
      return codec.encodeFsInfoResult({ status: NfsStatus.NFS3ERR_BADHANDLE, objectAttributes: null });
    }
    return codec.encodeFsInfoResult({
      status: NfsStatus.NFS3_OK,
      objectAttributes: this.attributesOf(target.path, fs),
      readMax: NFS3_MAXDATA,
      readPreferred: NFS3_MAXDATA,
      readMultiple: 4096,
      writeMax: NFS3_MAXDATA,
      writePreferred: NFS3_MAXDATA,
      writeMultiple: 4096,
      readDirPreferred: 4096,
      maxFileSize: 0xffffffffffffn,
      timeDelta: { seconds: 0, nseconds: 1000 },
      properties: FSF3_LINK | FSF3_SYMLINK | FSF3_HOMOGENEOUS | FSF3_CANSETTIME,
    });
  }

  private pathConf(payload: Uint8Array, fs: NfsExportedFileSystem): Uint8Array {
    const args = codec.decodePathConfArgs(payload);
    const target = this.handles.resolve(args.object);
    if (!target) {
      return codec.encodePathConfResult({
        status: NfsStatus.NFS3ERR_BADHANDLE, objectAttributes: null,
      });
    }
    return codec.encodePathConfResult({
      status: NfsStatus.NFS3_OK,
      objectAttributes: this.attributesOf(target.path, fs),
      linkMax: 32000,
      nameMax: NFS3_MAXNAMLEN,
      noTrunc: true,
      chownRestricted: true,
      caseInsensitive: false,
      casePreserving: true,
    });
  }

  private commit(payload: Uint8Array, fs: NfsExportedFileSystem): Uint8Array {
    const args = codec.decodeCommitArgs(payload);
    const target = this.handles.resolve(args.file);
    if (!target) {
      return codec.encodeCommitResult({
        status: NfsStatus.NFS3ERR_BADHANDLE, fileWcc: { before: null, after: null },
      });
    }
    const after = this.attributesOf(target.path, fs);
    if (!after) {
      return codec.encodeCommitResult({
        status: NfsStatus.NFS3ERR_STALE, fileWcc: { before: null, after: null },
      });
    }
    return codec.encodeCommitResult({
      status: NfsStatus.NFS3_OK,
      fileWcc: { before: null, after },
      verifier: WRITE_VERIFIER,
    });
  }
}

function sattrToChanges(attr: Sattr3): {
  mode?: number; uid?: number; gid?: number; atime?: Date; mtime?: Date;
} {
  const changes: { mode?: number; uid?: number; gid?: number; atime?: Date; mtime?: Date } = {};
  if (attr.mode !== undefined) changes.mode = attr.mode;
  if (attr.uid !== undefined) changes.uid = attr.uid;
  if (attr.gid !== undefined) changes.gid = attr.gid;
  if (attr.atime?.how === TimeHow.SET_TO_CLIENT_TIME && attr.atime.time) {
    changes.atime = new Date(attr.atime.time.seconds * 1000 + attr.atime.time.nseconds / 1e6);
  }
  if (attr.atime?.how === TimeHow.SET_TO_SERVER_TIME) changes.atime = new Date();
  if (attr.mtime?.how === TimeHow.SET_TO_CLIENT_TIME && attr.mtime.time) {
    changes.mtime = new Date(attr.mtime.time.seconds * 1000 + attr.mtime.time.nseconds / 1e6);
  }
  if (attr.mtime?.how === TimeHow.SET_TO_SERVER_TIME) changes.mtime = new Date();
  return changes;
}
