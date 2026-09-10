/**
 * SimulatedFileSystem — in-memory IFileSystemProvider for testing.
 *
 * Pre-populated with a few "simulated" paths so test expectations pass
 * out of the box with a bare PSInterpreter (no Windows device attached).
 */

import type { IFileSystemProvider, DirEntry } from './PSProviders';
import { normalizeWindowsPath } from '@/network/devices/windows/windowsPath';

export class SimulatedFileSystem implements IFileSystemProvider {
  private readonly files = new Map<string, string>();
  private readonly dirs  = new Set<string>();
  private cwd = 'C:\\';

  constructor() {
    // Pre-populate so "simulated-drive\\" looks non-empty and known paths work
    this.dirs.add('c:\\simulated-drive');
    this.dirs.add('c:\\simulated-drive\\subdir');
    this.files.set('c:\\simulated-drive\\file1.txt', 'simulated content');
    this.files.set('c:\\simulated-drive\\file2.txt', 'more content');
    this.files.set('c:\\simulated-drive\\subdir\\nested.txt', 'nested');
    this.files.set('c:\\config.txt', 'simulated content');
    this.files.set('c:\\fake\\path\\item.txt', 'item');
    this.dirs.add('c:\\fake\\path');
    this.dirs.add('c:\\fake');
    // Les repertoires qu'une machine Windows a toujours. `Set-Location`
    // verifie desormais l'existence du chemin ; un bouchon en forme de
    // Windows doit donc porter les dossiers d'un Windows, sans quoi il
    // refuserait un `cd C:\\Windows` qui reussit sur toute machine reelle.
    this.dirs.add('c:');
    for (const d of ['windows', 'windows\\system32', 'program files',
      'program files (x86)', 'users', 'users\\user', 'temp']) {
      this.dirs.add(`c:\\${d}`);
    }
  }

  private norm(path: string): string {
    return normalizeWindowsPath(path, this.cwd).toLowerCase();
  }

  exists(path: string): boolean {
    const key = this.norm(path);
    if (key === 'c:\\') return true;
    return this.files.has(key) || this.dirs.has(key);
  }

  readFile(path: string): string {
    const key = this.norm(path);
    const content = this.files.get(key);
    if (content === undefined) throw new Error(`File not found: ${path}`);
    return content;
  }

  tailFile(path: string, lines: number): string[] {
    return this.readFile(path).split('\n').slice(-lines);
  }

  writeFile(path: string, content: string): void {
    this.files.set(this.norm(path), content);
  }

  appendFile(path: string, content: string): void {
    const key = this.norm(path);
    const existing = this.files.get(key) ?? '';
    // Plain concatenation — line semantics belong to the caller (Add-Content,
    // cmd `echo >>`, etc.) so this provider behaves like a real filesystem.
    this.files.set(key, existing + content);
  }

  listDir(path: string): DirEntry[] {
    const prefix = this.norm(path).replace(/\\+$/, '') + '\\';
    const out: DirEntry[] = [];
    const seen = new Set<string>();

    const collect = (key: string, size: number): void => {
      if (!key.startsWith(prefix)) return;
      const seg = key.slice(prefix.length).split('\\')[0];
      if (!seg || seen.has(seg)) return;
      seen.add(seg);
      const isDirectory = this.dirs.has(prefix + seg);
      out.push({ name: seg, isDirectory, size: isDirectory ? 0 : size, mtime: new Date() });
    };

    for (const [k, content] of this.files) collect(k, content.length);
    for (const d of this.dirs) collect(d, 0);
    return out;
  }

  createFile(path: string): void { this.files.set(this.norm(path), ''); }
  createDir(path: string):  void {
    const key = this.norm(path);
    const [drive, ...segments] = key.split('\\');
    let walked = drive;
    for (const segment of segments) {
      if (segment === '') continue;
      walked = `${walked}\\${segment}`;
      this.dirs.add(walked);
    }
  }

  remove(path: string, _recurse: boolean): void {
    const key = this.norm(path);
    this.files.delete(key);
    this.dirs.delete(key);
  }

  copy(src: string, dest: string): void {
    const content = this.readFile(src);
    this.files.set(this.norm(dest), content);
  }

  move(src: string, dest: string): void {
    this.copy(src, dest);
    this.remove(src, false);
  }

  normalizePath(path: string, cwd: string): string {
    return normalizeWindowsPath(path, cwd);
  }

  getCwd(): string { return this.cwd; }
  setCwd(path: string): void { this.cwd = path; }
  isDirectory(path: string): boolean { return this.dirs.has(this.norm(path)); }
  getAcl(_path: string) { return null; }
  setOwner(_path: string, _owner: string): boolean { return false; }
  addAce(_path: string, _ace: { principal: string; type: 'allow' | 'deny'; permissions: string[] }): boolean { return false; }
  setAclProtected(_path: string, _isProtected: boolean): boolean { return false; }
}
