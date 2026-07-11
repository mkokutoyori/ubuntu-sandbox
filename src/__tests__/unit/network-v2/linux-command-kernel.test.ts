import { beforeEach, describe, expect, it } from 'vitest';
import { createSession } from '@/command-kernel/session/types';
import { PipeBuffer } from '@/command-kernel/io/pipe-buffer';
import { CommandIO } from '@/command-kernel/io/types';
import { Interpreter } from '@/command-kernel/interpreter';
import { Shell } from '@/command-kernel/shell/shell';
import { VirtualTerminal } from '@/command-kernel/terminal/virtual-terminal';
import { toFileSystemActor } from '@/command-kernel/machine/types';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { LinuxUserManager } from '@/network/devices/linux/LinuxUserManager';
import { LinuxProcessManager } from '@/network/devices/linux/LinuxProcessManager';
import { createLinuxHostShell } from '@/network/devices/linux/command-kernel/createLinuxHostShell';
import { LinuxMachineApi, LinuxMachineApiDeps } from '@/network/devices/linux/command-kernel/LinuxMachineApi';
import { resolveLinuxUser } from '@/network/devices/linux/command-kernel/LinuxUser';

function makeIO(): CommandIO & { out: PipeBuffer; err: PipeBuffer } {
  const out = new PipeBuffer();
  const err = new PipeBuffer();
  return { stdin: new PipeBuffer(), stdout: out, stderr: err, out, err };
}

describe('Linux coreutils on command-kernel (real VFS/IAM/process manager)', () => {
  let vfs: VirtualFileSystem;
  let userManager: LinuxUserManager;
  let processManager: LinuxProcessManager;
  let deps: LinuxMachineApiDeps;
  let interpreter: Interpreter;

  beforeEach(() => {
    vfs = new VirtualFileSystem();
    userManager = new LinuxUserManager(vfs);
    processManager = new LinuxProcessManager();
    userManager.useradd('alice', { m: true, s: '/bin/bash' });
    deps = {
      vfs,
      userManager,
      processManager,
      hostname: 'testhost',
      ports: [],
      getUmask: () => 0o022,
      powerOn: () => {},
      powerOff: () => {},
      publishFsAccess: () => {},
      publishSyscall: () => {},
    };
    interpreter = createLinuxHostShell(deps);
  });

  function sessionFor(username: string, cwd: string) {
    const user = resolveLinuxUser(userManager, username);
    return createSession({ id: `sess-${username}`, user, cwd });
  }

  it('pwd reports the session cwd', async () => {
    const session = sessionFor('root', '/root');
    const io = makeIO();
    await interpreter.interpretLine('pwd', session, io);
    expect(await io.out.readAll()).toBe('/root\n');
  });

  it('cd changes cwd and validates the target is a directory', async () => {
    const session = sessionFor('root', '/root');
    await interpreter.interpretLine('cd /tmp', session, makeIO());
    expect(session.cwd).toBe('/tmp');

    const io = makeIO();
    const code = await interpreter.interpretLine('cd /etc/hostname', session, io);
    expect(code).not.toBe(0);
    expect(await io.err.readAll()).toContain('Not a directory');
  });

  it('writes through a redirection, appends, and reads it back with cat', async () => {
    const session = sessionFor('root', '/root');
    await interpreter.interpretLine('echo one > /tmp/x.txt', session, makeIO());
    await interpreter.interpretLine('echo two >> /tmp/x.txt', session, makeIO());
    const io = makeIO();
    await interpreter.interpretLine('cat /tmp/x.txt', session, io);
    expect(await io.out.readAll()).toBe('one\ntwo\n');
  });

  it('mkdir -p creates the full chain, ls -a lists it including dotfiles', async () => {
    const session = sessionFor('alice', '/home/alice');
    await interpreter.interpretLine('mkdir -p /home/alice/projects/demo', session, makeIO());
    const stat = vfs.resolveInode('/home/alice/projects/demo');
    expect(stat?.type).toBe('directory');

    await interpreter.interpretLine('touch /home/alice/.bashrc', session, makeIO());
    const plain = makeIO();
    await interpreter.interpretLine('ls /home/alice', session, plain);
    expect(await plain.out.readAll()).not.toContain('.bashrc');

    const all = makeIO();
    await interpreter.interpretLine('ls -a /home/alice', session, all);
    expect(await all.out.readAll()).toContain('.bashrc');
  });

  it('ls -l prints a permission string, numeric owner and size', async () => {
    const session = sessionFor('root', '/root');
    await interpreter.interpretLine('echo hi > /root/note.txt', session, makeIO());
    const io = makeIO();
    await interpreter.interpretLine('ls -l /root', session, io);
    const output = await io.out.readAll();
    expect(output).toMatch(/-rw-r--r-- 1 root root\s+3 .+ note\.txt/);
  });

  it('enforces file permissions: alice cannot read root-owned 600 file, can after chmod', async () => {
    const root = sessionFor('root', '/root');
    await interpreter.interpretLine('echo secret > /root/secret.txt', root, makeIO());
    await interpreter.interpretLine('chmod 600 /root/secret.txt', root, makeIO());

    const alice = sessionFor('alice', '/home/alice');
    const denied = makeIO();
    const code = await interpreter.interpretLine('cat /root/secret.txt', alice, denied);
    expect(code).not.toBe(0);
    expect(await denied.err.readAll()).toContain('Permission denied');

    await interpreter.interpretLine('chmod 644 /root/secret.txt', root, makeIO());
    const allowed = makeIO();
    await interpreter.interpretLine('cat /root/secret.txt', alice, allowed);
    expect(await allowed.out.readAll()).toBe('secret\n');
  });

  it('chown requires root and transfers ownership so the new owner can write', async () => {
    const root = sessionFor('root', '/root');
    await interpreter.interpretLine('touch /root/shared.txt', root, makeIO());
    await interpreter.interpretLine('chmod 644 /root/shared.txt', root, makeIO());

    const alice = sessionFor('alice', '/home/alice');
    const deniedChown = makeIO();
    const code = await interpreter.interpretLine('chown alice /root/shared.txt', alice, deniedChown);
    expect(code).not.toBe(0);

    await interpreter.interpretLine('chown alice /root/shared.txt', root, makeIO());
    const aliceUser = resolveLinuxUser(userManager, 'alice');
    expect(vfs.resolveInode('/root/shared.txt')?.uid).toBe(aliceUser.uid);
  });

  it('cp copies content, mv renames, rm removes', async () => {
    const session = sessionFor('root', '/root');
    await interpreter.interpretLine('echo payload > /root/a.txt', session, makeIO());
    await interpreter.interpretLine('cp /root/a.txt /root/b.txt', session, makeIO());
    await interpreter.interpretLine('mv /root/b.txt /root/c.txt', session, makeIO());

    const io = makeIO();
    await interpreter.interpretLine('cat /root/c.txt', session, io);
    expect(await io.out.readAll()).toBe('payload\n');
    expect(vfs.resolveInode('/root/b.txt')).toBeNull();

    await interpreter.interpretLine('rm /root/c.txt', session, makeIO());
    expect(vfs.resolveInode('/root/c.txt')).toBeNull();
  });

  it('rm without -r refuses a directory; rm -r removes it recursively', async () => {
    const session = sessionFor('root', '/root');
    await interpreter.interpretLine('mkdir /root/dir', session, makeIO());
    await interpreter.interpretLine('touch /root/dir/inner.txt', session, makeIO());

    const io = makeIO();
    const code = await interpreter.interpretLine('rm /root/dir', session, io);
    expect(code).not.toBe(0);
    expect(vfs.resolveInode('/root/dir')).not.toBeNull();

    await interpreter.interpretLine('rm -r /root/dir', session, makeIO());
    expect(vfs.resolveInode('/root/dir')).toBeNull();
  });

  it('stat reports size, type and octal mode', async () => {
    const session = sessionFor('root', '/root');
    await interpreter.interpretLine('echo abcd > /root/sized.txt', session, makeIO());
    const io = makeIO();
    await interpreter.interpretLine('stat /root/sized.txt', session, io);
    const output = await io.out.readAll();
    expect(output).toContain('Size: 5');
    expect(output).toContain('\tfile');
  });

  it('supports the shell REPL end-to-end through a VirtualTerminal', async () => {
    const terminal = new VirtualTerminal();
    const session = sessionFor('root', '/root');
    const shell = new Shell(terminal, interpreter, new LinuxMachineApi(deps), session);
    terminal.feed('mkdir /root/via-shell', 'cd /root/via-shell', 'pwd', 'exit 0');
    const code = await shell.start();
    expect(code).toBe(0);
    expect(terminal.output.join('')).toContain('/root/via-shell\n');
  });

  it('bridges symlink and readlink through LinuxMachineApi.fs', async () => {
    const machine = new LinuxMachineApi(deps);
    const actor = toFileSystemActor(resolveLinuxUser(userManager, 'root'));
    await machine.fs.writeFile('/root/target.txt', 'payload', actor);
    await machine.fs.symlink('/root/target.txt', '/root/link.txt', actor);
    expect(await machine.fs.readlink('/root/link.txt', actor)).toBe('/root/target.txt');
    expect(await machine.fs.readFile('/root/link.txt', actor)).toBe('payload');
  });
});
