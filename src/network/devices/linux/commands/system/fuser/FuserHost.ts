import type { Errno } from '../../../../../core/Errno';

export type FuserFileKind = 'regular' | 'directory' | 'symlink' | 'socket' | 'block' | 'character' | 'fifo';

export interface FuserStat {
  readonly device: number;
  readonly inode: number;
  readonly kind: FuserFileKind;
  readonly rdev: number;
  readonly uid: number;
  readonly ownerWritable: boolean;
}

export interface FuserFailure {
  readonly errno: Errno;
}

export type FuserStatResult = FuserStat | FuserFailure;
export type FuserLinkResult = string | FuserFailure;

export interface ResolvedAddress {
  readonly family: 4 | 6;
  readonly address: string;
}

export interface FuserHost {
  readonly selfPid: number;
  currentDirectory(): string;
  stat(path: string): FuserStatResult;
  lstat(path: string): FuserStatResult;
  readLink(path: string): FuserLinkResult;
  listDirectory(path: string): readonly string[] | null;
  readFile(path: string): string | null;
  userName(uid: number): string | null;
  socketDevice(): number;
  lookupService(service: string, protocol: 'tcp' | 'udp'): number | null;
  lookupHost(host: string): readonly ResolvedAddress[] | null;
  kill(pid: number, signal: number): Errno | null;
  readAnswer(): string | null;
}

export function isFailure(result: FuserStatResult | FuserLinkResult): result is FuserFailure {
  return typeof result === 'object' && 'errno' in result;
}
