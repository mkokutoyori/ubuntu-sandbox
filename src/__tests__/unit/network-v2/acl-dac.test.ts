import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

async function pc() {
  const p: any = new LinuxPC('pc1', 'PC1', 0, 0);
  return p;
}

describe('ACL-aware shell DAC (VfsPath honours setfacl)', () => {
  it('a user ACL grants cat read on a 600 file owned by root', async () => {
    const p = await pc();
    await p.executeCommand('sudo sh -c "echo top-secret > /root/doc && chmod 600 /root/doc && chmod 711 /root"');
    expect((await p.executeCommand('cat /root/doc')).toLowerCase()).toContain('permission denied');
    await p.executeCommand('sudo setfacl -m u:user:r /root/doc');
    expect(await p.executeCommand('cat /root/doc')).toContain('top-secret');
  });

  it('a group ACL grants read via supplementary membership', async () => {
    const p = await pc();
    await p.executeCommand('sudo groupadd team');
    await p.executeCommand('sudo usermod -aG team user');
    await p.executeCommand('sudo sh -c "echo g-data > /root/gdoc && chmod 600 /root/gdoc && chmod 711 /root"');
    expect((await p.executeCommand('cat /root/gdoc')).toLowerCase()).toContain('permission denied');
    await p.executeCommand('sudo setfacl -m g:team:r /root/gdoc');
    expect(await p.executeCommand('cat /root/gdoc')).toContain('g-data');
  });

  it('removing the ACL (setfacl -x) restores denial', async () => {
    const p = await pc();
    await p.executeCommand('sudo sh -c "echo x > /root/doc2 && chmod 600 /root/doc2 && chmod 711 /root"');
    await p.executeCommand('sudo setfacl -m u:user:r /root/doc2');
    expect(await p.executeCommand('cat /root/doc2')).toContain('x');
    await p.executeCommand('sudo setfacl -x u:user /root/doc2');
    expect((await p.executeCommand('cat /root/doc2')).toLowerCase()).toContain('permission denied');
  });

  it('a directory ACL grants write so the user can mkdir inside it', async () => {
    const p = await pc();
    await p.executeCommand('sudo sh -c "mkdir -p /root/shared && chmod 700 /root/shared && chmod 711 /root"');
    expect((await p.executeCommand('mkdir /root/shared/sub')).toLowerCase()).toContain('permission denied');
    await p.executeCommand('sudo setfacl -m u:user:rwx /root/shared');
    const out = await p.executeCommand('mkdir /root/shared/sub');
    expect(out).toBe('');
    expect(p.executor.vfs.getType('/root/shared/sub')).toBe('directory');
  });
});
