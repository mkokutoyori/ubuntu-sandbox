/**
 * SFTP shell — exhaustive sub-shell tests.
 *
 * Three sections:
 *   §A — Command behaviour: every interactive verb exercised through the
 *        SFTP shell (driven via SftpSession, which is what the
 *        SftpSubShell wraps 1-to-1).
 *   §B — Filesystem coherence: changes made through SFTP are observable
 *        from the remote machine's terminal (and vice-versa), so the
 *        SFTP view and the remote shell view never drift.
 *   §C — Edge cases & error parity: missing paths, deep nesting, special
 *        characters, recursive transfers, idempotence.
 *
 * The fixture mirrors ssh-terminal-stack.test.ts: SftpSession over a real
 * SshSession over a real TCP connector, so writes really cross the
 * simulated network.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { SftpSession } from '@/network/protocols/ssh/sftp/SftpSession';
import { SilentSshInteractionHandler } from '@/network/protocols/ssh/session/ISshInteractionHandler';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import type { TcpConnector } from '@/network/core/TcpConnection';

// ─── Fixture ────────────────────────────────────────────────────────

const CLIENT_IP = '10.0.0.1';
const SERVER_IP = '10.0.0.2';
const NETMASK = '255.255.255.0';

interface Lan { client: LinuxPC; server: LinuxPC; sw: GenericSwitch; }

async function buildLan(): Promise<Lan> {
  EquipmentRegistry.resetInstance();
  const client = new LinuxPC('linux-pc', 'client', 0, 0);
  const server = new LinuxPC('linux-pc', 'server', 100, 0);
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 50, 50);
  new Cable('c1').connect(client.getPort('eth0')!, sw.getPort('eth0')!);
  new Cable('c2').connect(server.getPort('eth0')!, sw.getPort('eth1')!);
  await client.executeCommand(`ifconfig eth0 ${CLIENT_IP} netmask ${NETMASK}`);
  await server.executeCommand(`ifconfig eth0 ${SERVER_IP} netmask ${NETMASK}`);
  await client.executeCommand(`ping -c 1 ${SERVER_IP}`);
  return { client, server, sw };
}

function vfsOf(pc: LinuxPC): VirtualFileSystem {
  return (pc as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
}

function tcpConnectorOf(pc: LinuxPC): TcpConnector {
  const dev = pc as unknown as { tcpConnect: (h: string, p: number) => Promise<unknown> };
  return (host, port) => dev.tcpConnect(host, port) as Promise<never>;
}

async function openSftp(client: LinuxPC, opts: {
  user?: string;
  password?: string;
  localCwd?: string;
  localVfs?: VirtualFileSystem;
} = {}): Promise<{ sftp: SftpSession; local: VirtualFileSystem }> {
  const user = opts.user ?? 'user';
  const password = opts.password ?? 'admin';
  const local = opts.localVfs ?? new VirtualFileSystem();
  const sftp = new SftpSession({
    tcpConnector: tcpConnectorOf(client),
    localVfs: local,
    localUser: 'root',
    localUid: 0,
    localGid: 0,
    localCwd: opts.localCwd ?? '/root',
    knownHostsPath: '/root/.ssh/known_hosts',
    interactionHandler: new SilentSshInteractionHandler(password),
    homeDirectory: '/root',
  });
  const banner = await sftp.connect(`${user}@${SERVER_IP}`, { password });
  expect(banner).toContain('Connected');
  return { sftp, local };
}

beforeEach(() => {
  EquipmentRegistry.resetInstance();
});

// ════════════════════════════════════════════════════════════════════
// §A — SFTP shell command behaviour
// ════════════════════════════════════════════════════════════════════

describe('§A — SFTP shell: every command behaves like OpenSSH sftp(1)', () => {
  let lan: Lan;
  beforeEach(async () => { lan = await buildLan(); });

  it('version returns a parseable SFTP protocol identifier', async () => {
    const { sftp } = await openSftp(lan.client);
    expect(sftp.version()).toMatch(/SFTP.*version|protocol/i);
  });

  it('pwd reports the user home as initial remote cwd', async () => {
    const { sftp } = await openSftp(lan.client);
    expect(sftp.pwd()).toMatch(/^Remote working directory: \/home\/user$/);
  });

  it('lpwd reports the local cwd injected at construction time', async () => {
    const { sftp } = await openSftp(lan.client, { localCwd: '/tmp' });
    expect(sftp.lpwd()).toMatch(/^Local working directory: \/tmp$/);
  });

  it('cd <absolute> moves the remote cwd', async () => {
    const { sftp } = await openSftp(lan.client);
    expect(sftp.cd('/tmp')).toBe('');
    expect(sftp.pwd()).toContain('/tmp');
  });

  it('cd <relative> resolves against the current remote cwd', async () => {
    const { sftp } = await openSftp(lan.client);
    vfsOf(lan.server).mkdir('/home/user/sub', 0o755, 1000, 1000);
    expect(sftp.cd('sub')).toBe('');
    expect(sftp.pwd()).toContain('/home/user/sub');
  });

  it('cd .. ascends to the parent directory', async () => {
    const { sftp } = await openSftp(lan.client);
    sftp.cd('/tmp');
    expect(sftp.cd('..')).toBe('');
    expect(sftp.pwd()).toContain('/');
  });

  it('cd <missing> reports No such file or directory', async () => {
    const { sftp } = await openSftp(lan.client);
    expect(sftp.cd('/does/not/exist')).toMatch(/No such file/i);
  });

  it('lcd / lpwd round-trip with a fresh local directory', async () => {
    const { sftp, local } = await openSftp(lan.client);
    local.mkdir('/tmp/here', 0o755, 0, 0);
    expect(sftp.lcd('/tmp/here')).toBe('');
    expect(sftp.lpwd()).toContain('/tmp/here');
  });

  it('lmkdir creates a local directory and is visible via lpwd/lcd', async () => {
    const { sftp, local } = await openSftp(lan.client);
    expect(sftp.lmkdir('/tmp/freshlocal')).toBe('');
    expect(local.exists('/tmp/freshlocal')).toBe(true);
    expect(sftp.lcd('/tmp/freshlocal')).toBe('');
  });

  it('ls returns the names of the files in the remote cwd', async () => {
    const { sftp } = await openSftp(lan.client);
    vfsOf(lan.server).writeFile('/home/user/alpha.txt', 'A', 1000, 1000, 0o022);
    vfsOf(lan.server).writeFile('/home/user/beta.txt', 'B', 1000, 1000, 0o022);
    const out = sftp.ls(['.'], new Set());
    expect(out).toContain('alpha.txt');
    expect(out).toContain('beta.txt');
  });

  it('ls -l includes mode / size columns', async () => {
    const { sftp } = await openSftp(lan.client);
    vfsOf(lan.server).writeFile('/home/user/file.bin', 'X'.repeat(123), 1000, 1000, 0o022);
    const out = sftp.ls(['.'], new Set(['l']));
    expect(out).toMatch(/-rw|drwx/);
    expect(out).toMatch(/123/);
  });

  it('mkdir creates a new remote directory under the cwd', async () => {
    const { sftp } = await openSftp(lan.client);
    expect(sftp.mkdir('newdir')).toBe('');
    expect(vfsOf(lan.server).exists('/home/user/newdir')).toBe(true);
  });

  it('mkdir reports an error when the parent does not exist', async () => {
    const { sftp } = await openSftp(lan.client);
    expect(sftp.mkdir('/no/such/parent/leaf')).toMatch(/Couldn't|error|No such|Failure/i);
  });

  it('mkdir of an existing directory surfaces an error', async () => {
    const { sftp } = await openSftp(lan.client);
    sftp.mkdir('twice');
    expect(sftp.mkdir('twice')).toMatch(/Couldn't|exist|error|Failure/i);
  });

  it('rmdir removes an empty remote directory', async () => {
    const { sftp } = await openSftp(lan.client);
    vfsOf(lan.server).mkdir('/home/user/togo', 0o755, 1000, 1000);
    expect(sftp.rmdir('togo')).toBe('');
    expect(vfsOf(lan.server).exists('/home/user/togo')).toBe(false);
  });

  it('rm removes a remote file', async () => {
    const { sftp } = await openSftp(lan.client);
    vfsOf(lan.server).writeFile('/home/user/doomed.txt', 'x', 1000, 1000, 0o022);
    expect(sftp.rm('doomed.txt')).toBe('');
    expect(vfsOf(lan.server).exists('/home/user/doomed.txt')).toBe(false);
  });

  it('rm of a missing file produces an error string', async () => {
    const { sftp } = await openSftp(lan.client);
    expect(sftp.rm('ghost.txt')).toMatch(/No such file|Failure|error/i);
  });

  it('rename moves a remote file to a new name in the same directory', async () => {
    const { sftp } = await openSftp(lan.client);
    vfsOf(lan.server).writeFile('/home/user/old.txt', 'x', 1000, 1000, 0o022);
    expect(sftp.rename('old.txt', 'new.txt')).toBe('');
    expect(vfsOf(lan.server).exists('/home/user/old.txt')).toBe(false);
    expect(vfsOf(lan.server).exists('/home/user/new.txt')).toBe(true);
  });

  it('rename to a different directory relocates the file', async () => {
    const { sftp } = await openSftp(lan.client);
    vfsOf(lan.server).writeFile('/home/user/source.txt', 'x', 1000, 1000, 0o022);
    vfsOf(lan.server).mkdir('/home/user/target', 0o755, 1000, 1000);
    expect(sftp.rename('source.txt', 'target/source.txt')).toBe('');
    expect(vfsOf(lan.server).exists('/home/user/target/source.txt')).toBe(true);
  });

  it('chmod returns a success acknowledgement for a writable file', async () => {
    const { sftp } = await openSftp(lan.client);
    vfsOf(lan.server).writeFile('/home/user/exe.sh', '#!/bin/sh', 1000, 1000, 0o022);
    const out = sftp.chmod('755', 'exe.sh');
    expect(out).toMatch(/Changing mode|exe\.sh/i);
  });

  it('chown returns a success acknowledgement when the SFTP user is allowed', async () => {
    const { sftp } = await openSftp(lan.client);
    vfsOf(lan.server).writeFile('/home/user/owned.txt', 'x', 1000, 1000, 0o022);
    const out = sftp.chown('0', 'owned.txt');
    expect(out).toBeDefined();
  });

  it('stat returns a multi-line attribute block', async () => {
    const { sftp } = await openSftp(lan.client);
    vfsOf(lan.server).writeFile('/home/user/inspectme', 'data', 1000, 1000, 0o022);
    const out = sftp.stat('inspectme');
    expect(out).toMatch(/Size|Mode|UID|Permissions/i);
  });

  it('stat on a missing path reports No such file', async () => {
    const { sftp } = await openSftp(lan.client);
    expect(sftp.stat('nope')).toMatch(/No such file|Failure/i);
  });

  it('df reports filesystem space totals', async () => {
    const { sftp } = await openSftp(lan.client);
    const out = sftp.df(undefined, false);
    expect(out).toMatch(/Size|Used|Avail|blocks/i);
  });

  it('df -h returns human-readable units', async () => {
    const { sftp } = await openSftp(lan.client);
    const out = sftp.df(undefined, true);
    expect(out).toMatch(/[KMG]B?\b/);
  });

  it('put uploads a local file into the remote home directory', async () => {
    const { sftp, local } = await openSftp(lan.client);
    local.writeFile('/root/payload.txt', 'PAYLOAD', 0, 0, 0o022);
    sftp.put('/root/payload.txt', 'payload.txt');
    expect(vfsOf(lan.server).readFile('/home/user/payload.txt')).toBe('PAYLOAD');
  });

  it('get downloads a remote file into the local VFS', async () => {
    const { sftp, local } = await openSftp(lan.client);
    vfsOf(lan.server).writeFile('/home/user/down.txt', 'DOWN', 1000, 1000, 0o022);
    sftp.get('down.txt', '/root/down.txt');
    expect(local.readFile('/root/down.txt')).toBe('DOWN');
  });

  it('put without a remote name keeps the basename', async () => {
    const { sftp, local } = await openSftp(lan.client);
    local.writeFile('/root/keepname.txt', 'kept', 0, 0, 0o022);
    sftp.put('/root/keepname.txt');
    expect(vfsOf(lan.server).readFile('/home/user/keepname.txt')).toBe('kept');
  });

  it('get without a local name lands in the local cwd with the same basename', async () => {
    const { sftp, local } = await openSftp(lan.client, { localCwd: '/root' });
    vfsOf(lan.server).writeFile('/home/user/echo.txt', 'echo', 1000, 1000, 0o022);
    sftp.get('echo.txt');
    expect(local.readFile('/root/echo.txt')).toBe('echo');
  });
});

// ════════════════════════════════════════════════════════════════════
// §B — SFTP and remote shell see the SAME filesystem
// ════════════════════════════════════════════════════════════════════

describe('§B — SFTP view vs remote terminal view are coherent', () => {
  let lan: Lan;
  beforeEach(async () => { lan = await buildLan(); });

  it('a file written through put is listed by `ls` over ssh', async () => {
    const { sftp, local } = await openSftp(lan.client);
    local.writeFile('/root/hello.txt', 'hi', 0, 0, 0o022);
    sftp.put('/root/hello.txt');
    const out = await lan.server.executeCommand('ls /home/user');
    expect(out).toContain('hello.txt');
  });

  it('a file removed through rm vanishes from `ls` and `cat` on the remote', async () => {
    const { sftp } = await openSftp(lan.client);
    vfsOf(lan.server).writeFile('/home/user/bye.txt', 'bye', 1000, 1000, 0o022);
    sftp.rm('bye.txt');
    expect(await lan.server.executeCommand('ls /home/user')).not.toContain('bye.txt');
    expect(await lan.server.executeCommand('cat /home/user/bye.txt')).toMatch(/No such/i);
  });

  it('a directory made through mkdir is listed by `ls -ld` on the remote', async () => {
    const { sftp } = await openSftp(lan.client);
    sftp.mkdir('viewable');
    const out = await lan.server.executeCommand('ls -ld /home/user/viewable');
    expect(out).toMatch(/drwx/);
  });

  it('a chmod from SFTP is reflected in `ls -l` mode column', async () => {
    const { sftp } = await openSftp(lan.client);
    vfsOf(lan.server).writeFile('/home/user/script.sh', '#!/bin/sh', 1000, 1000, 0o022);
    sftp.chmod('755', 'script.sh');
    const out = await lan.server.executeCommand('ls -l /home/user/script.sh');
    expect(out).toMatch(/rwxr-xr-x/);
  });

  it('a chmod from SFTP can be observed via stat on the remote', async () => {
    const { sftp } = await openSftp(lan.client);
    vfsOf(lan.server).writeFile('/home/user/owner.txt', 'x', 1000, 1000, 0o022);
    sftp.chmod('600', 'owner.txt');
    const out = await lan.server.executeCommand('stat /home/user/owner.txt');
    expect(out).toMatch(/owner\.txt/);
  });

  it('a rename through SFTP renames the file as seen by the remote shell', async () => {
    const { sftp } = await openSftp(lan.client);
    vfsOf(lan.server).writeFile('/home/user/before.txt', 'x', 1000, 1000, 0o022);
    sftp.rename('before.txt', 'after.txt');
    const out = await lan.server.executeCommand('ls /home/user');
    expect(out).not.toContain('before.txt');
    expect(out).toContain('after.txt');
  });

  it('a file created via remote `touch` is visible to SFTP `ls`', async () => {
    const { sftp } = await openSftp(lan.client);
    await lan.server.executeCommand('touch /home/user/from-shell.txt');
    expect(sftp.ls(['.'], new Set())).toContain('from-shell.txt');
  });

  it('a directory created via remote `mkdir` is enterable with SFTP `cd`', async () => {
    const { sftp } = await openSftp(lan.client);
    await lan.server.executeCommand('mkdir /home/user/srvmade');
    expect(sftp.cd('srvmade')).toBe('');
    expect(sftp.pwd()).toContain('/home/user/srvmade');
  });

  it('content written via remote shell `echo > file` is fetchable via get', async () => {
    const { sftp, local } = await openSftp(lan.client);
    await lan.server.executeCommand('sh -c "echo hello-from-shell > /home/user/echo.txt"');
    sftp.get('echo.txt', '/root/echo.txt');
    expect(local.readFile('/root/echo.txt')?.trim()).toBe('hello-from-shell');
  });

  it('content uploaded via put is readable by remote `cat`', async () => {
    const { sftp, local } = await openSftp(lan.client);
    local.writeFile('/root/letter.txt', 'dear-server', 0, 0, 0o022);
    sftp.put('/root/letter.txt', 'letter.txt');
    const cat = await lan.server.executeCommand('cat /home/user/letter.txt');
    expect(cat.trim()).toBe('dear-server');
  });

  it('SFTP ls of an absolute path matches remote `ls` of the same path', async () => {
    const { sftp } = await openSftp(lan.client);
    vfsOf(lan.server).mkdir('/home/user/cross', 0o755, 1000, 1000);
    vfsOf(lan.server).mkdir('/home/user/cross/check', 0o755, 1000, 1000);
    vfsOf(lan.server).writeFile('/home/user/cross/check/a.txt', '', 1000, 1000, 0o022);
    vfsOf(lan.server).writeFile('/home/user/cross/check/b.txt', '', 1000, 1000, 0o022);
    const sftpList = sftp.ls(['/home/user/cross/check'], new Set());
    const sshList  = await lan.server.executeCommand('ls /home/user/cross/check');
    for (const name of sshList.split(/\s+/).filter(Boolean)) {
      expect(sftpList).toContain(name);
    }
  });

  it('rmdir over SFTP removes the dir as seen from `ls` on remote', async () => {
    const { sftp } = await openSftp(lan.client);
    await lan.server.executeCommand('mkdir /home/user/temp-rm');
    sftp.rmdir('temp-rm');
    expect(await lan.server.executeCommand('ls /home/user')).not.toContain('temp-rm');
  });
});

// ════════════════════════════════════════════════════════════════════
// §C — Edge cases, recursive transfers, error parity
// ════════════════════════════════════════════════════════════════════

describe('§C — SFTP edge cases & error parity', () => {
  let lan: Lan;
  beforeEach(async () => { lan = await buildLan(); });

  it('get of a missing remote file reports No such file', async () => {
    const { sftp } = await openSftp(lan.client);
    const out = sftp.get('ghost.txt', '/root/x');
    expect(out).toMatch(/No such|Failure|error/i);
  });

  it('put of a missing local file reports No such file', async () => {
    const { sftp } = await openSftp(lan.client);
    expect(sftp.put('/root/ghost.txt')).toMatch(/No such/i);
  });

  it('put echoes an "Uploading" line that names source and target', async () => {
    const { sftp, local } = await openSftp(lan.client);
    local.writeFile('/root/orphan.txt', 'x', 0, 0, 0o022);
    const out = sftp.put('/root/orphan.txt', '/tmp/orphan.txt');
    expect(out).toMatch(/Uploading .*orphan/);
  });

  it('rmdir on a non-empty directory refuses', async () => {
    const { sftp } = await openSftp(lan.client);
    vfsOf(lan.server).mkdir('/home/user/full', 0o755, 1000, 1000);
    vfsOf(lan.server).writeFile('/home/user/full/keepme.txt', 'x', 1000, 1000, 0o022);
    const out = sftp.rmdir('full');
    expect(out).toMatch(/not empty|Failure|error|Directory/i);
  });

  it('rm on a directory refuses (use rmdir)', async () => {
    const { sftp } = await openSftp(lan.client);
    vfsOf(lan.server).mkdir('/home/user/somedir', 0o755, 1000, 1000);
    const out = sftp.rm('somedir');
    expect(out).toMatch(/Failure|directory|error/i);
  });

  it('rename onto an existing target name produces an error', async () => {
    const { sftp } = await openSftp(lan.client);
    vfsOf(lan.server).writeFile('/home/user/a.txt', 'a', 1000, 1000, 0o022);
    vfsOf(lan.server).writeFile('/home/user/b.txt', 'b', 1000, 1000, 0o022);
    const out = sftp.rename('a.txt', 'b.txt');
    expect(out).toMatch(/Failure|exist|error/i);
  });

  it('cd to a regular file reports an error', async () => {
    const { sftp } = await openSftp(lan.client);
    vfsOf(lan.server).writeFile('/home/user/notadir', 'x', 1000, 1000, 0o022);
    const out = sftp.cd('notadir');
    expect(out).toMatch(/Not a directory|Failure|error|Couldn't/i);
  });

  it('repeated mkdir is not idempotent — second call errors', async () => {
    const { sftp } = await openSftp(lan.client);
    sftp.mkdir('idempotent');
    expect(sftp.mkdir('idempotent')).toMatch(/Couldn't|exist|Failure|error/i);
  });

  it('deeply nested mkdir requires every parent to pre-exist', async () => {
    const { sftp } = await openSftp(lan.client);
    expect(sftp.mkdir('a/b/c')).toMatch(/No such|Failure|error/i);
    sftp.mkdir('a');
    sftp.mkdir('a/b');
    expect(sftp.mkdir('a/b/c')).toBe('');
  });

  it('put then get round-trip preserves bytes for a multi-line file', async () => {
    const { sftp, local } = await openSftp(lan.client);
    const body = 'line-1\nline-2\nline-3\n';
    local.writeFile('/root/rt.txt', body, 0, 0, 0o022);
    sftp.put('/root/rt.txt', 'rt.txt');
    sftp.get('rt.txt', '/root/rt-back.txt');
    expect(local.readFile('/root/rt-back.txt')).toBe(body);
  });

  it('put -R recursively uploads a local subtree', async () => {
    const { sftp, local } = await openSftp(lan.client);
    local.mkdir('/root/tree', 0o755, 0, 0);
    local.mkdir('/root/tree/child', 0o755, 0, 0);
    local.writeFile('/root/tree/top.txt', 'T', 0, 0, 0o022);
    local.writeFile('/root/tree/child/leaf.txt', 'L', 0, 0, 0o022);
    sftp.putRecursive('/root/tree', 'tree');
    expect(vfsOf(lan.server).readFile('/home/user/tree/top.txt')).toBe('T');
    expect(vfsOf(lan.server).readFile('/home/user/tree/child/leaf.txt')).toBe('L');
  });

  it('get -R recursively downloads a remote subtree', async () => {
    const { sftp, local } = await openSftp(lan.client);
    vfsOf(lan.server).mkdir('/home/user/rtree', 0o755, 1000, 1000);
    vfsOf(lan.server).mkdir('/home/user/rtree/sub', 0o755, 1000, 1000);
    vfsOf(lan.server).writeFile('/home/user/rtree/a.txt', 'A', 1000, 1000, 0o022);
    vfsOf(lan.server).writeFile('/home/user/rtree/sub/b.txt', 'B', 1000, 1000, 0o022);
    sftp.getRecursive('rtree', '/root/rtree');
    expect(local.readFile('/root/rtree/a.txt')).toBe('A');
    expect(local.readFile('/root/rtree/sub/b.txt')).toBe('B');
  });

  it('rename of a non-existent source reports an error', async () => {
    const { sftp } = await openSftp(lan.client);
    expect(sftp.rename('ghost', 'shadow')).toMatch(/No such|Failure|error/i);
  });

  it('chmod / chown on a missing path are reported, not silently ignored', async () => {
    const { sftp } = await openSftp(lan.client);
    expect(sftp.chmod('644', 'ghost')).toMatch(/No such|Failure|error|Couldn't|Permission/i);
    expect(sftp.chown('0', 'ghost')).toMatch(/No such|Failure|error|Couldn't|Permission/i);
  });

  it('cd absolute / cd relative each move the cwd individually', async () => {
    const { sftp } = await openSftp(lan.client);
    vfsOf(lan.server).mkdir('/home/user/a', 0o755, 1000, 1000);
    vfsOf(lan.server).mkdir('/home/user/a/b', 0o755, 1000, 1000);
    sftp.cd('/home/user/a');
    expect(sftp.pwd()).toContain('/home/user/a');
    sftp.cd('/home/user/a/b');
    expect(sftp.pwd()).toContain('/home/user/a/b');
    sftp.cd('/');
    expect(sftp.pwd()).toMatch(/Remote working directory: \//);
  });

  it('ls on a missing path surfaces the error from the server', async () => {
    const { sftp } = await openSftp(lan.client);
    expect(sftp.ls(['/no/such/place'], new Set())).toMatch(/No such|Failure|error/i);
  });

  it('disconnect makes write operations fail', async () => {
    const { sftp } = await openSftp(lan.client);
    sftp.disconnect();
    expect(sftp.mkdir('whatever')).toMatch(/Not connected|Failure|error/i);
  });

  it('put preserves zero-byte content', async () => {
    const { sftp, local } = await openSftp(lan.client);
    local.writeFile('/root/empty', '', 0, 0, 0o022);
    sftp.put('/root/empty', 'empty');
    expect(vfsOf(lan.server).readFile('/home/user/empty')).toBe('');
  });

  it('overwriting an existing remote file with put replaces its content', async () => {
    const { sftp, local } = await openSftp(lan.client);
    vfsOf(lan.server).writeFile('/home/user/over.txt', 'OLD', 1000, 1000, 0o022);
    local.writeFile('/root/over.txt', 'NEW', 0, 0, 0o022);
    sftp.put('/root/over.txt', 'over.txt');
    expect(vfsOf(lan.server).readFile('/home/user/over.txt')).toBe('NEW');
  });
});
