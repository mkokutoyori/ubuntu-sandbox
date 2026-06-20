import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

describe('chmod/chown/chgrp ownership DAC', () => {
  it('denies an unprivileged user chmod on a root-owned file', async () => {
    const pc: any = new LinuxPC('pc1', 'PC1', 0, 0);
    expect((await pc.executeCommand('whoami')).trim()).toBe('user');
    const out = await pc.executeCommand('chmod 777 /etc/passwd');
    expect(out).toContain('Operation not permitted');
    expect(pc.executor.vfs.resolveInode('/etc/passwd').permissions & 0o777).toBe(0o644);
  });

  it('lets the owner chmod their own file', async () => {
    const pc: any = new LinuxPC('pc1', 'PC1', 0, 0);
    await pc.executeCommand('touch /home/user/mine.txt');
    const out = await pc.executeCommand('chmod 600 /home/user/mine.txt');
    expect(out).toBe('');
    expect(pc.executor.vfs.resolveInode('/home/user/mine.txt').permissions & 0o777).toBe(0o600);
  });

  it('denies a non-root user changing ownership to root', async () => {
    const pc: any = new LinuxPC('pc1', 'PC1', 0, 0);
    await pc.executeCommand('touch /home/user/mine.txt');
    const out = await pc.executeCommand('chown root /home/user/mine.txt');
    expect(out).toContain('Operation not permitted');
    expect(pc.executor.vfs.resolveInode('/home/user/mine.txt').uid).toBe(1000);
  });

  it('lets root chown freely', async () => {
    const pc: any = new LinuxPC('pc1', 'PC1', 0, 0);
    await pc.executeCommand('touch /home/user/mine.txt');
    await pc.executeCommand('sudo chown root:root /home/user/mine.txt');
    expect(pc.executor.vfs.resolveInode('/home/user/mine.txt').uid).toBe(0);
  });

  it('denies chgrp to a group the owner does not belong to', async () => {
    const pc: any = new LinuxPC('pc1', 'PC1', 0, 0);
    await pc.executeCommand('touch /home/user/mine.txt');
    const out = await pc.executeCommand('chgrp root /home/user/mine.txt');
    expect(out).toContain('Operation not permitted');
  });
});
