import { XdrReader, XdrWriter } from './Xdr';
import {
  CreateMode3, Ftype3, MountStatus, NfsStatus, StableHow, TimeHow,
  NFS3_FHSIZE, NFS3_MAXNAMLEN, NFS3_MAXPATHLEN, NFS3_COOKIEVERFSIZE,
  NFS3_CREATEVERFSIZE, NFS3_WRITEVERFSIZE, MNTPATHLEN, FHSIZE3,
} from './NfsConstants';
import type {
  AccessArgs, AccessResult, CommitArgs, CommitResult, CreateArgs, CreateHow3, CreateResult,
  DirEntry3, DirEntryPlus3, DirOpArgs3, ExportNode, Fattr3, FsInfoArgs, FsInfoResult,
  FsStatArgs, FsStatResult, GetAttrArgs, GetAttrResult, LinkArgs, LinkResult, LookupArgs,
  LookupResult, MkdirArgs, MknodArgs, MknodData3, MountEntryRecord, MountResult, NfsFileHandle,
  NfsTime3, PathConfArgs, PathConfResult, ReadArgs, ReadDirArgs, ReadDirPlusArgs,
  ReadDirPlusResult, ReadDirResult, ReadLinkArgs, ReadLinkResult, ReadResult, RemoveArgs,
  RemoveResult, RenameArgs, RenameResult, Sattr3, SetAttrArgs, SetAttrResult, SpecData3,
  SymlinkArgs, WccAttr, WccData, WriteArgs, WriteResult,
} from './NfsTypes';

function writeFileHandle(w: XdrWriter, handle: NfsFileHandle): void {
  w.variableOpaque(handle);
}

function readFileHandle(r: XdrReader): NfsFileHandle {
  return r.variableOpaque(NFS3_FHSIZE);
}

function writeTime(w: XdrWriter, time: NfsTime3): void {
  w.uint32(time.seconds);
  w.uint32(time.nseconds);
}

function readTime(r: XdrReader): NfsTime3 {
  return { seconds: r.uint32(), nseconds: r.uint32() };
}

function writeSpecData(w: XdrWriter, spec: SpecData3): void {
  w.uint32(spec.specdata1);
  w.uint32(spec.specdata2);
}

function readSpecData(r: XdrReader): SpecData3 {
  return { specdata1: r.uint32(), specdata2: r.uint32() };
}

export function writeFattr3(w: XdrWriter, attr: Fattr3): void {
  w.enumeration(attr.type);
  w.uint32(attr.mode);
  w.uint32(attr.nlink);
  w.uint32(attr.uid);
  w.uint32(attr.gid);
  w.uint64(attr.size);
  w.uint64(attr.used);
  writeSpecData(w, attr.rdev);
  w.uint64(attr.fsid);
  w.uint64(attr.fileid);
  writeTime(w, attr.atime);
  writeTime(w, attr.mtime);
  writeTime(w, attr.ctime);
}

export function readFattr3(r: XdrReader): Fattr3 {
  return {
    type: r.enumeration() as Ftype3,
    mode: r.uint32(),
    nlink: r.uint32(),
    uid: r.uint32(),
    gid: r.uint32(),
    size: r.uint64(),
    used: r.uint64(),
    rdev: readSpecData(r),
    fsid: r.uint64(),
    fileid: r.uint64(),
    atime: readTime(r),
    mtime: readTime(r),
    ctime: readTime(r),
  };
}

function writePostOpAttr(w: XdrWriter, attr: Fattr3 | null): void {
  w.optional(attr, (writer, present) => writeFattr3(writer, present));
}

function readPostOpAttr(r: XdrReader): Fattr3 | null {
  return r.optional(readFattr3);
}

function writeWccAttr(w: XdrWriter, attr: WccAttr): void {
  w.uint64(attr.size);
  writeTime(w, attr.mtime);
  writeTime(w, attr.ctime);
}

function readWccAttr(r: XdrReader): WccAttr {
  return { size: r.uint64(), mtime: readTime(r), ctime: readTime(r) };
}

export function writeWccData(w: XdrWriter, wcc: WccData): void {
  w.optional(wcc.before, (writer, present) => writeWccAttr(writer, present));
  writePostOpAttr(w, wcc.after);
}

export function readWccData(r: XdrReader): WccData {
  return { before: r.optional(readWccAttr), after: readPostOpAttr(r) };
}

function writePostOpFh(w: XdrWriter, handle: NfsFileHandle | null): void {
  w.optional(handle, (writer, present) => writeFileHandle(writer, present));
}

function readPostOpFh(r: XdrReader): NfsFileHandle | null {
  return r.optional(readFileHandle);
}

export function writeSattr3(w: XdrWriter, attr: Sattr3): void {
  w.optional(attr.mode, (writer, mode) => writer.uint32(mode));
  w.optional(attr.uid, (writer, uid) => writer.uint32(uid));
  w.optional(attr.gid, (writer, gid) => writer.uint32(gid));
  w.optional(attr.size, (writer, size) => writer.uint64(size));
  for (const set of [attr.atime, attr.mtime]) {
    const how = set?.how ?? TimeHow.DONT_CHANGE;
    w.enumeration(how);
    if (how === TimeHow.SET_TO_CLIENT_TIME && set?.time) writeTime(w, set.time);
  }
}

export function readSattr3(r: XdrReader): Sattr3 {
  const mode = r.optional((reader) => reader.uint32()) ?? undefined;
  const uid = r.optional((reader) => reader.uint32()) ?? undefined;
  const gid = r.optional((reader) => reader.uint32()) ?? undefined;
  const size = r.optional((reader) => reader.uint64()) ?? undefined;
  const readSet = (): Sattr3['atime'] => {
    const how = r.enumeration() as TimeHow;
    return how === TimeHow.SET_TO_CLIENT_TIME ? { how, time: readTime(r) } : { how };
  };
  const atime = readSet();
  const mtime = readSet();
  return { mode, uid, gid, size, atime, mtime };
}

function writeDirOpArgs(w: XdrWriter, args: DirOpArgs3): void {
  writeFileHandle(w, args.dir);
  w.string(args.name);
}

function readDirOpArgs(r: XdrReader): DirOpArgs3 {
  return { dir: readFileHandle(r), name: r.string(NFS3_MAXNAMLEN) };
}

export const encodeGetAttrArgs = (args: GetAttrArgs): Uint8Array => {
  const w = new XdrWriter();
  writeFileHandle(w, args.object);
  return w.toBytes();
};

export const decodeGetAttrArgs = (bytes: Uint8Array): GetAttrArgs =>
  ({ object: readFileHandle(new XdrReader(bytes)) });

export const encodeGetAttrResult = (res: GetAttrResult): Uint8Array => {
  const w = new XdrWriter();
  w.enumeration(res.status);
  if (res.status === NfsStatus.NFS3_OK) writeFattr3(w, res.attributes);
  return w.toBytes();
};

export const decodeGetAttrResult = (bytes: Uint8Array): GetAttrResult => {
  const r = new XdrReader(bytes);
  const status = r.enumeration() as NfsStatus;
  return status === NfsStatus.NFS3_OK
    ? { status, attributes: readFattr3(r) }
    : { status: status as Exclude<NfsStatus, NfsStatus.NFS3_OK> };
};

export const encodeSetAttrArgs = (args: SetAttrArgs): Uint8Array => {
  const w = new XdrWriter();
  writeFileHandle(w, args.object);
  writeSattr3(w, args.newAttributes);
  w.optional(args.guardCtime, (writer, time) => writeTime(writer, time));
  return w.toBytes();
};

export const decodeSetAttrArgs = (bytes: Uint8Array): SetAttrArgs => {
  const r = new XdrReader(bytes);
  return {
    object: readFileHandle(r),
    newAttributes: readSattr3(r),
    guardCtime: r.optional(readTime),
  };
};

export const encodeSetAttrResult = (res: SetAttrResult): Uint8Array => {
  const w = new XdrWriter();
  w.enumeration(res.status);
  writeWccData(w, res.objectWcc);
  return w.toBytes();
};

export const decodeSetAttrResult = (bytes: Uint8Array): SetAttrResult => {
  const r = new XdrReader(bytes);
  return { status: r.enumeration() as NfsStatus, objectWcc: readWccData(r) };
};

export const encodeLookupArgs = (args: LookupArgs): Uint8Array => {
  const w = new XdrWriter();
  writeDirOpArgs(w, args.what);
  return w.toBytes();
};

export const decodeLookupArgs = (bytes: Uint8Array): LookupArgs =>
  ({ what: readDirOpArgs(new XdrReader(bytes)) });

export const encodeLookupResult = (res: LookupResult): Uint8Array => {
  const w = new XdrWriter();
  w.enumeration(res.status);
  if (res.status === NfsStatus.NFS3_OK) {
    writeFileHandle(w, res.object);
    writePostOpAttr(w, res.objectAttributes);
  }
  writePostOpAttr(w, res.dirAttributes);
  return w.toBytes();
};

export const decodeLookupResult = (bytes: Uint8Array): LookupResult => {
  const r = new XdrReader(bytes);
  const status = r.enumeration() as NfsStatus;
  if (status === NfsStatus.NFS3_OK) {
    const object = readFileHandle(r);
    const objectAttributes = readPostOpAttr(r);
    return { status, object, objectAttributes, dirAttributes: readPostOpAttr(r) };
  }
  return {
    status: status as Exclude<NfsStatus, NfsStatus.NFS3_OK>,
    dirAttributes: readPostOpAttr(r),
  };
};

export const encodeAccessArgs = (args: AccessArgs): Uint8Array => {
  const w = new XdrWriter();
  writeFileHandle(w, args.object);
  w.uint32(args.access);
  return w.toBytes();
};

export const decodeAccessArgs = (bytes: Uint8Array): AccessArgs => {
  const r = new XdrReader(bytes);
  return { object: readFileHandle(r), access: r.uint32() };
};

export const encodeAccessResult = (res: AccessResult): Uint8Array => {
  const w = new XdrWriter();
  w.enumeration(res.status);
  writePostOpAttr(w, res.objectAttributes);
  if (res.status === NfsStatus.NFS3_OK) w.uint32(res.access);
  return w.toBytes();
};

export const decodeAccessResult = (bytes: Uint8Array): AccessResult => {
  const r = new XdrReader(bytes);
  const status = r.enumeration() as NfsStatus;
  const objectAttributes = readPostOpAttr(r);
  return status === NfsStatus.NFS3_OK
    ? { status, objectAttributes, access: r.uint32() }
    : { status: status as Exclude<NfsStatus, NfsStatus.NFS3_OK>, objectAttributes };
};

export const encodeReadLinkArgs = (args: ReadLinkArgs): Uint8Array => {
  const w = new XdrWriter();
  writeFileHandle(w, args.symlink);
  return w.toBytes();
};

export const decodeReadLinkArgs = (bytes: Uint8Array): ReadLinkArgs =>
  ({ symlink: readFileHandle(new XdrReader(bytes)) });

export const encodeReadLinkResult = (res: ReadLinkResult): Uint8Array => {
  const w = new XdrWriter();
  w.enumeration(res.status);
  writePostOpAttr(w, res.symlinkAttributes);
  if (res.status === NfsStatus.NFS3_OK) w.string(res.data);
  return w.toBytes();
};

export const decodeReadLinkResult = (bytes: Uint8Array): ReadLinkResult => {
  const r = new XdrReader(bytes);
  const status = r.enumeration() as NfsStatus;
  const symlinkAttributes = readPostOpAttr(r);
  return status === NfsStatus.NFS3_OK
    ? { status, symlinkAttributes, data: r.string(NFS3_MAXPATHLEN) }
    : { status: status as Exclude<NfsStatus, NfsStatus.NFS3_OK>, symlinkAttributes };
};

export const encodeReadArgs = (args: ReadArgs): Uint8Array => {
  const w = new XdrWriter();
  writeFileHandle(w, args.file);
  w.uint64(args.offset);
  w.uint32(args.count);
  return w.toBytes();
};

export const decodeReadArgs = (bytes: Uint8Array): ReadArgs => {
  const r = new XdrReader(bytes);
  return { file: readFileHandle(r), offset: r.uint64(), count: r.uint32() };
};

export const encodeReadResult = (res: ReadResult): Uint8Array => {
  const w = new XdrWriter();
  w.enumeration(res.status);
  writePostOpAttr(w, res.fileAttributes);
  if (res.status === NfsStatus.NFS3_OK) {
    w.uint32(res.count);
    w.boolean(res.eof);
    w.variableOpaque(res.data);
  }
  return w.toBytes();
};

export const decodeReadResult = (bytes: Uint8Array): ReadResult => {
  const r = new XdrReader(bytes);
  const status = r.enumeration() as NfsStatus;
  const fileAttributes = readPostOpAttr(r);
  if (status !== NfsStatus.NFS3_OK) {
    return { status: status as Exclude<NfsStatus, NfsStatus.NFS3_OK>, fileAttributes };
  }
  const count = r.uint32();
  const eof = r.boolean();
  return { status, fileAttributes, count, eof, data: r.variableOpaque() };
};

export const encodeWriteArgs = (args: WriteArgs): Uint8Array => {
  const w = new XdrWriter();
  writeFileHandle(w, args.file);
  w.uint64(args.offset);
  w.uint32(args.count);
  w.enumeration(args.stable);
  w.variableOpaque(args.data);
  return w.toBytes();
};

export const decodeWriteArgs = (bytes: Uint8Array): WriteArgs => {
  const r = new XdrReader(bytes);
  return {
    file: readFileHandle(r),
    offset: r.uint64(),
    count: r.uint32(),
    stable: r.enumeration() as StableHow,
    data: r.variableOpaque(),
  };
};

export const encodeWriteResult = (res: WriteResult): Uint8Array => {
  const w = new XdrWriter();
  w.enumeration(res.status);
  writeWccData(w, res.fileWcc);
  if (res.status === NfsStatus.NFS3_OK) {
    w.uint32(res.count);
    w.enumeration(res.committed);
    w.fixedOpaque(res.verifier, NFS3_WRITEVERFSIZE);
  }
  return w.toBytes();
};

export const decodeWriteResult = (bytes: Uint8Array): WriteResult => {
  const r = new XdrReader(bytes);
  const status = r.enumeration() as NfsStatus;
  const fileWcc = readWccData(r);
  if (status !== NfsStatus.NFS3_OK) {
    return { status: status as Exclude<NfsStatus, NfsStatus.NFS3_OK>, fileWcc };
  }
  return {
    status, fileWcc,
    count: r.uint32(),
    committed: r.enumeration() as StableHow,
    verifier: r.fixedOpaque(NFS3_WRITEVERFSIZE),
  };
};

function writeCreateHow(w: XdrWriter, how: CreateHow3): void {
  w.enumeration(how.mode);
  if (how.mode === CreateMode3.EXCLUSIVE) {
    w.fixedOpaque(how.verifier, NFS3_CREATEVERFSIZE);
  } else {
    writeSattr3(w, how.attributes);
  }
}

function readCreateHow(r: XdrReader): CreateHow3 {
  const mode = r.enumeration() as CreateMode3;
  return mode === CreateMode3.EXCLUSIVE
    ? { mode, verifier: r.fixedOpaque(NFS3_CREATEVERFSIZE) }
    : { mode, attributes: readSattr3(r) };
}

export const encodeCreateArgs = (args: CreateArgs): Uint8Array => {
  const w = new XdrWriter();
  writeDirOpArgs(w, args.where);
  writeCreateHow(w, args.how);
  return w.toBytes();
};

export const decodeCreateArgs = (bytes: Uint8Array): CreateArgs => {
  const r = new XdrReader(bytes);
  return { where: readDirOpArgs(r), how: readCreateHow(r) };
};

export const encodeCreateResult = (res: CreateResult): Uint8Array => {
  const w = new XdrWriter();
  w.enumeration(res.status);
  if (res.status === NfsStatus.NFS3_OK) {
    writePostOpFh(w, res.object);
    writePostOpAttr(w, res.objectAttributes);
  }
  writeWccData(w, res.dirWcc);
  return w.toBytes();
};

export const decodeCreateResult = (bytes: Uint8Array): CreateResult => {
  const r = new XdrReader(bytes);
  const status = r.enumeration() as NfsStatus;
  if (status === NfsStatus.NFS3_OK) {
    const object = readPostOpFh(r);
    const objectAttributes = readPostOpAttr(r);
    return { status, object, objectAttributes, dirWcc: readWccData(r) };
  }
  return { status: status as Exclude<NfsStatus, NfsStatus.NFS3_OK>, dirWcc: readWccData(r) };
};

export const encodeMkdirArgs = (args: MkdirArgs): Uint8Array => {
  const w = new XdrWriter();
  writeDirOpArgs(w, args.where);
  writeSattr3(w, args.attributes);
  return w.toBytes();
};

export const decodeMkdirArgs = (bytes: Uint8Array): MkdirArgs => {
  const r = new XdrReader(bytes);
  return { where: readDirOpArgs(r), attributes: readSattr3(r) };
};

export const encodeSymlinkArgs = (args: SymlinkArgs): Uint8Array => {
  const w = new XdrWriter();
  writeDirOpArgs(w, args.where);
  writeSattr3(w, args.symlinkAttributes);
  w.string(args.symlinkData);
  return w.toBytes();
};

export const decodeSymlinkArgs = (bytes: Uint8Array): SymlinkArgs => {
  const r = new XdrReader(bytes);
  return {
    where: readDirOpArgs(r),
    symlinkAttributes: readSattr3(r),
    symlinkData: r.string(NFS3_MAXPATHLEN),
  };
};

function writeMknodData(w: XdrWriter, what: MknodData3): void {
  w.enumeration(what.type);
  if (what.type === Ftype3.NF3CHR || what.type === Ftype3.NF3BLK) {
    writeSattr3(w, what.attributes);
    writeSpecData(w, what.spec);
  } else if (what.type === Ftype3.NF3SOCK || what.type === Ftype3.NF3FIFO) {
    writeSattr3(w, what.attributes);
  }
}

function readMknodData(r: XdrReader): MknodData3 {
  const type = r.enumeration() as Ftype3;
  if (type === Ftype3.NF3CHR || type === Ftype3.NF3BLK) {
    return { type, attributes: readSattr3(r), spec: readSpecData(r) };
  }
  if (type === Ftype3.NF3SOCK || type === Ftype3.NF3FIFO) {
    return { type, attributes: readSattr3(r) };
  }
  return { type: type as Ftype3.NF3REG | Ftype3.NF3DIR | Ftype3.NF3LNK };
}

export const encodeMknodArgs = (args: MknodArgs): Uint8Array => {
  const w = new XdrWriter();
  writeDirOpArgs(w, args.where);
  writeMknodData(w, args.what);
  return w.toBytes();
};

export const decodeMknodArgs = (bytes: Uint8Array): MknodArgs => {
  const r = new XdrReader(bytes);
  return { where: readDirOpArgs(r), what: readMknodData(r) };
};

export const encodeRemoveArgs = (args: RemoveArgs): Uint8Array => {
  const w = new XdrWriter();
  writeDirOpArgs(w, args.object);
  return w.toBytes();
};

export const decodeRemoveArgs = (bytes: Uint8Array): RemoveArgs =>
  ({ object: readDirOpArgs(new XdrReader(bytes)) });

export const encodeRemoveResult = (res: RemoveResult): Uint8Array => {
  const w = new XdrWriter();
  w.enumeration(res.status);
  writeWccData(w, res.dirWcc);
  return w.toBytes();
};

export const decodeRemoveResult = (bytes: Uint8Array): RemoveResult => {
  const r = new XdrReader(bytes);
  return { status: r.enumeration() as NfsStatus, dirWcc: readWccData(r) };
};

export const encodeRenameArgs = (args: RenameArgs): Uint8Array => {
  const w = new XdrWriter();
  writeDirOpArgs(w, args.from);
  writeDirOpArgs(w, args.to);
  return w.toBytes();
};

export const decodeRenameArgs = (bytes: Uint8Array): RenameArgs => {
  const r = new XdrReader(bytes);
  return { from: readDirOpArgs(r), to: readDirOpArgs(r) };
};

export const encodeRenameResult = (res: RenameResult): Uint8Array => {
  const w = new XdrWriter();
  w.enumeration(res.status);
  writeWccData(w, res.fromDirWcc);
  writeWccData(w, res.toDirWcc);
  return w.toBytes();
};

export const decodeRenameResult = (bytes: Uint8Array): RenameResult => {
  const r = new XdrReader(bytes);
  return {
    status: r.enumeration() as NfsStatus,
    fromDirWcc: readWccData(r),
    toDirWcc: readWccData(r),
  };
};

export const encodeLinkArgs = (args: LinkArgs): Uint8Array => {
  const w = new XdrWriter();
  writeFileHandle(w, args.file);
  writeDirOpArgs(w, args.link);
  return w.toBytes();
};

export const decodeLinkArgs = (bytes: Uint8Array): LinkArgs => {
  const r = new XdrReader(bytes);
  return { file: readFileHandle(r), link: readDirOpArgs(r) };
};

export const encodeLinkResult = (res: LinkResult): Uint8Array => {
  const w = new XdrWriter();
  w.enumeration(res.status);
  writePostOpAttr(w, res.fileAttributes);
  writeWccData(w, res.linkDirWcc);
  return w.toBytes();
};

export const decodeLinkResult = (bytes: Uint8Array): LinkResult => {
  const r = new XdrReader(bytes);
  return {
    status: r.enumeration() as NfsStatus,
    fileAttributes: readPostOpAttr(r),
    linkDirWcc: readWccData(r),
  };
};

export const encodeReadDirArgs = (args: ReadDirArgs): Uint8Array => {
  const w = new XdrWriter();
  writeFileHandle(w, args.dir);
  w.uint64(args.cookie);
  w.fixedOpaque(args.cookieVerifier, NFS3_COOKIEVERFSIZE);
  w.uint32(args.count);
  return w.toBytes();
};

export const decodeReadDirArgs = (bytes: Uint8Array): ReadDirArgs => {
  const r = new XdrReader(bytes);
  return {
    dir: readFileHandle(r),
    cookie: r.uint64(),
    cookieVerifier: r.fixedOpaque(NFS3_COOKIEVERFSIZE),
    count: r.uint32(),
  };
};

export const encodeReadDirResult = (res: ReadDirResult): Uint8Array => {
  const w = new XdrWriter();
  w.enumeration(res.status);
  writePostOpAttr(w, res.dirAttributes);
  if (res.status !== NfsStatus.NFS3_OK) return w.toBytes();
  w.fixedOpaque(res.cookieVerifier, NFS3_COOKIEVERFSIZE);
  for (const entry of res.entries) {
    w.boolean(true);
    w.uint64(entry.fileid);
    w.string(entry.name);
    w.uint64(entry.cookie);
  }
  w.boolean(false);
  w.boolean(res.eof);
  return w.toBytes();
};

export const decodeReadDirResult = (bytes: Uint8Array): ReadDirResult => {
  const r = new XdrReader(bytes);
  const status = r.enumeration() as NfsStatus;
  const dirAttributes = readPostOpAttr(r);
  if (status !== NfsStatus.NFS3_OK) {
    return { status: status as Exclude<NfsStatus, NfsStatus.NFS3_OK>, dirAttributes };
  }
  const cookieVerifier = r.fixedOpaque(NFS3_COOKIEVERFSIZE);
  const entries: DirEntry3[] = [];
  while (r.boolean()) {
    entries.push({ fileid: r.uint64(), name: r.string(NFS3_MAXNAMLEN), cookie: r.uint64() });
  }
  return { status, dirAttributes, cookieVerifier, entries, eof: r.boolean() };
};

export const encodeReadDirPlusArgs = (args: ReadDirPlusArgs): Uint8Array => {
  const w = new XdrWriter();
  writeFileHandle(w, args.dir);
  w.uint64(args.cookie);
  w.fixedOpaque(args.cookieVerifier, NFS3_COOKIEVERFSIZE);
  w.uint32(args.dirCount);
  w.uint32(args.maxCount);
  return w.toBytes();
};

export const decodeReadDirPlusArgs = (bytes: Uint8Array): ReadDirPlusArgs => {
  const r = new XdrReader(bytes);
  return {
    dir: readFileHandle(r),
    cookie: r.uint64(),
    cookieVerifier: r.fixedOpaque(NFS3_COOKIEVERFSIZE),
    dirCount: r.uint32(),
    maxCount: r.uint32(),
  };
};

export const encodeReadDirPlusResult = (res: ReadDirPlusResult): Uint8Array => {
  const w = new XdrWriter();
  w.enumeration(res.status);
  writePostOpAttr(w, res.dirAttributes);
  if (res.status !== NfsStatus.NFS3_OK) return w.toBytes();
  w.fixedOpaque(res.cookieVerifier, NFS3_COOKIEVERFSIZE);
  for (const entry of res.entries) {
    w.boolean(true);
    w.uint64(entry.fileid);
    w.string(entry.name);
    w.uint64(entry.cookie);
    writePostOpAttr(w, entry.nameAttributes);
    writePostOpFh(w, entry.nameHandle);
  }
  w.boolean(false);
  w.boolean(res.eof);
  return w.toBytes();
};

export const decodeReadDirPlusResult = (bytes: Uint8Array): ReadDirPlusResult => {
  const r = new XdrReader(bytes);
  const status = r.enumeration() as NfsStatus;
  const dirAttributes = readPostOpAttr(r);
  if (status !== NfsStatus.NFS3_OK) {
    return { status: status as Exclude<NfsStatus, NfsStatus.NFS3_OK>, dirAttributes };
  }
  const cookieVerifier = r.fixedOpaque(NFS3_COOKIEVERFSIZE);
  const entries: DirEntryPlus3[] = [];
  while (r.boolean()) {
    entries.push({
      fileid: r.uint64(),
      name: r.string(NFS3_MAXNAMLEN),
      cookie: r.uint64(),
      nameAttributes: readPostOpAttr(r),
      nameHandle: readPostOpFh(r),
    });
  }
  return { status, dirAttributes, cookieVerifier, entries, eof: r.boolean() };
};

export const encodeFsStatArgs = (args: FsStatArgs): Uint8Array => {
  const w = new XdrWriter();
  writeFileHandle(w, args.fsroot);
  return w.toBytes();
};

export const decodeFsStatArgs = (bytes: Uint8Array): FsStatArgs =>
  ({ fsroot: readFileHandle(new XdrReader(bytes)) });

export const encodeFsStatResult = (res: FsStatResult): Uint8Array => {
  const w = new XdrWriter();
  w.enumeration(res.status);
  writePostOpAttr(w, res.objectAttributes);
  if (res.status !== NfsStatus.NFS3_OK) return w.toBytes();
  w.uint64(res.totalBytes);
  w.uint64(res.freeBytes);
  w.uint64(res.availableBytes);
  w.uint64(res.totalFiles);
  w.uint64(res.freeFiles);
  w.uint64(res.availableFiles);
  w.uint32(res.invarSeconds);
  return w.toBytes();
};

export const decodeFsStatResult = (bytes: Uint8Array): FsStatResult => {
  const r = new XdrReader(bytes);
  const status = r.enumeration() as NfsStatus;
  const objectAttributes = readPostOpAttr(r);
  if (status !== NfsStatus.NFS3_OK) {
    return { status: status as Exclude<NfsStatus, NfsStatus.NFS3_OK>, objectAttributes };
  }
  return {
    status, objectAttributes,
    totalBytes: r.uint64(),
    freeBytes: r.uint64(),
    availableBytes: r.uint64(),
    totalFiles: r.uint64(),
    freeFiles: r.uint64(),
    availableFiles: r.uint64(),
    invarSeconds: r.uint32(),
  };
};

export const encodeFsInfoArgs = (args: FsInfoArgs): Uint8Array => {
  const w = new XdrWriter();
  writeFileHandle(w, args.fsroot);
  return w.toBytes();
};

export const decodeFsInfoArgs = (bytes: Uint8Array): FsInfoArgs =>
  ({ fsroot: readFileHandle(new XdrReader(bytes)) });

export const encodeFsInfoResult = (res: FsInfoResult): Uint8Array => {
  const w = new XdrWriter();
  w.enumeration(res.status);
  writePostOpAttr(w, res.objectAttributes);
  if (res.status !== NfsStatus.NFS3_OK) return w.toBytes();
  w.uint32(res.readMax);
  w.uint32(res.readPreferred);
  w.uint32(res.readMultiple);
  w.uint32(res.writeMax);
  w.uint32(res.writePreferred);
  w.uint32(res.writeMultiple);
  w.uint32(res.readDirPreferred);
  w.uint64(res.maxFileSize);
  writeTime(w, res.timeDelta);
  w.uint32(res.properties);
  return w.toBytes();
};

export const decodeFsInfoResult = (bytes: Uint8Array): FsInfoResult => {
  const r = new XdrReader(bytes);
  const status = r.enumeration() as NfsStatus;
  const objectAttributes = readPostOpAttr(r);
  if (status !== NfsStatus.NFS3_OK) {
    return { status: status as Exclude<NfsStatus, NfsStatus.NFS3_OK>, objectAttributes };
  }
  return {
    status, objectAttributes,
    readMax: r.uint32(),
    readPreferred: r.uint32(),
    readMultiple: r.uint32(),
    writeMax: r.uint32(),
    writePreferred: r.uint32(),
    writeMultiple: r.uint32(),
    readDirPreferred: r.uint32(),
    maxFileSize: r.uint64(),
    timeDelta: readTime(r),
    properties: r.uint32(),
  };
};

export const encodePathConfArgs = (args: PathConfArgs): Uint8Array => {
  const w = new XdrWriter();
  writeFileHandle(w, args.object);
  return w.toBytes();
};

export const decodePathConfArgs = (bytes: Uint8Array): PathConfArgs =>
  ({ object: readFileHandle(new XdrReader(bytes)) });

export const encodePathConfResult = (res: PathConfResult): Uint8Array => {
  const w = new XdrWriter();
  w.enumeration(res.status);
  writePostOpAttr(w, res.objectAttributes);
  if (res.status !== NfsStatus.NFS3_OK) return w.toBytes();
  w.uint32(res.linkMax);
  w.uint32(res.nameMax);
  w.boolean(res.noTrunc);
  w.boolean(res.chownRestricted);
  w.boolean(res.caseInsensitive);
  w.boolean(res.casePreserving);
  return w.toBytes();
};

export const decodePathConfResult = (bytes: Uint8Array): PathConfResult => {
  const r = new XdrReader(bytes);
  const status = r.enumeration() as NfsStatus;
  const objectAttributes = readPostOpAttr(r);
  if (status !== NfsStatus.NFS3_OK) {
    return { status: status as Exclude<NfsStatus, NfsStatus.NFS3_OK>, objectAttributes };
  }
  return {
    status, objectAttributes,
    linkMax: r.uint32(),
    nameMax: r.uint32(),
    noTrunc: r.boolean(),
    chownRestricted: r.boolean(),
    caseInsensitive: r.boolean(),
    casePreserving: r.boolean(),
  };
};

export const encodeCommitArgs = (args: CommitArgs): Uint8Array => {
  const w = new XdrWriter();
  writeFileHandle(w, args.file);
  w.uint64(args.offset);
  w.uint32(args.count);
  return w.toBytes();
};

export const decodeCommitArgs = (bytes: Uint8Array): CommitArgs => {
  const r = new XdrReader(bytes);
  return { file: readFileHandle(r), offset: r.uint64(), count: r.uint32() };
};

export const encodeCommitResult = (res: CommitResult): Uint8Array => {
  const w = new XdrWriter();
  w.enumeration(res.status);
  writeWccData(w, res.fileWcc);
  if (res.status === NfsStatus.NFS3_OK) w.fixedOpaque(res.verifier, NFS3_WRITEVERFSIZE);
  return w.toBytes();
};

export const decodeCommitResult = (bytes: Uint8Array): CommitResult => {
  const r = new XdrReader(bytes);
  const status = r.enumeration() as NfsStatus;
  const fileWcc = readWccData(r);
  return status === NfsStatus.NFS3_OK
    ? { status, fileWcc, verifier: r.fixedOpaque(NFS3_WRITEVERFSIZE) }
    : { status: status as Exclude<NfsStatus, NfsStatus.NFS3_OK>, fileWcc };
};

export const encodeMountPath = (path: string): Uint8Array => {
  const w = new XdrWriter();
  w.string(path);
  return w.toBytes();
};

export const decodeMountPath = (bytes: Uint8Array): string =>
  new XdrReader(bytes).string(MNTPATHLEN);

export const encodeMountResult = (res: MountResult): Uint8Array => {
  const w = new XdrWriter();
  w.enumeration(res.status);
  if (res.status === MountStatus.MNT3_OK) {
    w.variableOpaque(res.fileHandle);
    w.array(res.authFlavors, (writer, flavor) => writer.int32(flavor));
  }
  return w.toBytes();
};

export const decodeMountResult = (bytes: Uint8Array): MountResult => {
  const r = new XdrReader(bytes);
  const status = r.enumeration() as MountStatus;
  if (status !== MountStatus.MNT3_OK) {
    return { status: status as Exclude<MountStatus, MountStatus.MNT3_OK> };
  }
  return {
    status,
    fileHandle: r.variableOpaque(FHSIZE3),
    authFlavors: r.array((reader) => reader.int32()),
  };
};

export const encodeMountList = (entries: readonly MountEntryRecord[]): Uint8Array => {
  const w = new XdrWriter();
  for (const entry of entries) {
    w.boolean(true);
    w.string(entry.hostname);
    w.string(entry.directory);
  }
  w.boolean(false);
  return w.toBytes();
};

export const decodeMountList = (bytes: Uint8Array): MountEntryRecord[] => {
  const r = new XdrReader(bytes);
  const out: MountEntryRecord[] = [];
  while (r.boolean()) {
    out.push({ hostname: r.string(), directory: r.string(MNTPATHLEN) });
  }
  return out;
};

export const encodeExportList = (nodes: readonly ExportNode[]): Uint8Array => {
  const w = new XdrWriter();
  for (const node of nodes) {
    w.boolean(true);
    w.string(node.directory);
    for (const group of node.groups) {
      w.boolean(true);
      w.string(group);
    }
    w.boolean(false);
  }
  w.boolean(false);
  return w.toBytes();
};

export const decodeExportList = (bytes: Uint8Array): ExportNode[] => {
  const r = new XdrReader(bytes);
  const out: ExportNode[] = [];
  while (r.boolean()) {
    const directory = r.string(MNTPATHLEN);
    const groups: string[] = [];
    while (r.boolean()) groups.push(r.string());
    out.push({ directory, groups });
  }
  return out;
};
