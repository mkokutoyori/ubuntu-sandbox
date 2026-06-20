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

  it('honours --no-preserve-root override', async () => {
    const pc: any = new LinuxPC('pc1', 'PC1', 0, 0);
    const out = await pc.executeCommand('rm -rf --no-preserve-root /');
    expect(out).not.toContain('dangerous');
    expect(pc.executor.vfs.exists('/etc/passwd')).toBe(false);
  });

  it('does not misparse --force as enabling recursion on /', async () => {
    const pc: any = new LinuxPC('pc1', 'PC1', 0, 0);
    const out = await pc.executeCommand('rm --force /');
    expect(out).toContain("cannot remove '/': Is a directory");
    expect(pc.executor.vfs.exists('/etc')).toBe(true);
  });
});
