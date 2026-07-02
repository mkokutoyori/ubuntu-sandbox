import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

async function pc() {
  const p: any = new LinuxPC('pc1', 'PC1', 0, 0);
  expect((await p.executeCommand('whoami')).trim()).toBe('user');
  return p;
}

describe('directory-mutation DAC (mkdir/rmdir/cp/mv/ln)', () => {
  it('denies mkdir in a non-writable system directory', async () => {
    const p = await pc();
    const out = await p.executeCommand('mkdir /etc/evil');
    expect(out).toContain('Permission denied');
    expect(p.executor.vfs.exists('/etc/evil')).toBe(false);
  });

  it('allows mkdir in the user home', async () => {
    const p = await pc();
    const out = await p.executeCommand('mkdir /home/user/d');
    expect(out).toBe('');
    expect(p.executor.vfs.getType('/home/user/d')).toBe('directory');
  });

  it('denies cp creating a file in /etc', async () => {
    const p = await pc();
    await p.executeCommand('echo hi > /home/user/f.txt');
    const out = await p.executeCommand('cp /home/user/f.txt /etc/f.txt');
    expect(out).toContain('Permission denied');
    expect(p.executor.vfs.exists('/etc/f.txt')).toBe(false);
  });

  it('allows cp within the user home', async () => {
    const p = await pc();
    await p.executeCommand('echo hi > /home/user/f.txt');
    const out = await p.executeCommand('cp /home/user/f.txt /home/user/g.txt');
    expect(out).toBe('');
    expect(p.executor.vfs.exists('/home/user/g.txt')).toBe(true);
  });

  it('denies mv into /etc', async () => {
    const p = await pc();
    await p.executeCommand('echo hi > /home/user/f.txt');
    const out = await p.executeCommand('mv /home/user/f.txt /etc/f.txt');
    expect(out).toContain('Permission denied');
    expect(p.executor.vfs.exists('/home/user/f.txt')).toBe(true);
  });

  it('denies mv of a root-owned file out of /etc', async () => {
    const p = await pc();
    const out = await p.executeCommand('mv /etc/passwd /home/user/p');
    expect(out).toContain('Permission denied');
    expect(p.executor.vfs.exists('/etc/passwd')).toBe(true);
  });

  it('denies rmdir of a system directory', async () => {
    const p = await pc();
    await p.executeCommand('sudo mkdir /etc/d2');
    const out = await p.executeCommand('rmdir /etc/d2');
    expect(out).toContain('Permission denied');
    expect(p.executor.vfs.exists('/etc/d2')).toBe(true);
  });

  it('denies ln in a system directory', async () => {
    const p = await pc();
    const out = await p.executeCommand('ln -s /home/user/f.txt /etc/link');
    expect(out).toContain('Permission denied');
  });

  it('still lets root mutate system directories', async () => {
    const p = await pc();
    expect((await p.executeCommand('sudo mkdir /etc/rootdir')).trim()).toBe('');
    expect(p.executor.vfs.getType('/etc/rootdir')).toBe('directory');
  });
});
