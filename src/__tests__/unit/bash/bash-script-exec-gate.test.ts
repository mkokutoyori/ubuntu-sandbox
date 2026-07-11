import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxCommandExecutor } from '@/network/devices/linux/LinuxCommandExecutor';

let exec: LinuxCommandExecutor;
beforeEach(() => {
  exec = new LinuxCommandExecutor(false);
  exec.userMgr.currentUser = 'root';
  exec.userMgr.currentUid = 0;
  exec.userMgr.currentGid = 0;
});
async function run(cmd: string): Promise<string> { return await exec.execute(cmd); }

function writeScript(path: string, body: string, permissions: number): void {
  exec.vfs.writeFile(path, body, 0, 0, 0o022);
  const inode = exec.vfs.resolveInode(path);
  if (inode) inode.permissions = permissions;
}

describe('interpreter invocation does not require the execute bit', () => {
  it('bash script.sh runs a readable non-executable script', async () => {
    writeScript('/tmp/s.sh', 'echo ran-via-bash', 0o644);
    expect(await run('bash /tmp/s.sh')).toContain('ran-via-bash');
  });

  it('sh script.sh runs it too', async () => {
    writeScript('/tmp/s.sh', 'echo ran-via-sh', 0o644);
    expect(await run('sh /tmp/s.sh')).toContain('ran-via-sh');
  });

  it('bash still refuses an unreadable script', async () => {
    writeScript('/tmp/s.sh', 'echo nope', 0o000);
    exec.userMgr.currentUser = 'user';
    exec.userMgr.currentUid = 1000;
    exec.userMgr.currentGid = 1000;
    expect(await run('bash /tmp/s.sh')).toContain('Permission denied');
  });

  it('./script.sh still requires the execute bit', async () => {
    writeScript('/tmp/noexec.sh', 'echo direct', 0o644);
    exec.userMgr.currentUser = 'user';
    exec.userMgr.currentUid = 1000;
    exec.userMgr.currentGid = 1000;
    const out = await run('/tmp/noexec.sh');
    expect(out).toContain('Permission denied');
    expect(out).not.toContain('direct');
  });

  it('./script.sh works once the bit is set', async () => {
    writeScript('/tmp/withx.sh', 'echo direct-ok', 0o755);
    expect(await run('/tmp/withx.sh')).toContain('direct-ok');
  });
});
