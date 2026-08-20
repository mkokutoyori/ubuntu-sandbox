import { describe, it, expect, beforeEach } from 'vitest';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';

describe('VirtualFileSystem.realpath', () => {
  let vfs: VirtualFileSystem;

  beforeEach(() => {
    vfs = new VirtualFileSystem();
    vfs.mkdirp('/etc', 0o755, 0, 0);
    vfs.mkdirp('/var/data', 0o755, 0, 0);
    vfs.writeFile('/etc/passwd', 'root:x:0:0\n', 0, 0, 0o022);
  });

  it('canonicalises an existing file path', () => {
    expect(vfs.realpath('/etc/passwd')).toBe('/etc/passwd');
  });

  it('collapses . and .. against the real tree', () => {
    expect(vfs.realpath('/etc/../etc/passwd')).toBe('/etc/passwd');
    expect(vfs.realpath('/var/data/..')).toBe('/var');
  });

  it('resolves relative paths against cwd', () => {
    expect(vfs.realpath('passwd', '/etc')).toBe('/etc/passwd');
    expect(vfs.realpath('.', '/var/data')).toBe('/var/data');
  });

  it('returns null when a component does not exist', () => {
    expect(vfs.realpath('/etc/nope/passwd')).toBeNull();
    expect(vfs.realpath('/does/not/exist')).toBeNull();
  });

  it('returns the canonical location of a missing final component when not required', () => {
    expect(vfs.realpath('/etc/newfile', '/', false)).toBe('/etc/newfile');
    expect(vfs.realpath('/etc/missingdir/file', '/', false)).toBeNull();
  });

  it('follows a symlink to its real target', () => {
    vfs.createSymlink('/etc/alias', '/etc/passwd', 0, 0);
    expect(vfs.realpath('/etc/alias')).toBe('/etc/passwd');
  });

  it('resolves a relative symlink against its own directory', () => {
    vfs.createSymlink('/etc/rel', 'passwd', 0, 0);
    expect(vfs.realpath('/etc/rel')).toBe('/etc/passwd');
  });

  it('applies .. after resolving an intermediate symlink, not lexically', () => {
    vfs.mkdirp('/real/sub', 0o755, 0, 0);
    vfs.writeFile('/real/target', 'x', 0, 0, 0o022);
    vfs.createSymlink('/link', '/real/sub', 0, 0);
    expect(vfs.realpath('/link/../target')).toBe('/real/target');
  });

  it('detects symlink loops instead of hanging', () => {
    vfs.createSymlink('/loopA', '/loopB', 0, 0);
    vfs.createSymlink('/loopB', '/loopA', 0, 0);
    expect(vfs.realpath('/loopA')).toBeNull();
  });
});
