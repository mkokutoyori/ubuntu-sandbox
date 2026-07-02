import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

describe('rm --preserve-root failsafe', () => {
  it('refuses rm -rf / and leaves the filesystem intact', async () => {
    const pc: any = new LinuxPC('pc1', 'PC1', 0, 0);
    const out = await pc.executeCommand('rm -rf /');
    expect(out).toContain("it is dangerous to operate recursively on '/'");
    expect(out).toContain('--no-preserve-root');
    expect(pc.executor.vfs.exists('/etc/passwd')).toBe(true);
    expect(pc.executor.vfs.exists('/etc')).toBe(true);
  });

  it('reports the failsafe through cat afterwards (no wipe happened)', async () => {
    const pc: any = new LinuxPC('pc1', 'PC1', 0, 0);
    await pc.executeCommand('rm -rf /');
    const passwd = await pc.executeCommand('cat /etc/passwd');
    expect(passwd).toContain('root:');
  });

  it('still removes a normal directory recursively', async () => {
    const pc: any = new LinuxPC('pc1', 'PC1', 0, 0);
    await pc.executeCommand('mkdir -p /tmp/d/sub');
    await pc.executeCommand('rm -rf /tmp/d');
    expect(pc.executor.vfs.exists('/tmp/d')).toBe(false);
  });

  it('honours --no-preserve-root override (as root)', async () => {
    const pc: any = new LinuxPC('pc1', 'PC1', 0, 0);
    const out = await pc.executeCommand('sudo rm -rf --no-preserve-root /');
    expect(out).not.toContain('dangerous');
    expect(pc.executor.vfs.exists('/etc/passwd')).toBe(false);
  });

  it('does not misparse --force as enabling recursion on /', async () => {
    const pc: any = new LinuxPC('pc1', 'PC1', 0, 0);
    const out = await pc.executeCommand('rm --force /');
    expect(out).toContain("cannot remove '/': Is a directory");
    expect(pc.executor.vfs.exists('/etc')).toBe(true);
  });

  it('denies an unprivileged user removing a root-owned file in /etc', async () => {
    const pc: any = new LinuxPC('pc1', 'PC1', 0, 0);
    expect((await pc.executeCommand('whoami')).trim()).toBe('user');
    const out = await pc.executeCommand('rm /etc/passwd');
    expect(out).toContain('Permission denied');
    expect(pc.executor.vfs.exists('/etc/passwd')).toBe(true);
    const forced = await pc.executeCommand('rm -f /etc/passwd');
    expect(forced).toContain('Permission denied');
    expect(pc.executor.vfs.exists('/etc/passwd')).toBe(true);
  });

  it('lets root remove a root-owned file', async () => {
    const pc: any = new LinuxPC('pc1', 'PC1', 0, 0);
    await pc.executeCommand('sudo rm /etc/passwd');
    expect(pc.executor.vfs.exists('/etc/passwd')).toBe(false);
  });

  it('lets the owner remove their own file in their home', async () => {
    const pc: any = new LinuxPC('pc1', 'PC1', 0, 0);
    await pc.executeCommand('touch /home/user/mine.txt');
    const out = await pc.executeCommand('rm /home/user/mine.txt');
    expect(out).toBe('');
    expect(pc.executor.vfs.exists('/home/user/mine.txt')).toBe(false);
  });

  it('enforces the sticky bit in /tmp (cannot remove another user file)', async () => {
    const pc: any = new LinuxPC('pc1', 'PC1', 0, 0);
    pc.executor.vfs.writeFile('/tmp/rootfile', 'x', 0, 0, 0o022);
    const out = await pc.executeCommand('rm /tmp/rootfile');
    expect(out).toContain('Operation not permitted');
    expect(pc.executor.vfs.exists('/tmp/rootfile')).toBe(true);
  });
});
