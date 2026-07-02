import { describe, it, expect, beforeEach } from 'vitest';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { VfsPath, PathError } from '@/network/devices/linux/VfsPath';

describe('VfsPath', () => {
  let vfs: VirtualFileSystem;

  beforeEach(() => {
    vfs = new VirtualFileSystem();
    vfs.mkdirp('/home/alice', 0o755, 1000, 1000);
    vfs.writeFile('/home/alice/notes.txt', 'hi\n', 1000, 1000, 0o022);
    vfs.mkdirp('/secret', 0o700, 0, 0);
    vfs.writeFile('/secret/key', 'k\n', 0, 0, 0o077);
  });

  const alice = { uid: 1000, gid: 1000, gids: [1000] };
  const root = { uid: 0, gid: 0 };

  it('normalises the input against cwd', () => {
    const p = new VfsPath(vfs, 'notes.txt', '/home/alice', alice);
    expect(p.value).toBe('/home/alice/notes.txt');
    expect(p.basename).toBe('notes.txt');
    expect(p.dirname).toBe('/home/alice');
  });

  it('verifies existence and type', () => {
    expect(vfs.path('/home/alice/notes.txt').exists()).toBe(true);
    expect(vfs.path('/home/alice/notes.txt').isFile()).toBe(true);
    expect(vfs.path('/home/alice').isDirectory()).toBe(true);
    expect(vfs.path('/home/alice/missing').exists()).toBe(false);
  });

  it('enforces DAC read access per actor', () => {
    expect(vfs.path('/secret/key', '/', root).canRead()).toBe(true);
    expect(vfs.path('/secret/key', '/', alice).canRead()).toBe(false);
  });

  it('enforces DAC write access against the parent for new files', () => {
    expect(vfs.path('/secret/new', '/', alice).canWrite()).toBe(false);
    expect(vfs.path('/home/alice/new', '/', alice).parent().canWrite()).toBe(true);
  });

  it('assertExists throws ENOENT with a realistic message', () => {
    expect(() => vfs.path('/nope').assertExists()).toThrow(PathError);
    try {
      vfs.path('/nope').assertExists();
    } catch (e) {
      expect((e as PathError).reason).toBe('ENOENT');
      expect((e as PathError).message).toContain('No such file or directory');
    }
  });

  it('assertReadable throws EACCES when the actor lacks rights', () => {
    try {
      vfs.path('/secret/key', '/', alice).assertReadable();
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(PathError);
      expect((e as PathError).reason).toBe('EACCES');
    }
  });

  it('assertWritable passes for an existing writable file and fails on a read-only dir', () => {
    expect(() => vfs.path('/home/alice/notes.txt', '/', alice).assertWritable()).not.toThrow();
    expect(() => vfs.path('/secret/x', '/', alice).assertWritable()).toThrow(PathError);
  });

  it('canonicalises via realpath and carries the actor forward', () => {
    vfs.createSymlink('/home/alice/link', 'notes.txt', 1000, 1000);
    const r = vfs.path('/home/alice/link', '/', alice).realpath();
    expect(r?.value).toBe('/home/alice/notes.txt');
  });

  it('join and parent return new bound paths', () => {
    const home = vfs.path('/home/alice', '/', alice);
    expect(home.join('notes.txt').value).toBe('/home/alice/notes.txt');
    expect(home.parent().value).toBe('/home');
  });
});
