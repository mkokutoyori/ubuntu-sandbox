import { describe, it, expect } from 'vitest';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { SAMPLE_SCRIPTS } from '@/network/devices/linux/SampleScripts';

describe('Sample scripts in VFS', () => {
  const vfs = new VirtualFileSystem();

  it('should have /home/scripts directory', () => {
    const inode = vfs.resolveInode('/home/scripts');
    expect(inode).not.toBeNull();
    expect(inode!.type).toBe('directory');
  });

  it('should contain all sample scripts', () => {
    for (const script of SAMPLE_SCRIPTS) {
      const inode = vfs.resolveInode(`/home/scripts/${script.name}`);
      expect(inode, `${script.name} should exist`).not.toBeNull();
      expect(inode!.type).toBe('file');
      expect(inode!.content).toBe(script.content);
    }
  });

  it('should have correct permissions on scripts', () => {
    for (const script of SAMPLE_SCRIPTS) {
      const inode = vfs.resolveInode(`/home/scripts/${script.name}`);
      expect(inode).not.toBeNull();
      expect(inode!.permissions).toBe(script.perms);
    }
  });

  it('should have 11 files (10 scripts + README)', () => {
    const dir = vfs.resolveInode('/home/scripts');
    expect(dir).not.toBeNull();
    // children includes '.' and '..' plus the files
    const fileCount = dir!.children.size - 2;
    expect(fileCount).toBe(SAMPLE_SCRIPTS.length);
  });

  it('README.txt should have 0644 permissions', () => {
    const readme = vfs.resolveInode('/home/scripts/README.txt');
    expect(readme).not.toBeNull();
    expect(readme!.permissions).toBe(0o644);
  });

  it('shell scripts should have 0755 permissions', () => {
    const hello = vfs.resolveInode('/home/scripts/01_hello.sh');
    expect(hello).not.toBeNull();
    expect(hello!.permissions).toBe(0o755);
  });
});
