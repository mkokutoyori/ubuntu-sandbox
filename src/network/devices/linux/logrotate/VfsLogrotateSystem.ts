import { globPaths } from '../fs/Glob';
import type { INode, VirtualFileSystem } from '../VirtualFileSystem';
import { LocalCalendar } from './CalendarTime';
import { basenameOf } from './LogrotateConfig';
import {
  isFailure, type CompressionOutcome, type CompressionRequest, type Errno, type Failure, type FileStat,
  type LogrotateSystem, type ScriptRun,
} from './LogrotateSystem';

export interface GzipCodec {
  compress(content: string, name: string, mtimeMs: number): string;
  decompress(content: string): string | null;
}

export interface LogrotateEnvironment {
  readonly vfs: VirtualFileSystem;
  readonly cwd: () => string;
  readonly umask: () => number;
  readonly uid: () => number;
  readonly gid: () => number;
  readonly pid: () => number;
  readonly nowMs: () => number;
  readonly zone: () => string | undefined;
  readonly lookupUser: (name: string) => number | null;
  readonly lookupGroup: (name: string) => number | null;
  readonly userExists: (uid: number) => boolean;
  readonly groupExists: (gid: number) => boolean;
  readonly homeDirectory: () => string | null;
  readonly shell: (command: string) => { output: string; exitCode: number };
  readonly deviceOf: (absolutePath: string) => number;
  readonly gzip: GzipCodec;
}

const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

export class VfsLogrotateSystem implements LogrotateSystem {
  readonly calendar: LocalCalendar;
  private workingDirectory: string;
  private effectiveUid: number;
  private effectiveGid: number;

  constructor(private readonly env: LogrotateEnvironment) {
    this.calendar = new LocalCalendar(env.zone());
    this.workingDirectory = env.cwd();
    this.effectiveUid = env.uid();
    this.effectiveGid = env.gid();
  }

  private abs(path: string): string {
    return this.env.vfs.normalizePath(path, this.workingDirectory);
  }

  private convert(node: INode, absolute: string): FileStat {
    const type = node.type === 'file' ? 'file' : node.type === 'directory' ? 'directory' : node.type === 'symlink' ? 'symlink' : 'other';
    return {
      type,
      mode: node.permissions & 0o7777,
      uid: node.uid,
      gid: node.gid,
      size: node.type === 'directory' ? 4096 : node.size,
      nlink: node.linkCount,
      mtimeSec: Math.floor(node.mtime / 1000),
      atimeSec: Math.floor(node.atime / 1000),
      dev: this.env.deviceOf(absolute),
    };
  }

  private missing(absolute: string): Failure {
    const parts = absolute.split('/').filter(Boolean);
    let current = '';
    for (let i = 0; i < parts.length - 1; i++) {
      current += `/${parts[i]}`;
      const node = this.env.vfs.resolveInode(current);
      if (node !== null && node.type !== 'directory') return { errno: 'ENOTDIR' };
    }
    return { errno: 'ENOENT' };
  }

  getuid(): number { return this.env.uid(); }

  geteuid(): number { return this.effectiveUid; }

  getegid(): number { return this.effectiveGid; }

  pid(): number { return this.env.pid(); }

  nowSeconds(): number { return Math.floor(this.env.nowMs() / 1000); }

  cwd(): string { return this.workingDirectory; }

  chdir(path: string): Errno | null {
    const target = this.abs(path);
    const node = this.env.vfs.resolveInode(target);
    if (node === null) return this.missing(target).errno;
    if (node.type !== 'directory') return 'ENOTDIR';
    this.workingDirectory = target;
    return null;
  }

  stat(path: string): FileStat | Failure {
    const absolute = this.abs(path);
    const node = this.env.vfs.resolveInode(absolute);
    return node === null ? this.missing(absolute) : this.convert(node, absolute);
  }

  lstat(path: string): FileStat | Failure {
    const absolute = this.abs(path);
    const node = this.env.vfs.lstat(absolute);
    return node === null ? this.missing(absolute) : this.convert(node, absolute);
  }

  readText(path: string): string | Failure {
    const absolute = this.abs(path);
    const content = this.env.vfs.readFile(absolute);
    return content === null ? this.missing(absolute) : content;
  }

  listDirectory(path: string): string[] | Failure {
    const absolute = this.abs(path);
    const entries = this.env.vfs.listDirectory(absolute);
    if (entries === null) return this.missing(absolute);
    return entries.map((entry) => entry.name).filter((name) => name !== '.' && name !== '..');
  }

  glob(pattern: string, noCheck: boolean): string[] {
    const relative = !pattern.startsWith('/') && !pattern.startsWith('~');
    const base = this.workingDirectory === '/' ? '' : this.workingDirectory;
    const matches = globPaths({
      listNames: (directory) => {
        const node = this.env.vfs.resolveInode(directory === '.' ? this.workingDirectory : directory);
        return node?.type === 'directory' ? [...node.children.keys()].filter((name) => name !== '.' && name !== '..') : null;
      },
      existsNoFollow: (path) => this.env.vfs.existsNoFollow(this.abs(path)),
      isDirectory: (path) => this.env.vfs.getType(this.abs(path)) === 'directory',
    }, pattern, { noCheck, home: this.env.homeDirectory() ?? undefined });
    return relative ? matches.map((path) => (path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path)) : matches;
  }

  createExclusive(path: string, mode: number, uid: number, gid: number): Errno | null {
    const absolute = this.abs(path);
    if (this.env.vfs.existsNoFollow(absolute)) return 'EEXIST';
    const parent = absolute.slice(0, absolute.lastIndexOf('/')) || '/';
    const parentNode = this.env.vfs.resolveInode(parent);
    if (parentNode === null) return this.missing(absolute).errno;
    if (parentNode.type !== 'directory') return 'ENOTDIR';
    const created = this.env.vfs.createFileAt(absolute, '', mode & ~this.env.umask() & 0o7777, uid, gid);
    return created === null ? 'EACCES' : null;
  }

  writeText(path: string, content: string): Errno | null {
    const absolute = this.abs(path);
    const parent = absolute.slice(0, absolute.lastIndexOf('/')) || '/';
    if (this.env.vfs.resolveInode(parent) === null) return this.missing(absolute).errno;
    const ok = this.env.vfs.writeFile(absolute, content, this.effectiveUid, this.effectiveGid, this.env.umask(), false, undefined, false);
    return ok ? null : 'EACCES';
  }

  appendCopy(sourcePath: string, destinationPath: string): Errno | null {
    const content = this.readText(sourcePath);
    return isFailure(content) ? content.errno : this.writeText(destinationPath, content);
  }

  rename(from: string, to: string): Errno | null {
    const source = this.abs(from);
    const target = this.abs(to);
    if (!this.env.vfs.existsNoFollow(source)) return this.missing(source).errno;
    const parent = target.slice(0, target.lastIndexOf('/')) || '/';
    if (this.env.vfs.resolveInode(parent) === null) return this.missing(target).errno;
    return this.env.vfs.rename(source, target) ? null : 'EACCES';
  }

  unlink(path: string): Errno | null {
    const absolute = this.abs(path);
    const node = this.env.vfs.lstat(absolute);
    if (node === null) return this.missing(absolute).errno;
    if (node.type === 'directory') return 'EISDIR';
    return this.env.vfs.deleteFile(absolute) ? null : 'EACCES';
  }

  mkdir(path: string, mode: number, uid: number, gid: number): Errno | null {
    const absolute = this.abs(path);
    if (this.env.vfs.existsNoFollow(absolute)) return 'EEXIST';
    const parent = absolute.slice(0, absolute.lastIndexOf('/')) || '/';
    if (this.env.vfs.resolveInode(parent) === null) return this.missing(absolute).errno;
    if (!this.env.vfs.mkdir(absolute, mode & ~this.env.umask() & 0o7777, this.effectiveUid, this.effectiveGid)) return 'EACCES';
    this.env.vfs.chown(absolute, uid, gid);
    this.env.vfs.chmod(absolute, mode);
    return null;
  }

  chmod(path: string, mode: number): Errno | null {
    return this.env.vfs.chmod(this.abs(path), mode) ? null : 'ENOENT';
  }

  chown(path: string, uid: number, gid: number): Errno | null {
    return this.env.vfs.chown(this.abs(path), uid, gid) ? null : 'ENOENT';
  }

  setTimes(path: string, atimeSec: number, mtimeSec: number): void {
    this.env.vfs.setTimes(this.abs(path), { atime: atimeSec * 1000, mtime: mtimeSec * 1000 });
  }

  truncate(path: string): Errno | null {
    const absolute = this.abs(path);
    const node = this.env.vfs.resolveInode(absolute);
    if (node === null) return this.missing(absolute).errno;
    node.content = '';
    node.size = 0;
    node.mtime = this.env.nowMs();
    return null;
  }

  lookupUser(name: string): number | null { return this.env.lookupUser(name); }

  lookupGroup(name: string): number | null { return this.env.lookupGroup(name); }

  userExists(uid: number): boolean { return this.env.userExists(uid); }

  groupExists(gid: number): boolean { return this.env.groupExists(gid); }

  homeDirectory(): string | null { return this.env.homeDirectory(); }

  switchEffective(uid: number, gid: number): boolean {
    this.effectiveUid = uid;
    this.effectiveGid = gid;
    return true;
  }

  runScript(script: string, args: readonly string[]): ScriptRun {
    const command = `sh -c ${quote(script)} logrotate_script ${args.map(quote).join(' ')}`;
    const run = this.env.shell(command);
    return { status: run.exitCode === 0 ? 0 : run.exitCode << 8, output: run.output === '' ? '' : `${run.output}\n` };
  }

  private invocation(program: string): string {
    return this.env.vfs.exists(this.abs(program)) ? program : basenameOf(program);
  }

  compress(request: CompressionRequest): CompressionOutcome {
    const program = basenameOf(request.program);
    if (program === 'gzip') {
      const content = this.readText(request.inputPath);
      if (isFailure(content)) return { exited: true, status: 1 << 8, stderr: '', executable: true };
      const stat = this.stat(request.inputPath);
      const mtime = isFailure(stat) ? 0 : stat.mtimeSec * 1000;
      this.writeText(request.outputPath, this.env.gzip.compress(content, '', mtime));
      return { exited: true, status: 0, stderr: '', executable: true };
    }
    const options = request.options.map(quote).join(' ');
    const run = this.env.shell(`${quote(this.invocation(request.program))} ${options} < ${quote(request.inputPath)} > ${quote(request.outputPath)}`);
    if (run.exitCode === 127) {
      return {
        exited: true, status: 1 << 8, executable: false,
        stderr: `error: cannot execute compress command '${request.program}': No such file or directory\n`,
      };
    }
    return { exited: true, status: run.exitCode === 0 ? 0 : run.exitCode << 8, stderr: run.output === '' ? '' : `${run.output}\n`, executable: true };
  }

  uncompressForMail(path: string, program: string): string | null {
    if (!/(^|\/)(gunzip|gzip|zcat)$/.test(program)) return null;
    const content = this.readText(path);
    return isFailure(content) ? null : this.env.gzip.decompress(content);
  }

  mail(command: string, subject: string, address: string, body: string): ScriptRun {
    const temporary = `/tmp/.logrotate-mail-${this.nowSeconds()}-${this.pid()}`;
    this.env.vfs.writeFile(temporary, body, this.effectiveUid, this.effectiveGid, this.env.umask());
    const run = this.env.shell(`${quote(this.invocation(command))} -s ${quote(subject)} ${quote(address)} < ${quote(temporary)}`);
    this.env.vfs.deleteFile(temporary);
    if (run.exitCode === 127) return { status: 1 << 8, output: 'error: cannot execute mail command: No such file or directory\n' };
    return { status: run.exitCode === 0 ? 0 : run.exitCode << 8, output: run.output === '' ? '' : `${run.output}\n` };
  }

  shred(path: string): boolean {
    const node = this.env.vfs.resolveInode(this.abs(path));
    if (node === null) return false;
    node.content = '';
    return true;
  }
}
