import type { Ftype3, NfsStatus, StableHow, CreateMode3, TimeHow } from './NfsConstants';

export type NfsFileHandle = Uint8Array;

export interface SpecData3 {
  readonly specdata1: number;
  readonly specdata2: number;
}

export interface NfsTime3 {
  readonly seconds: number;
  readonly nseconds: number;
}

export interface Fattr3 {
  readonly type: Ftype3;
  readonly mode: number;
  readonly nlink: number;
  readonly uid: number;
  readonly gid: number;
  readonly size: bigint;
  readonly used: bigint;
  readonly rdev: SpecData3;
  readonly fsid: bigint;
  readonly fileid: bigint;
  readonly atime: NfsTime3;
  readonly mtime: NfsTime3;
  readonly ctime: NfsTime3;
}

export interface WccAttr {
  readonly size: bigint;
  readonly mtime: NfsTime3;
  readonly ctime: NfsTime3;
}

export interface WccData {
  readonly before: WccAttr | null;
  readonly after: Fattr3 | null;
}

export interface SetAtime {
  readonly how: TimeHow;
  readonly time?: NfsTime3;
}

export interface Sattr3 {
  readonly mode?: number;
  readonly uid?: number;
  readonly gid?: number;
  readonly size?: bigint;
  readonly atime?: SetAtime;
  readonly mtime?: SetAtime;
}

export interface DirOpArgs3 {
  readonly dir: NfsFileHandle;
  readonly name: string;
}

export interface GetAttrArgs { readonly object: NfsFileHandle }
export type GetAttrResult =
  | { readonly status: NfsStatus.NFS3_OK; readonly attributes: Fattr3 }
  | { readonly status: Exclude<NfsStatus, NfsStatus.NFS3_OK> };

export interface SetAttrArgs {
  readonly object: NfsFileHandle;
  readonly newAttributes: Sattr3;
  readonly guardCtime: NfsTime3 | null;
}
export interface SetAttrResult {
  readonly status: NfsStatus;
  readonly objectWcc: WccData;
}

export interface LookupArgs { readonly what: DirOpArgs3 }
export type LookupResult =
  | {
      readonly status: NfsStatus.NFS3_OK;
      readonly object: NfsFileHandle;
      readonly objectAttributes: Fattr3 | null;
      readonly dirAttributes: Fattr3 | null;
    }
  | {
      readonly status: Exclude<NfsStatus, NfsStatus.NFS3_OK>;
      readonly dirAttributes: Fattr3 | null;
    };

export interface AccessArgs {
  readonly object: NfsFileHandle;
  readonly access: number;
}
export type AccessResult =
  | {
      readonly status: NfsStatus.NFS3_OK;
      readonly objectAttributes: Fattr3 | null;
      readonly access: number;
    }
  | {
      readonly status: Exclude<NfsStatus, NfsStatus.NFS3_OK>;
      readonly objectAttributes: Fattr3 | null;
    };

export interface ReadLinkArgs { readonly symlink: NfsFileHandle }
export type ReadLinkResult =
  | {
      readonly status: NfsStatus.NFS3_OK;
      readonly symlinkAttributes: Fattr3 | null;
      readonly data: string;
    }
  | {
      readonly status: Exclude<NfsStatus, NfsStatus.NFS3_OK>;
      readonly symlinkAttributes: Fattr3 | null;
    };

export interface ReadArgs {
  readonly file: NfsFileHandle;
  readonly offset: bigint;
  readonly count: number;
}
export type ReadResult =
  | {
      readonly status: NfsStatus.NFS3_OK;
      readonly fileAttributes: Fattr3 | null;
      readonly count: number;
      readonly eof: boolean;
      readonly data: Uint8Array;
    }
  | {
      readonly status: Exclude<NfsStatus, NfsStatus.NFS3_OK>;
      readonly fileAttributes: Fattr3 | null;
    };

export interface WriteArgs {
  readonly file: NfsFileHandle;
  readonly offset: bigint;
  readonly count: number;
  readonly stable: StableHow;
  readonly data: Uint8Array;
}
export type WriteResult =
  | {
      readonly status: NfsStatus.NFS3_OK;
      readonly fileWcc: WccData;
      readonly count: number;
      readonly committed: StableHow;
      readonly verifier: Uint8Array;
    }
  | {
      readonly status: Exclude<NfsStatus, NfsStatus.NFS3_OK>;
      readonly fileWcc: WccData;
    };

export type CreateHow3 =
  | { readonly mode: CreateMode3.UNCHECKED | CreateMode3.GUARDED; readonly attributes: Sattr3 }
  | { readonly mode: CreateMode3.EXCLUSIVE; readonly verifier: Uint8Array };

export interface CreateArgs {
  readonly where: DirOpArgs3;
  readonly how: CreateHow3;
}

export type CreateResult =
  | {
      readonly status: NfsStatus.NFS3_OK;
      readonly object: NfsFileHandle | null;
      readonly objectAttributes: Fattr3 | null;
      readonly dirWcc: WccData;
    }
  | {
      readonly status: Exclude<NfsStatus, NfsStatus.NFS3_OK>;
      readonly dirWcc: WccData;
    };

export interface MkdirArgs {
  readonly where: DirOpArgs3;
  readonly attributes: Sattr3;
}

export interface SymlinkArgs {
  readonly where: DirOpArgs3;
  readonly symlinkAttributes: Sattr3;
  readonly symlinkData: string;
}

export type MknodData3 =
  | { readonly type: Ftype3.NF3CHR | Ftype3.NF3BLK; readonly attributes: Sattr3; readonly spec: SpecData3 }
  | { readonly type: Ftype3.NF3SOCK | Ftype3.NF3FIFO; readonly attributes: Sattr3 }
  | { readonly type: Ftype3.NF3REG | Ftype3.NF3DIR | Ftype3.NF3LNK };

export interface MknodArgs {
  readonly where: DirOpArgs3;
  readonly what: MknodData3;
}

export interface RemoveArgs { readonly object: DirOpArgs3 }
export interface RemoveResult {
  readonly status: NfsStatus;
  readonly dirWcc: WccData;
}

export interface RenameArgs {
  readonly from: DirOpArgs3;
  readonly to: DirOpArgs3;
}
export interface RenameResult {
  readonly status: NfsStatus;
  readonly fromDirWcc: WccData;
  readonly toDirWcc: WccData;
}

export interface LinkArgs {
  readonly file: NfsFileHandle;
  readonly link: DirOpArgs3;
}
export interface LinkResult {
  readonly status: NfsStatus;
  readonly fileAttributes: Fattr3 | null;
  readonly linkDirWcc: WccData;
}

export interface ReadDirArgs {
  readonly dir: NfsFileHandle;
  readonly cookie: bigint;
  readonly cookieVerifier: Uint8Array;
  readonly count: number;
}

export interface DirEntry3 {
  readonly fileid: bigint;
  readonly name: string;
  readonly cookie: bigint;
}

export type ReadDirResult =
  | {
      readonly status: NfsStatus.NFS3_OK;
      readonly dirAttributes: Fattr3 | null;
      readonly cookieVerifier: Uint8Array;
      readonly entries: readonly DirEntry3[];
      readonly eof: boolean;
    }
  | {
      readonly status: Exclude<NfsStatus, NfsStatus.NFS3_OK>;
      readonly dirAttributes: Fattr3 | null;
    };

export interface ReadDirPlusArgs {
  readonly dir: NfsFileHandle;
  readonly cookie: bigint;
  readonly cookieVerifier: Uint8Array;
  readonly dirCount: number;
  readonly maxCount: number;
}

export interface DirEntryPlus3 extends DirEntry3 {
  readonly nameAttributes: Fattr3 | null;
  readonly nameHandle: NfsFileHandle | null;
}

export type ReadDirPlusResult =
  | {
      readonly status: NfsStatus.NFS3_OK;
      readonly dirAttributes: Fattr3 | null;
      readonly cookieVerifier: Uint8Array;
      readonly entries: readonly DirEntryPlus3[];
      readonly eof: boolean;
    }
  | {
      readonly status: Exclude<NfsStatus, NfsStatus.NFS3_OK>;
      readonly dirAttributes: Fattr3 | null;
    };

export interface FsStatArgs { readonly fsroot: NfsFileHandle }
export type FsStatResult =
  | {
      readonly status: NfsStatus.NFS3_OK;
      readonly objectAttributes: Fattr3 | null;
      readonly totalBytes: bigint;
      readonly freeBytes: bigint;
      readonly availableBytes: bigint;
      readonly totalFiles: bigint;
      readonly freeFiles: bigint;
      readonly availableFiles: bigint;
      readonly invarSeconds: number;
    }
  | {
      readonly status: Exclude<NfsStatus, NfsStatus.NFS3_OK>;
      readonly objectAttributes: Fattr3 | null;
    };

export interface FsInfoArgs { readonly fsroot: NfsFileHandle }
export type FsInfoResult =
  | {
      readonly status: NfsStatus.NFS3_OK;
      readonly objectAttributes: Fattr3 | null;
      readonly readMax: number;
      readonly readPreferred: number;
      readonly readMultiple: number;
      readonly writeMax: number;
      readonly writePreferred: number;
      readonly writeMultiple: number;
      readonly readDirPreferred: number;
      readonly maxFileSize: bigint;
      readonly timeDelta: NfsTime3;
      readonly properties: number;
    }
  | {
      readonly status: Exclude<NfsStatus, NfsStatus.NFS3_OK>;
      readonly objectAttributes: Fattr3 | null;
    };

export interface PathConfArgs { readonly object: NfsFileHandle }
export type PathConfResult =
  | {
      readonly status: NfsStatus.NFS3_OK;
      readonly objectAttributes: Fattr3 | null;
      readonly linkMax: number;
      readonly nameMax: number;
      readonly noTrunc: boolean;
      readonly chownRestricted: boolean;
      readonly caseInsensitive: boolean;
      readonly casePreserving: boolean;
    }
  | {
      readonly status: Exclude<NfsStatus, NfsStatus.NFS3_OK>;
      readonly objectAttributes: Fattr3 | null;
    };

export interface CommitArgs {
  readonly file: NfsFileHandle;
  readonly offset: bigint;
  readonly count: number;
}
export type CommitResult =
  | {
      readonly status: NfsStatus.NFS3_OK;
      readonly fileWcc: WccData;
      readonly verifier: Uint8Array;
    }
  | {
      readonly status: Exclude<NfsStatus, NfsStatus.NFS3_OK>;
      readonly fileWcc: WccData;
    };

export interface MountEntryRecord {
  readonly hostname: string;
  readonly directory: string;
}

export interface ExportNode {
  readonly directory: string;
  readonly groups: readonly string[];
}

export type MountResult =
  | {
      readonly status: import('./NfsConstants').MountStatus.MNT3_OK;
      readonly fileHandle: NfsFileHandle;
      readonly authFlavors: readonly number[];
    }
  | { readonly status: Exclude<import('./NfsConstants').MountStatus, import('./NfsConstants').MountStatus.MNT3_OK> };
