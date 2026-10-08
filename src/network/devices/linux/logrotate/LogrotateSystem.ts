import type { LocalCalendar } from './CalendarTime';

export type Errno =
  | 'ENODATA' | 'ELOOP' | 'ENOENT' | 'EEXIST' | 'ENOTDIR' | 'EISDIR' | 'EACCES' | 'EPERM' | 'ENOTSUP' | 'ENOTEMPTY' | 'EXDEV' | 'EAGAIN' | 'EIO';

export const STRERROR: Readonly<Record<Errno, string>> = {
  ENODATA: 'No data available',
  ELOOP: 'Too many levels of symbolic links',
  ENOENT: 'No such file or directory',
  EEXIST: 'File exists',
  ENOTDIR: 'Not a directory',
  EISDIR: 'Is a directory',
  EACCES: 'Permission denied',
  EPERM: 'Operation not permitted',
  ENOTSUP: 'Operation not supported',
  ENOTEMPTY: 'Directory not empty',
  EXDEV: 'Invalid cross-device link',
  EAGAIN: 'Resource temporarily unavailable',
  EIO: 'Input/output error',
};

export interface FileStat {
  readonly type: 'file' | 'directory' | 'symlink' | 'other';
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly size: number;
  readonly nlink: number;
  readonly mtimeSec: number;
  readonly atimeSec: number;
  readonly dev: number;
}

export type Failure = { readonly errno: Errno };

export const isFailure = <T>(value: T | Failure): value is Failure =>
  typeof value === 'object' && value !== null && 'errno' in (value as object);

export interface ScriptRun {
  readonly status: number;
  readonly output: string;
}

export interface CompressionRequest {
  readonly program: string;
  readonly options: readonly string[];
  readonly inputPath: string;
  readonly outputPath: string;
  readonly environmentFileName: string;
}

export interface CompressionOutcome {
  readonly exited: boolean;
  readonly status: number;
  readonly stderr: string;
  readonly executable: boolean;
}

export interface LogrotateSystem {
  readonly calendar: LocalCalendar;
  getuid(): number;
  geteuid(): number;
  getegid(): number;
  pid(): number;
  nowSeconds(): number;
  cwd(): string;
  chdir(path: string): Errno | null;
  stat(path: string): FileStat | Failure;
  lstat(path: string): FileStat | Failure;
  readText(path: string): string | Failure;
  listDirectory(path: string): string[] | Failure;
  glob(pattern: string, noCheck: boolean): string[];
  createExclusive(path: string, mode: number, uid: number, gid: number): Errno | null;
  writeText(path: string, content: string): Errno | null;
  appendCopy(sourcePath: string, destinationPath: string): Errno | null;
  rename(from: string, to: string): Errno | null;
  unlink(path: string): Errno | null;
  mkdir(path: string, mode: number, uid: number, gid: number): Errno | null;
  chmod(path: string, mode: number): Errno | null;
  chown(path: string, uid: number, gid: number): Errno | null;
  setTimes(path: string, atimeSec: number, mtimeSec: number): void;
  truncate(path: string): Errno | null;
  lookupUser(name: string): number | null;
  lookupGroup(name: string): number | null;
  userExists(uid: number): boolean;
  groupExists(gid: number): boolean;
  homeDirectory(): string | null;
  switchEffective(uid: number, gid: number): boolean;
  runScript(script: string, args: readonly string[]): ScriptRun;
  compress(request: CompressionRequest): CompressionOutcome;
  uncompressForMail(path: string, program: string): string | null;
  mail(command: string, subject: string, address: string, body: string): ScriptRun;
  shred(path: string, cycles: number): boolean;
}
