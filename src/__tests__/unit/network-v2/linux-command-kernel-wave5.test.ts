import { beforeEach, describe, expect, it } from 'vitest';
import { createSession } from '@/command-kernel/session/types';
import { PipeBuffer } from '@/command-kernel/io/pipe-buffer';
import { CommandIO } from '@/command-kernel/io/types';
import { Interpreter } from '@/command-kernel/interpreter';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { LinuxUserManager } from '@/network/devices/linux/LinuxUserManager';
import { LinuxProcessManager } from '@/network/devices/linux/LinuxProcessManager';
import { LinuxLogManager } from '@/network/devices/linux/LinuxLogManager';
import { LinuxLastlogRegistry } from '@/network/devices/linux/LinuxLastlogRegistry';
import { dfTable, dfTableAll, duWalk } from '@/network/devices/linux/LinuxSystemCommands';
import { createLinuxHostShell } from '@/network/devices/linux/command-kernel/createLinuxHostShell';
import { LinuxMachineApiDeps } from '@/network/devices/linux/command-kernel/LinuxMachineApi';
import { resolveLinuxUser } from '@/network/devices/linux/command-kernel/LinuxUser';

function makeIO(): CommandIO & { out: PipeBuffer; err: PipeBuffer } {
  const out = new PipeBuffer();
  const err = new PipeBuffer();
  return { stdin: new PipeBuffer(), stdout: out, stderr: err, out, err };
}

describe('Linux Wave 5 — arch/nproc/date/hostname/uptime/uname/timedatectl/hostnamectl/chage/faillock/which/whereis/true/false/printf/lastlog/df/du/getent/blkid', () => {
  let vfs: VirtualFileSystem;
  let userManager: LinuxUserManager;
  let processManager: LinuxProcessManager;
  let logManager: LinuxLogManager;
  let lastlogRegistry: LinuxLastlogRegistry;
  let deps: LinuxMachineApiDeps;
  let interpreter: Interpreter;
  let getentCalls: string[][];

  const shellCtx = () => ({
    vfs, userMgr: userManager, cwd: '/', umask: 0o022, uid: 0, gid: 0,
  });

  beforeEach(() => {
    vfs = new VirtualFileSystem();
    userManager = new LinuxUserManager(vfs);
    processManager = new LinuxProcessManager();
    logManager = new LinuxLogManager(vfs);
    lastlogRegistry = new LinuxLastlogRegistry();
    userManager.useradd('alice', { m: true, s: '/bin/bash' });
    getentCalls = [];

    let umask = 0o022;
    deps = {
      vfs,
      userManager,
      processManager,
      logManager,
      hostname: 'testhost',
      ports: [],
      cpuInfo: () => ({ logicalCpus: 4, architecture: 'x86_64', modelName: 'Test CPU' }),
      memoryProfile: () => ({
        totalKib: 1000, usedKib: 100, freeKib: 900, availableKib: 900,
        sharedKib: 0, buffersKib: 0, cacheKib: 0, swapTotalKib: 0, swapUsedKib: 0,
      }),
      diskInfo: () => [],
      netTraffic: () => ({ bytesIn: 0, bytesOut: 0 }),
      uptimeSeconds: () => 3725, // 1h 2m 5s
      osIdentity: () => ({
        name: 'ubuntu', prettyName: 'Ubuntu 22.04.4 LTS', version: '22.04', kernelRelease: '5.15.0-130-generic',
        kernelSysname: 'Linux', kernelBuildVersion: '#140-Ubuntu SMP', machine: 'x86_64', operatingSystem: 'GNU/Linux',
        timezone: 'Etc/UTC', chassis: 'vm', iconName: 'computer-vm', machineId: 'abc123', bootId: 'boot123', virtualization: 'kvm',
      }),
      getUmask: () => umask,
      setUmask: (value) => { umask = value; },
      powerOn: () => {},
      powerOff: () => {},
      publishFsAccess: () => {},
      publishSyscall: () => {},
      lastlog: {
        accounts: () => userManager.getAllUsers().map((u) => ({ username: u.username, uid: u.uid })),
        current: (username) => lastlogRegistry.getCurrent(username),
        clear: (username) => lastlogRegistry.clearUser(username),
        setNow: (username) => lastlogRegistry.record(username, '0.0.0.0', 'pts/0'),
      },
      accountLockout: {
        report: (username) => userManager.getFaillockReport(username),
        reset: (username) => { userManager.resetFaillock(username); },
        userExists: (username) => userManager.getUser(username) !== undefined,
      },
      passwordAging: {
        get: (username) => {
          const u = userManager.getUser(username);
          if (!u) return undefined;
          return {
            maxDays: u.maxDays, minDays: u.minDays, warnDays: u.warnDays,
            lastChange: u.lastChange, expireDate: u.expireDate, inactiveDays: u.inactiveDays,
          };
        },
        set: (username, fields) => {
          userManager.chage(username, {
            M: fields.maxDays, m: fields.minDays, W: fields.warnDays,
            d: fields.lastChange, E: fields.expireDate, I: fields.inactiveDays,
          });
        },
      },
      diskPartitions: {
        list: () => [
          { disk: 'sda', name: 'sda1', fsType: 'ext4', uuid: 'aaaa-bbbb', mountPoint: '/', sizeBytes: 50_000_000_000, label: 'root' },
          { disk: 'sda', name: 'sda2', fsType: 'ext4', uuid: '', mountPoint: '/boot', sizeBytes: 1_000_000_000, label: '' },
        ],
      },
      diskUsage: {
        entries: (all) => (all ? dfTableAll(shellCtx()) : dfTable(shellCtx()))
          .map((r) => ({ fs: r.fs, type: r.type, sizeKb: r.sizeKb, usedKb: r.usedKb, availKb: r.availKb, usePct: r.usePct, mountPoint: r.mount })),
      },
      directoryUsage: {
        walk: (absPath, display) => duWalk(shellCtx(), absPath, display),
      },
      nssQuery: {
        getent: (args) => {
          getentCalls.push([...args]);
          if (args[0] === 'passwd' && args[1] === 'alice') {
            return { output: 'alice:x:1001:1001::/home/alice:/bin/bash', exitCode: 0 };
          }
          return { output: '', exitCode: 2 };
        },
      },
    };
    interpreter = createLinuxHostShell(deps);
  });

  function sessionFor(username: string, cwd: string) {
    const user = resolveLinuxUser(userManager, username);
    return createSession({ id: `sess-${username}`, user, cwd });
  }

  it('arch prints the CPU architecture', async () => {
    const io = makeIO();
    await interpreter.interpretLine('arch', sessionFor('root', '/root'), io);
    expect(await io.out.readAll()).toBe('x86_64\n');
  });

  it('nproc prints the logical CPU count', async () => {
    const io = makeIO();
    await interpreter.interpretLine('nproc', sessionFor('root', '/root'), io);
    expect(await io.out.readAll()).toBe('4\n');
  });

  it('date +FORMAT applies strftime-style formatting', async () => {
    const io = makeIO();
    await interpreter.interpretLine('date +%Y', sessionFor('root', '/root'), io);
    expect(await io.out.readAll()).toBe(`${new Date().getUTCFullYear()}\n`);
  });

  it('hostname reads /etc/hostname (default localhost) and -s truncates at the first dot', async () => {
    const io = makeIO();
    await interpreter.interpretLine('hostname', sessionFor('root', '/root'), io);
    expect(await io.out.readAll()).toBe('localhost\n');
  });

  it('hostname NEWNAME writes /etc/hostname, subsequent hostname reflects it', async () => {
    await interpreter.interpretLine('hostname orcl-host', sessionFor('root', '/root'), makeIO());
    const io = makeIO();
    await interpreter.interpretLine('hostname', sessionFor('root', '/root'), io);
    expect(await io.out.readAll()).toBe('orcl-host\n');
  });

  it('uptime -p prints the pretty uptime clause', async () => {
    const io = makeIO();
    await interpreter.interpretLine('uptime -p', sessionFor('root', '/root'), io);
    expect(await io.out.readAll()).toBe('up 1 hour, 2 minutes\n');
  });

  it('uname (bare) prints the kernel sysname', async () => {
    const io = makeIO();
    await interpreter.interpretLine('uname', sessionFor('root', '/root'), io);
    expect(await io.out.readAll()).toBe('Linux\n');
  });

  it('uname -r prints the kernel release', async () => {
    const io = makeIO();
    await interpreter.interpretLine('uname -r', sessionFor('root', '/root'), io);
    expect(await io.out.readAll()).toBe('5.15.0-130-generic\n');
  });

  it('timedatectl reports the configured time zone', async () => {
    const io = makeIO();
    await interpreter.interpretLine('timedatectl', sessionFor('root', '/root'), io);
    expect(await io.out.readAll()).toContain('Time zone: Etc/UTC (UTC, +0000)');
  });

  it('hostnamectl reports chassis/machine ID/kernel from machine.os', async () => {
    const io = makeIO();
    await interpreter.interpretLine('hostnamectl', sessionFor('root', '/root'), io);
    const out = await io.out.readAll();
    expect(out).toContain('Chassis: vm');
    expect(out).toContain('Kernel: Linux 5.15.0-130-generic');
  });

  it('hostnamectl set-hostname NAME writes /etc/hostname', async () => {
    await interpreter.interpretLine('hostnamectl set-hostname db01', sessionFor('root', '/root'), makeIO());
    const io = makeIO();
    await interpreter.interpretLine('hostname', sessionFor('root', '/root'), io);
    expect(await io.out.readAll()).toBe('db01\n');
  });

  it('chage -l reports aging fields for an existing user', async () => {
    const io = makeIO();
    await interpreter.interpretLine('chage -l alice', sessionFor('root', '/root'), io);
    const out = await io.out.readAll();
    expect(out).toContain('Minimum number of days between password change');
  });

  it('chage -M mutates maxDays, visible via a second chage -l', async () => {
    await interpreter.interpretLine('chage -M 30 alice', sessionFor('root', '/root'), makeIO());
    const io = makeIO();
    await interpreter.interpretLine('chage -l alice', sessionFor('root', '/root'), io);
    expect(await io.out.readAll()).toContain('Maximum number of days between password change\t\t: 30');
  });

  function recordFailedLogins(username: string, times: number): void {
    const account = userManager.getUser(username) as unknown as { recordFailedLogin(): void } | undefined;
    for (let i = 0; i < times; i++) account?.recordFailedLogin();
  }
  function failedLoginCountOf(username: string): number | undefined {
    return (userManager.getUser(username) as unknown as { failedLoginCount: number } | undefined)?.failedLoginCount;
  }

  it('faillock reports nothing for a fresh account, and after failures shows a report', async () => {
    const empty = makeIO();
    await interpreter.interpretLine('faillock --user alice', sessionFor('root', '/root'), empty);
    expect(await empty.out.readAll()).toBe('alice:\nWhen                Type  Source                                           Valid\n');

    recordFailedLogins('alice', 2);
    const withFailures = makeIO();
    await interpreter.interpretLine('faillock --user alice', sessionFor('root', '/root'), withFailures);
    const out = await withFailures.out.readAll();
    expect(out).toContain('alice:');
    expect(out.match(/localhost/g)?.length).toBe(2);
  });

  it('faillock --reset clears the failure counter', async () => {
    recordFailedLogins('alice', 3);
    await interpreter.interpretLine('faillock --user alice --reset', sessionFor('root', '/root'), makeIO());
    expect(failedLoginCountOf('alice')).toBe(0);
  });

  it('which locates a real seeded binary in $PATH', async () => {
    const actor = { uid: 0, gid: 0, gids: [0], name: 'root', groupNames: ['root'] };
    await vfs.mkdir('/usr/bin', 0o755, 0, 0);
    vfs.writeFile('/usr/bin/mytool', '#!/bin/sh\n', actor.uid, actor.gid, 0o022);
    vfs.chmod('/usr/bin/mytool', 0o755);
    const session = sessionFor('root', '/root');
    session.env.set('PATH', '/usr/bin');
    const io = makeIO();
    await interpreter.interpretLine('which mytool', session, io);
    expect(await io.out.readAll()).toBe('/usr/bin/mytool\n');
  });

  it('which falls back to the synthetic /usr/bin path for a known simulator command with no seeded binary', async () => {
    const session = sessionFor('root', '/root');
    session.env.set('PATH', '/usr/bin');
    const io = makeIO();
    await interpreter.interpretLine('which ls', session, io);
    expect(await io.out.readAll()).toBe('/usr/bin/ls\n');
  });

  it('whereis lists binaries found under its fixed search directories for a freshly-seeded name', async () => {
    const actor = { uid: 0, gid: 0, gids: [0], name: 'root', groupNames: ['root'] };
    await vfs.mkdir('/usr/local/bin', 0o755, 0, 0);
    vfs.writeFile('/usr/local/bin/zzz-wave5-tool', '', actor.uid, actor.gid, 0o022);
    const io = makeIO();
    await interpreter.interpretLine('whereis zzz-wave5-tool', sessionFor('root', '/root'), io);
    expect(await io.out.readAll()).toBe('zzz-wave5-tool: /usr/local/bin/zzz-wave5-tool\n');
  });

  it('true succeeds silently, false fails silently', async () => {
    const t = makeIO();
    const trueCode = await interpreter.interpretLine('true', sessionFor('root', '/root'), t);
    expect(trueCode).toBe(0);
    expect(await t.out.readAll()).toBe('');

    const f = makeIO();
    const falseCode = await interpreter.interpretLine('false', sessionFor('root', '/root'), f);
    expect(falseCode).not.toBe(0);
    expect(await f.out.readAll()).toBe('');
  });

  it('printf formats arguments according to the format string', async () => {
    const io = makeIO();
    await interpreter.interpretLine('printf "%s-%d\\n" foo 42', sessionFor('root', '/root'), io);
    expect(await io.out.readAll()).toBe('foo-42\n');
  });

  it('lastlog lists every account, "Never logged in" until a login is recorded', async () => {
    const io = makeIO();
    await interpreter.interpretLine('lastlog -u alice', sessionFor('root', '/root'), io);
    expect(await io.out.readAll()).toContain('**Never logged in**');

    lastlogRegistry.record('alice', '10.0.0.5', 'pts/1');
    const io2 = makeIO();
    await interpreter.interpretLine('lastlog -u alice', sessionFor('root', '/root'), io2);
    const out = await io2.out.readAll();
    expect(out).toContain('10.0.0.5');
    expect(out).toContain('pts/1');
  });

  it('lastlog -u on an unknown user reports "Unknown user or range"', async () => {
    const io = makeIO();
    await interpreter.interpretLine('lastlog -u zzz-nonexistent-user', sessionFor('root', '/root'), io);
    expect(await io.out.readAll()).toBe('lastlog: Unknown user or range: zzz-nonexistent-user\n');
  });

  it('df default table includes the root filesystem row', async () => {
    const io = makeIO();
    await interpreter.interpretLine('df', sessionFor('root', '/root'), io);
    const out = await io.out.readAll();
    expect(out).toContain('/dev/sda1');
    expect(out).toContain('Mounted on');
  });

  it('du -sh reports a single summarized human-readable line for a directory', async () => {
    await interpreter.interpretLine('mkdir /root/data', sessionFor('root', '/root'), makeIO());
    await interpreter.interpretLine('echo hello > /root/data/f.txt', sessionFor('root', '/root'), makeIO());
    const io = makeIO();
    await interpreter.interpretLine('du -sh /root/data', sessionFor('root', '/root'), io);
    const out = await io.out.readAll();
    expect(out).toMatch(/^\S+\t\/root\/data\n$/);
  });

  it('du on a single file reports its own size on one line', async () => {
    await interpreter.interpretLine('echo hello > /root/single.txt', sessionFor('root', '/root'), makeIO());
    const io = makeIO();
    await interpreter.interpretLine('du /root/single.txt', sessionFor('root', '/root'), io);
    expect(await io.out.readAll()).toBe('1\t/root/single.txt\n');
  });

  it('getent passwd alice delegates to machine.nssQuery and forwards its output verbatim', async () => {
    const io = makeIO();
    const code = await interpreter.interpretLine('getent passwd alice', sessionFor('root', '/root'), io);
    expect(await io.out.readAll()).toBe('alice:x:1001:1001::/home/alice:/bin/bash\n');
    expect(code).toBe(0);
    expect(getentCalls).toEqual([['passwd', 'alice']]);
  });

  it('getent on an unknown key surfaces the NSS "key not found" exit code', async () => {
    const io = makeIO();
    const code = await interpreter.interpretLine('getent passwd nope', sessionFor('root', '/root'), io);
    expect(code).toBe(2);
  });

  it('blkid (root) lists partitions with UUID/TYPE from machine.diskPartitions', async () => {
    const io = makeIO();
    await interpreter.interpretLine('blkid', sessionFor('root', '/root'), io);
    const out = await io.out.readAll();
    expect(out).toContain('/dev/sda1: UUID="aaaa-bbbb" TYPE="ext4"');
  });

  it('blkid without root privileges is refused', async () => {
    const io = makeIO();
    await interpreter.interpretLine('blkid', sessionFor('alice', '/home/alice'), io);
    expect(await io.out.readAll()).toBe('blkid: error: Permission denied\n');
  });
});
