export const NFS_PROGRAM = 100003;
export const NFS_V3 = 3;
export const NFS_PORT = 2049;

export const MOUNT_PROGRAM = 100005;
export const MOUNT_V3 = 3;

export const NFS3_MAXDATA = 32768;
export const NFS3_MAXPATHLEN = 4096;
export const NFS3_MAXNAMLEN = 255;
export const NFS3_FHSIZE = 64;
export const NFS3_COOKIEVERFSIZE = 8;
export const NFS3_CREATEVERFSIZE = 8;
export const NFS3_WRITEVERFSIZE = 8;
export const MNTPATHLEN = 1024;
export const MNTNAMLEN = 255;
export const FHSIZE3 = 64;

export enum NfsProcedure {
  NULL = 0,
  GETATTR = 1,
  SETATTR = 2,
  LOOKUP = 3,
  ACCESS = 4,
  READLINK = 5,
  READ = 6,
  WRITE = 7,
  CREATE = 8,
  MKDIR = 9,
  SYMLINK = 10,
  MKNOD = 11,
  REMOVE = 12,
  RMDIR = 13,
  RENAME = 14,
  LINK = 15,
  READDIR = 16,
  READDIRPLUS = 17,
  FSSTAT = 18,
  FSINFO = 19,
  PATHCONF = 20,
  COMMIT = 21,
}

export enum NfsStatus {
  NFS3_OK = 0,
  NFS3ERR_PERM = 1,
  NFS3ERR_NOENT = 2,
  NFS3ERR_IO = 5,
  NFS3ERR_NXIO = 6,
  NFS3ERR_ACCES = 13,
  NFS3ERR_EXIST = 17,
  NFS3ERR_XDEV = 18,
  NFS3ERR_NODEV = 19,
  NFS3ERR_NOTDIR = 20,
  NFS3ERR_ISDIR = 21,
  NFS3ERR_INVAL = 22,
  NFS3ERR_FBIG = 27,
  NFS3ERR_NOSPC = 28,
  NFS3ERR_ROFS = 30,
  NFS3ERR_MLINK = 31,
  NFS3ERR_NAMETOOLONG = 63,
  NFS3ERR_NOTEMPTY = 66,
  NFS3ERR_DQUOT = 69,
  NFS3ERR_STALE = 70,
  NFS3ERR_REMOTE = 71,
  NFS3ERR_BADHANDLE = 10001,
  NFS3ERR_NOT_SYNC = 10002,
  NFS3ERR_BAD_COOKIE = 10003,
  NFS3ERR_NOTSUPP = 10004,
  NFS3ERR_TOOSMALL = 10005,
  NFS3ERR_SERVERFAULT = 10006,
  NFS3ERR_BADTYPE = 10007,
  NFS3ERR_JUKEBOX = 10008,
}

export enum Ftype3 {
  NF3REG = 1,
  NF3DIR = 2,
  NF3BLK = 3,
  NF3CHR = 4,
  NF3LNK = 5,
  NF3SOCK = 6,
  NF3FIFO = 7,
}

export enum StableHow {
  UNSTABLE = 0,
  DATA_SYNC = 1,
  FILE_SYNC = 2,
}

export enum CreateMode3 {
  UNCHECKED = 0,
  GUARDED = 1,
  EXCLUSIVE = 2,
}

export enum TimeHow {
  DONT_CHANGE = 0,
  SET_TO_SERVER_TIME = 1,
  SET_TO_CLIENT_TIME = 2,
}

export const ACCESS3_READ = 0x0001;
export const ACCESS3_LOOKUP = 0x0002;
export const ACCESS3_MODIFY = 0x0004;
export const ACCESS3_EXTEND = 0x0008;
export const ACCESS3_DELETE = 0x0010;
export const ACCESS3_EXECUTE = 0x0020;

export const FSF3_LINK = 0x0001;
export const FSF3_SYMLINK = 0x0002;
export const FSF3_HOMOGENEOUS = 0x0008;
export const FSF3_CANSETTIME = 0x0010;

export enum MountProcedure {
  NULL = 0,
  MNT = 1,
  DUMP = 2,
  UMNT = 3,
  UMNTALL = 4,
  EXPORT = 5,
}

export enum MountStatus {
  MNT3_OK = 0,
  MNT3ERR_PERM = 1,
  MNT3ERR_NOENT = 2,
  MNT3ERR_IO = 5,
  MNT3ERR_ACCES = 13,
  MNT3ERR_NOTDIR = 20,
  MNT3ERR_INVAL = 22,
  MNT3ERR_NAMETOOLONG = 63,
  MNT3ERR_NOTSUPP = 10004,
  MNT3ERR_SERVERFAULT = 10006,
}

export const NFS_STATUS_MESSAGES: Readonly<Record<number, string>> = {
  [NfsStatus.NFS3ERR_PERM]: 'Operation not permitted',
  [NfsStatus.NFS3ERR_NOENT]: 'No such file or directory',
  [NfsStatus.NFS3ERR_IO]: 'Input/output error',
  [NfsStatus.NFS3ERR_NXIO]: 'No such device or address',
  [NfsStatus.NFS3ERR_ACCES]: 'Permission denied',
  [NfsStatus.NFS3ERR_EXIST]: 'File exists',
  [NfsStatus.NFS3ERR_XDEV]: 'Invalid cross-device link',
  [NfsStatus.NFS3ERR_NODEV]: 'No such device',
  [NfsStatus.NFS3ERR_NOTDIR]: 'Not a directory',
  [NfsStatus.NFS3ERR_ISDIR]: 'Is a directory',
  [NfsStatus.NFS3ERR_INVAL]: 'Invalid argument',
  [NfsStatus.NFS3ERR_FBIG]: 'File too large',
  [NfsStatus.NFS3ERR_NOSPC]: 'No space left on device',
  [NfsStatus.NFS3ERR_ROFS]: 'Read-only file system',
  [NfsStatus.NFS3ERR_MLINK]: 'Too many links',
  [NfsStatus.NFS3ERR_NAMETOOLONG]: 'File name too long',
  [NfsStatus.NFS3ERR_NOTEMPTY]: 'Directory not empty',
  [NfsStatus.NFS3ERR_DQUOT]: 'Disk quota exceeded',
  [NfsStatus.NFS3ERR_STALE]: 'Stale file handle',
  [NfsStatus.NFS3ERR_REMOTE]: 'Object is remote',
  [NfsStatus.NFS3ERR_BADHANDLE]: 'Illegal NFS file handle',
  [NfsStatus.NFS3ERR_NOT_SYNC]: 'Update synchronization mismatch',
  [NfsStatus.NFS3ERR_BAD_COOKIE]: 'READDIR cookie is stale',
  [NfsStatus.NFS3ERR_NOTSUPP]: 'Operation not supported',
  [NfsStatus.NFS3ERR_TOOSMALL]: 'Buffer or request is too small',
  [NfsStatus.NFS3ERR_SERVERFAULT]: 'Remote I/O error',
  [NfsStatus.NFS3ERR_BADTYPE]: 'Type not supported by server',
  [NfsStatus.NFS3ERR_JUKEBOX]: 'Resource temporarily unavailable',
};

export function nfsStatusMessage(status: NfsStatus): string {
  return NFS_STATUS_MESSAGES[status] ?? `NFS status ${status}`;
}
