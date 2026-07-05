/**
 * SFTP (draft-ietf-secsh-filexfer §3-9) — real byte-level wire codec.
 * Every packet is `uint32 length` (of everything that follows) + `byte
 * type` + a type-specific payload; every packet after the handshake
 * carries an explicit `uint32 request-id` so responses can be matched
 * to requests out of order — replacing the JSON `{op, ...}` envelope
 * `SshSftpChannel.ts`/`SftpCommandDispatcher.ts` use today (migrated
 * onto this codec in a later phase, `PRD-FTP-SFTP.md` §2.1.20/P19 —
 * this module only adds the codec itself and doesn't touch that path).
 *
 * `OPEN`/`READ`/`WRITE`/`CLOSE` are encoded/decoded here (§4's full
 * packet set), but the handle *semantics* — a real per-session handle
 * table, `READ`/`WRITE` at an arbitrary `(offset, length)` — are P14's
 * deliverable (`SftpHandleTable.ts`), not this phase's.
 */

export const SFTP_TYPE = {
  INIT: 1, VERSION: 2, OPEN: 3, CLOSE: 4, READ: 5, WRITE: 6,
  LSTAT: 7, FSTAT: 8, SETSTAT: 9, FSETSTAT: 10, OPENDIR: 11, READDIR: 12,
  REMOVE: 13, MKDIR: 14, RMDIR: 15, REALPATH: 16, STAT: 17, RENAME: 18,
  READLINK: 19, SYMLINK: 20, LINK: 21,
  STATUS: 101, HANDLE: 102, DATA: 103, NAME: 104, ATTRS: 105,
} as const;

const TYPE_NAME_FROM_CODE: Readonly<Record<number, keyof typeof SFTP_TYPE>> =
  Object.fromEntries(Object.entries(SFTP_TYPE).map(([name, code]) => [code, name])) as Record<number, keyof typeof SFTP_TYPE>;

/** draft-ietf-secsh-filexfer §5 — `ATTRS` flags selecting which fields are present. TYPE/ACL/EXTENDED are v4-v6 additions (§2.1.17/P16). */
const ATTR_FLAG = {
  SIZE: 0x00000001,
  UIDGID: 0x00000002,
  PERMISSIONS: 0x00000004,
  ACMODTIME: 0x00000008,
  TYPE: 0x00000010,
  ACL: 0x00000020,
  EXTENDED: 0x00000040,
} as const;

/** v4-v6 explicit attribute `type` (§5) — the v3 codec had no such field. */
export type SftpWireEntryType = 'file' | 'directory' | 'symlink' | 'special' | 'unknown';

const ENTRY_TYPE_CODE: Readonly<Record<SftpWireEntryType, number>> = { file: 1, directory: 2, symlink: 3, special: 4, unknown: 5 };
const ENTRY_TYPE_FROM_CODE: Readonly<Record<number, SftpWireEntryType>> = { 1: 'file', 2: 'directory', 3: 'symlink', 4: 'special', 5: 'unknown' };

/** v4-v6 ACL entry (§5.2) — carried faithfully on the wire; not enforced by this simulator (PRD-FTP-SFTP.md §2.2). */
export interface SftpWireAclEntry {
  readonly type: 'allow' | 'deny' | 'audit' | 'alarm';
  readonly subject: string;
  readonly permissions: number;
}

const ACL_TYPE_CODE: Readonly<Record<SftpWireAclEntry['type'], number>> = { allow: 0, deny: 1, audit: 2, alarm: 3 };
const ACL_TYPE_FROM_CODE: Readonly<Record<number, SftpWireAclEntry['type']>> = { 0: 'allow', 1: 'deny', 2: 'audit', 3: 'alarm' };

/** v4-v6 named extended attribute (§5) — arbitrary key/value pair. */
export interface SftpWireExtendedAttr {
  readonly name: string;
  readonly value: string;
}

export interface SftpWireAttrs {
  readonly size?: number;
  readonly uid?: number;
  readonly gid?: number;
  readonly permissions?: number;
  readonly atime?: number;
  readonly mtime?: number;
  readonly entryType?: SftpWireEntryType;
  readonly acl?: readonly SftpWireAclEntry[];
  readonly extended?: readonly SftpWireExtendedAttr[];
}

/** v5+ `SSH_FXP_RENAME` flags (§6.5). ATOMIC/NATIVE are accepted but no-ops: this simulator's rename is already atomic and single-namespace. */
export const SFTP_RENAME_FLAG = { OVERWRITE: 0x00000001, ATOMIC: 0x00000002, NATIVE: 0x00000004 } as const;

export interface SftpInitPacket { readonly type: 'INIT'; readonly version: number; }
export interface SftpVersionPacket { readonly type: 'VERSION'; readonly version: number; }

export interface SftpOpenPacket { readonly type: 'OPEN'; readonly requestId: number; readonly filename: string; readonly pflags: number; readonly attrs: SftpWireAttrs; }
export interface SftpClosePacket { readonly type: 'CLOSE'; readonly requestId: number; readonly handle: string; }
export interface SftpReadPacket { readonly type: 'READ'; readonly requestId: number; readonly handle: string; readonly offset: number; readonly length: number; }
export interface SftpWritePacket { readonly type: 'WRITE'; readonly requestId: number; readonly handle: string; readonly offset: number; readonly data: Uint8Array; }
export interface SftpLstatPacket { readonly type: 'LSTAT'; readonly requestId: number; readonly path: string; }
export interface SftpFstatPacket { readonly type: 'FSTAT'; readonly requestId: number; readonly handle: string; }
export interface SftpSetstatPacket { readonly type: 'SETSTAT'; readonly requestId: number; readonly path: string; readonly attrs: SftpWireAttrs; }
export interface SftpFsetstatPacket { readonly type: 'FSETSTAT'; readonly requestId: number; readonly handle: string; readonly attrs: SftpWireAttrs; }
export interface SftpOpendirPacket { readonly type: 'OPENDIR'; readonly requestId: number; readonly path: string; }
export interface SftpReaddirPacket { readonly type: 'READDIR'; readonly requestId: number; readonly handle: string; }
export interface SftpRemovePacket { readonly type: 'REMOVE'; readonly requestId: number; readonly filename: string; }
export interface SftpMkdirPacket { readonly type: 'MKDIR'; readonly requestId: number; readonly path: string; readonly attrs: SftpWireAttrs; }
export interface SftpRmdirPacket { readonly type: 'RMDIR'; readonly requestId: number; readonly path: string; }
export interface SftpRealpathPacket { readonly type: 'REALPATH'; readonly requestId: number; readonly path: string; }
export interface SftpStatPacket { readonly type: 'STAT'; readonly requestId: number; readonly path: string; }
export interface SftpRenamePacket { readonly type: 'RENAME'; readonly requestId: number; readonly oldPath: string; readonly newPath: string; readonly flags?: number; }
export interface SftpReadlinkPacket { readonly type: 'READLINK'; readonly requestId: number; readonly path: string; }
export interface SftpSymlinkPacket { readonly type: 'SYMLINK'; readonly requestId: number; readonly linkpath: string; readonly targetpath: string; }
/** v6 hard link (§3.3) — spec argument order is (newlinkpath, existingpath). */
export interface SftpLinkPacket { readonly type: 'LINK'; readonly requestId: number; readonly newLinkPath: string; readonly existingPath: string; }

export interface SftpStatusPacket { readonly type: 'STATUS'; readonly requestId: number; readonly code: number; readonly message: string; readonly languageTag?: string; }
export interface SftpHandlePacket { readonly type: 'HANDLE'; readonly requestId: number; readonly handle: string; }
export interface SftpDataPacket { readonly type: 'DATA'; readonly requestId: number; readonly data: Uint8Array; }
export interface SftpNameEntry { readonly filename: string; readonly longname: string; readonly attrs: SftpWireAttrs; }
export interface SftpNamePacket { readonly type: 'NAME'; readonly requestId: number; readonly entries: readonly SftpNameEntry[]; }
export interface SftpAttrsPacket { readonly type: 'ATTRS'; readonly requestId: number; readonly attrs: SftpWireAttrs; }

export type SftpWirePacket =
  | SftpInitPacket | SftpVersionPacket
  | SftpOpenPacket | SftpClosePacket | SftpReadPacket | SftpWritePacket
  | SftpLstatPacket | SftpFstatPacket | SftpSetstatPacket | SftpFsetstatPacket
  | SftpOpendirPacket | SftpReaddirPacket | SftpRemovePacket | SftpMkdirPacket
  | SftpRmdirPacket | SftpRealpathPacket | SftpStatPacket | SftpRenamePacket
  | SftpReadlinkPacket | SftpSymlinkPacket | SftpLinkPacket
  | SftpStatusPacket | SftpHandlePacket | SftpDataPacket | SftpNamePacket | SftpAttrsPacket;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

class ByteWriter {
  private chunks: Uint8Array[] = [];

  writeByte(b: number): this {
    this.chunks.push(new Uint8Array([b & 0xff]));
    return this;
  }

  writeUint32(n: number): this {
    this.chunks.push(new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]));
    return this;
  }

  /** Encoded as two big-endian uint32 halves; values stay within `Number.MAX_SAFE_INTEGER` (file sizes/offsets never approach 2^53 in this simulator). */
  writeUint64(n: number): this {
    const hi = Math.floor(n / 0x100000000);
    const lo = n >>> 0;
    return this.writeUint32(hi).writeUint32(lo);
  }

  writeString(s: string): this {
    const bytes = encoder.encode(s);
    return this.writeUint32(bytes.length).writeRaw(bytes);
  }

  writeRaw(bytes: Uint8Array): this {
    this.chunks.push(bytes);
    return this;
  }

  writeAttrs(attrs: SftpWireAttrs): this {
    let flags = 0;
    if (attrs.size !== undefined) flags |= ATTR_FLAG.SIZE;
    if (attrs.uid !== undefined || attrs.gid !== undefined) flags |= ATTR_FLAG.UIDGID;
    if (attrs.permissions !== undefined) flags |= ATTR_FLAG.PERMISSIONS;
    if (attrs.atime !== undefined || attrs.mtime !== undefined) flags |= ATTR_FLAG.ACMODTIME;
    if (attrs.entryType !== undefined) flags |= ATTR_FLAG.TYPE;
    if (attrs.acl !== undefined) flags |= ATTR_FLAG.ACL;
    if (attrs.extended !== undefined) flags |= ATTR_FLAG.EXTENDED;
    this.writeUint32(flags);
    if (flags & ATTR_FLAG.SIZE) this.writeUint64(attrs.size!);
    if (flags & ATTR_FLAG.UIDGID) this.writeUint32(attrs.uid ?? 0).writeUint32(attrs.gid ?? 0);
    if (flags & ATTR_FLAG.PERMISSIONS) this.writeUint32(attrs.permissions!);
    if (flags & ATTR_FLAG.ACMODTIME) this.writeUint32(attrs.atime ?? attrs.mtime ?? 0).writeUint32(attrs.mtime ?? 0);
    if (flags & ATTR_FLAG.TYPE) this.writeByte(ENTRY_TYPE_CODE[attrs.entryType!]);
    if (flags & ATTR_FLAG.ACL) {
      this.writeUint32(attrs.acl!.length);
      for (const e of attrs.acl!) this.writeByte(ACL_TYPE_CODE[e.type]).writeString(e.subject).writeUint32(e.permissions);
    }
    if (flags & ATTR_FLAG.EXTENDED) {
      this.writeUint32(attrs.extended!.length);
      for (const kv of attrs.extended!) this.writeString(kv.name).writeString(kv.value);
    }
    return this;
  }

  toBytes(): Uint8Array {
    const total = this.chunks.reduce((sum, c) => sum + c.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of this.chunks) { out.set(c, offset); offset += c.length; }
    return out;
  }
}

class ByteReader {
  private offset = 0;
  constructor(private readonly bytes: Uint8Array) {}

  private require(n: number): void {
    if (this.offset + n > this.bytes.length) throw new Error('sftp: truncated packet');
  }

  readByte(): number {
    this.require(1);
    return this.bytes[this.offset++];
  }

  readUint32(): number {
    this.require(4);
    const [a, b, c, d] = [this.bytes[this.offset], this.bytes[this.offset + 1], this.bytes[this.offset + 2], this.bytes[this.offset + 3]];
    this.offset += 4;
    return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
  }

  readUint64(): number {
    const hi = this.readUint32();
    const lo = this.readUint32();
    return hi * 0x100000000 + lo;
  }

  readString(): string {
    const len = this.readUint32();
    this.require(len);
    const value = decoder.decode(this.bytes.slice(this.offset, this.offset + len));
    this.offset += len;
    return value;
  }

  readRaw(len: number): Uint8Array {
    this.require(len);
    const value = this.bytes.slice(this.offset, this.offset + len);
    this.offset += len;
    return value;
  }

  readAttrs(): SftpWireAttrs {
    const flags = this.readUint32();
    const attrs: {
      size?: number; uid?: number; gid?: number; permissions?: number; atime?: number; mtime?: number;
      entryType?: SftpWireEntryType; acl?: SftpWireAclEntry[]; extended?: SftpWireExtendedAttr[];
    } = {};
    if (flags & ATTR_FLAG.SIZE) attrs.size = this.readUint64();
    if (flags & ATTR_FLAG.UIDGID) { attrs.uid = this.readUint32(); attrs.gid = this.readUint32(); }
    if (flags & ATTR_FLAG.PERMISSIONS) attrs.permissions = this.readUint32();
    if (flags & ATTR_FLAG.ACMODTIME) { attrs.atime = this.readUint32(); attrs.mtime = this.readUint32(); }
    if (flags & ATTR_FLAG.TYPE) attrs.entryType = ENTRY_TYPE_FROM_CODE[this.readByte()];
    if (flags & ATTR_FLAG.ACL) {
      const count = this.readUint32();
      const acl: SftpWireAclEntry[] = [];
      for (let i = 0; i < count; i++) {
        acl.push({ type: ACL_TYPE_FROM_CODE[this.readByte()], subject: this.readString(), permissions: this.readUint32() });
      }
      attrs.acl = acl;
    }
    if (flags & ATTR_FLAG.EXTENDED) {
      const count = this.readUint32();
      const extended: SftpWireExtendedAttr[] = [];
      for (let i = 0; i < count; i++) extended.push({ name: this.readString(), value: this.readString() });
      attrs.extended = extended;
    }
    return attrs;
  }

  get remaining(): number {
    return this.bytes.length - this.offset;
  }
}

export function encodeSftpWirePacket(pkt: SftpWirePacket): Uint8Array {
  const w = new ByteWriter();
  w.writeByte(SFTP_TYPE[pkt.type]);

  switch (pkt.type) {
    case 'INIT': case 'VERSION':
      w.writeUint32(pkt.version);
      break;
    case 'OPEN':
      w.writeUint32(pkt.requestId).writeString(pkt.filename).writeUint32(pkt.pflags).writeAttrs(pkt.attrs);
      break;
    case 'CLOSE':
      w.writeUint32(pkt.requestId).writeString(pkt.handle);
      break;
    case 'READ':
      w.writeUint32(pkt.requestId).writeString(pkt.handle).writeUint64(pkt.offset).writeUint32(pkt.length);
      break;
    case 'WRITE':
      w.writeUint32(pkt.requestId).writeString(pkt.handle).writeUint64(pkt.offset).writeUint32(pkt.data.length).writeRaw(pkt.data);
      break;
    case 'LSTAT': case 'STAT': case 'OPENDIR': case 'RMDIR': case 'REALPATH': case 'READLINK':
      w.writeUint32(pkt.requestId).writeString(pkt.path);
      break;
    case 'FSTAT': case 'READDIR':
      w.writeUint32(pkt.requestId).writeString(pkt.handle);
      break;
    case 'SETSTAT':
      w.writeUint32(pkt.requestId).writeString(pkt.path).writeAttrs(pkt.attrs);
      break;
    case 'FSETSTAT':
      w.writeUint32(pkt.requestId).writeString(pkt.handle).writeAttrs(pkt.attrs);
      break;
    case 'REMOVE':
      w.writeUint32(pkt.requestId).writeString(pkt.filename);
      break;
    case 'MKDIR':
      w.writeUint32(pkt.requestId).writeString(pkt.path).writeAttrs(pkt.attrs);
      break;
    case 'RENAME':
      w.writeUint32(pkt.requestId).writeString(pkt.oldPath).writeString(pkt.newPath);
      if (pkt.flags !== undefined) w.writeUint32(pkt.flags);
      break;
    case 'SYMLINK':
      w.writeUint32(pkt.requestId).writeString(pkt.linkpath).writeString(pkt.targetpath);
      break;
    case 'LINK':
      w.writeUint32(pkt.requestId).writeString(pkt.newLinkPath).writeString(pkt.existingPath);
      break;
    case 'STATUS':
      w.writeUint32(pkt.requestId).writeUint32(pkt.code).writeString(pkt.message).writeString(pkt.languageTag ?? 'en');
      break;
    case 'HANDLE':
      w.writeUint32(pkt.requestId).writeString(pkt.handle);
      break;
    case 'DATA':
      w.writeUint32(pkt.requestId).writeUint32(pkt.data.length).writeRaw(pkt.data);
      break;
    case 'NAME':
      w.writeUint32(pkt.requestId).writeUint32(pkt.entries.length);
      for (const e of pkt.entries) w.writeString(e.filename).writeString(e.longname).writeAttrs(e.attrs);
      break;
    case 'ATTRS':
      w.writeUint32(pkt.requestId).writeAttrs(pkt.attrs);
      break;
  }

  const body = w.toBytes();
  return new ByteWriter().writeUint32(body.length).writeRaw(body).toBytes();
}

/** `bytes` is exactly one packet, length prefix included (e.g. one `onData` payload). */
export function decodeSftpWirePacket(bytes: Uint8Array): SftpWirePacket | null {
  try {
    const outer = new ByteReader(bytes);
    const length = outer.readUint32();
    const body = outer.readRaw(length);
    const r = new ByteReader(body);
    const typeCode = r.readByte();
    const typeName = TYPE_NAME_FROM_CODE[typeCode];
    if (!typeName) return null;

    switch (typeName) {
      case 'INIT': return { type: 'INIT', version: r.readUint32() };
      case 'VERSION': return { type: 'VERSION', version: r.readUint32() };
      case 'OPEN': {
        const requestId = r.readUint32();
        const filename = r.readString();
        const pflags = r.readUint32();
        const attrs = r.readAttrs();
        return { type: 'OPEN', requestId, filename, pflags, attrs };
      }
      case 'CLOSE': return { type: 'CLOSE', requestId: r.readUint32(), handle: r.readString() };
      case 'READ': {
        const requestId = r.readUint32();
        const handle = r.readString();
        const offset = r.readUint64();
        const length2 = r.readUint32();
        return { type: 'READ', requestId, handle, offset, length: length2 };
      }
      case 'WRITE': {
        const requestId = r.readUint32();
        const handle = r.readString();
        const offset = r.readUint64();
        const dataLen = r.readUint32();
        return { type: 'WRITE', requestId, handle, offset, data: r.readRaw(dataLen) };
      }
      case 'LSTAT': return { type: 'LSTAT', requestId: r.readUint32(), path: r.readString() };
      case 'FSTAT': return { type: 'FSTAT', requestId: r.readUint32(), handle: r.readString() };
      case 'SETSTAT': { const requestId = r.readUint32(); const path = r.readString(); return { type: 'SETSTAT', requestId, path, attrs: r.readAttrs() }; }
      case 'FSETSTAT': { const requestId = r.readUint32(); const handle = r.readString(); return { type: 'FSETSTAT', requestId, handle, attrs: r.readAttrs() }; }
      case 'OPENDIR': return { type: 'OPENDIR', requestId: r.readUint32(), path: r.readString() };
      case 'READDIR': return { type: 'READDIR', requestId: r.readUint32(), handle: r.readString() };
      case 'REMOVE': return { type: 'REMOVE', requestId: r.readUint32(), filename: r.readString() };
      case 'MKDIR': { const requestId = r.readUint32(); const path = r.readString(); return { type: 'MKDIR', requestId, path, attrs: r.readAttrs() }; }
      case 'RMDIR': return { type: 'RMDIR', requestId: r.readUint32(), path: r.readString() };
      case 'REALPATH': return { type: 'REALPATH', requestId: r.readUint32(), path: r.readString() };
      case 'STAT': return { type: 'STAT', requestId: r.readUint32(), path: r.readString() };
      case 'RENAME': {
        const requestId = r.readUint32();
        const oldPath = r.readString();
        const newPath = r.readString();
        const flags = r.remaining > 0 ? r.readUint32() : undefined;
        return { type: 'RENAME', requestId, oldPath, newPath, flags };
      }
      case 'READLINK': return { type: 'READLINK', requestId: r.readUint32(), path: r.readString() };
      case 'SYMLINK': { const requestId = r.readUint32(); const linkpath = r.readString(); return { type: 'SYMLINK', requestId, linkpath, targetpath: r.readString() }; }
      case 'LINK': { const requestId = r.readUint32(); const newLinkPath = r.readString(); return { type: 'LINK', requestId, newLinkPath, existingPath: r.readString() }; }
      case 'STATUS': {
        const requestId = r.readUint32();
        const code = r.readUint32();
        const message = r.readString();
        const languageTag = r.remaining > 0 ? r.readString() : undefined;
        return { type: 'STATUS', requestId, code, message, languageTag };
      }
      case 'HANDLE': return { type: 'HANDLE', requestId: r.readUint32(), handle: r.readString() };
      case 'DATA': { const requestId = r.readUint32(); const len = r.readUint32(); return { type: 'DATA', requestId, data: r.readRaw(len) }; }
      case 'NAME': {
        const requestId = r.readUint32();
        const count = r.readUint32();
        const entries: SftpNameEntry[] = [];
        for (let i = 0; i < count; i++) {
          const filename = r.readString();
          const longname = r.readString();
          entries.push({ filename, longname, attrs: r.readAttrs() });
        }
        return { type: 'NAME', requestId, entries };
      }
      case 'ATTRS': return { type: 'ATTRS', requestId: r.readUint32(), attrs: r.readAttrs() };
    }
  } catch {
    return null;
  }
}
