import { beforeEach, describe, expect, it } from 'vitest';
import { createSession } from '@/command-kernel/session/types';
import { PipeBuffer } from '@/command-kernel/io/pipe-buffer';
import { CommandIO } from '@/command-kernel/io/types';
import { Interpreter } from '@/command-kernel/interpreter';
import { LinuxCommandExecutor } from '@/network/devices/linux/LinuxCommandExecutor';
import { createLinuxHostShell } from '@/network/devices/linux/command-kernel/createLinuxHostShell';
import { LinuxMachineApiDeps } from '@/network/devices/linux/command-kernel/LinuxMachineApi';
import { resolveLinuxUser } from '@/network/devices/linux/command-kernel/LinuxUser';
import { cmdAusearch, cmdAureport } from '@/network/devices/linux/audit/AuditCommands';
import { cmdAtq, cmdAtrm } from '@/network/devices/linux/jobs/LinuxAtQueue';

function makeIO(): CommandIO & { stdin: PipeBuffer; out: PipeBuffer; err: PipeBuffer } {
  const out = new PipeBuffer();
  const err = new PipeBuffer();
  return { stdin: new PipeBuffer(), stdout: out, stderr: err, out, err };
}

describe('Linux Wave 6 — passwd/chpasswd/usermod/userdel/deluser/groupadd/groupmod/groupdel/gpasswd/lsof/ausearch/aureport/auditctl/mount/umount/findmnt/crontab/atq/atrm/runlevel', () => {
  let executor: LinuxCommandExecutor;
  let deps: LinuxMachineApiDeps;
  let interpreter: Interpreter;

  beforeEach(() => {
    executor = new LinuxCommandExecutor(false);

    deps = {
      vfs: executor.vfs,
      userManager: executor.userMgr,
      processManager: executor.processMgr,
      logManager: executor.logMgr,
      hostname: 'testhost',
      ports: [],
      getUmask: () => executor.getUmask(),
      setUmask: (value) => executor.setUmask(value),
      powerOn: () => {},
      powerOff: () => {},
      publishFsAccess: () => {},
      publishSyscall: () => {},
      passwordAging: {
        get: (username) => {
          const u = executor.userMgr.getUser(username);
          if (!u) return undefined;
          return {
            maxDays: u.maxDays, minDays: u.minDays, warnDays: u.warnDays,
            lastChange: u.lastChange, expireDate: u.expireDate, inactiveDays: u.inactiveDays,
          };
        },
        set: (username, fields) => {
          executor.userMgr.chage(username, {
            M: fields.maxDays, m: fields.minDays, W: fields.warnDays,
            d: fields.lastChange, E: fields.expireDate, I: fields.inactiveDays,
          });
        },
      },
      netstatInspect: {
        routes: () => null,
        interfaces: () => null,
        sockets: () => [],
        resolveService: () => null,
        isServer: () => false,
      },
      auditJournal: {
        ausearch: (args) => cmdAusearch(executor.auditLog, executor.resolveAusearchUserArgs([...args])),
        aureport: (args) => cmdAureport(executor.auditLog, [...args]),
        auditctl: (args) => executor.handleAuditctl([...args]),
      },
      mountTable: {
        mount: (args) => executor.handleMount([...args]),
        umount: (args) => executor.handleUmount([...args]),
        findmnt: (args) => executor.handleFindmnt([...args]),
      },
      cronTab: {
        crontab: (args, stdin) => executor.handleCrontab([...args], stdin),
      },
      atJobs: {
        atq: () => cmdAtq(executor.getAtQueue()),
        atrm: (args) => cmdAtrm(executor.getAtQueue(), [...args]),
      },
    };
    interpreter = createLinuxHostShell(deps);
  });

  function sessionFor(username: string, cwd: string) {
    const user = resolveLinuxUser(executor.userMgr, username);
    return createSession({ id: `sess-${username}`, user, cwd });
  }

  // ─── IAM ────────────────────────────────────────────────────────

  it('passwd -S reports status for an existing account', async () => {
    const io = makeIO();
    await interpreter.interpretLine('passwd -S user', sessionFor('root', '/root'), io);
    const out = await io.out.readAll();
    expect(out).toMatch(/^user (P|NP|L) \d{2}\/\d{2}\/\d{4} -?\d+ -?\d+ -?\d+ -?\d+\n$/);
  });

  it('passwd LOGIN by a non-root caller is refused, even for the caller\'s own name', async () => {
    const io = makeIO();
    const code = await interpreter.interpretLine('passwd user', sessionFor('user', '/home/user'), io);
    expect(await io.out.readAll()).toBe('passwd: You may not view or modify password information for user.\n');
    expect(code).toBe(1);
  });

  it('passwd -l locks the account, passwd -S then reports L', async () => {
    await interpreter.interpretLine('passwd -l user', sessionFor('root', '/root'), makeIO());
    const io = makeIO();
    await interpreter.interpretLine('passwd -S user', sessionFor('root', '/root'), io);
    expect(await io.out.readAll()).toMatch(/^user L /);
  });

  it('chpasswd applies a batch of username:password pairs from stdin', async () => {
    const io = makeIO();
    await io.stdin.write('user:newpass1\n');
    await io.stdin.close();
    const code = await interpreter.interpretLine('chpasswd', sessionFor('root', '/root'), io);
    expect(code).toBe(0);
  });

  it('usermod -s changes the login shell', async () => {
    await interpreter.interpretLine('usermod -s /bin/zsh user', sessionFor('root', '/root'), makeIO());
    expect(executor.userMgr.getUser('user')?.shell).toBe('/bin/zsh');
  });

  it('usermod on an unknown user reports the vendor-exact error', async () => {
    const io = makeIO();
    const code = await interpreter.interpretLine('usermod -s /bin/zsh zzz-nope', sessionFor('root', '/root'), io);
    expect(await io.out.readAll()).toBe("usermod: user 'zzz-nope' does not exist\n");
    expect(code).toBe(1);
  });

  it('userdel removes an account', async () => {
    executor.userMgr.useradd('zzz-wave6-victim', { m: true });
    const code = await interpreter.interpretLine('userdel zzz-wave6-victim', sessionFor('root', '/root'), makeIO());
    expect(code).toBe(0);
    expect(executor.userMgr.getUser('zzz-wave6-victim')).toBeUndefined();
  });

  it('deluser LOGIN GROUP removes only the group membership, keeping the account', async () => {
    executor.userMgr.groupadd('zzz-wave6-group', {});
    executor.userMgr.usermod('alice', { aG: 'zzz-wave6-group' });
    const io = makeIO();
    await interpreter.interpretLine('deluser alice zzz-wave6-group', sessionFor('root', '/root'), io);
    expect(await io.out.readAll()).toContain("Removing user `alice' from group `zzz-wave6-group'");
    expect(executor.userMgr.getUser('alice')).toBeDefined();
    expect(executor.userMgr.getGroup('zzz-wave6-group')?.members).not.toContain('alice');
  });

  it('groupadd creates a group, groupmod renames it, groupdel removes it', async () => {
    await interpreter.interpretLine('groupadd zzz-wave6-g1', sessionFor('root', '/root'), makeIO());
    expect(executor.userMgr.getGroup('zzz-wave6-g1')).toBeDefined();

    await interpreter.interpretLine('groupmod -n zzz-wave6-g2 zzz-wave6-g1', sessionFor('root', '/root'), makeIO());
    expect(executor.userMgr.getGroup('zzz-wave6-g2')).toBeDefined();
    expect(executor.userMgr.getGroup('zzz-wave6-g1')).toBeUndefined();

    const code = await interpreter.interpretLine('groupdel zzz-wave6-g2', sessionFor('root', '/root'), makeIO());
    expect(code).toBe(0);
    expect(executor.userMgr.getGroup('zzz-wave6-g2')).toBeUndefined();
  });

  it('gpasswd -d prints the removal confirmation line', async () => {
    executor.userMgr.groupadd('zzz-wave6-g3', {});
    executor.userMgr.usermod('bob', { aG: 'zzz-wave6-g3' });
    const io = makeIO();
    const code = await interpreter.interpretLine('gpasswd -d bob zzz-wave6-g3', sessionFor('root', '/root'), io);
    expect(await io.out.readAll()).toBe('Removing user bob from group zzz-wave6-g3\n');
    expect(code).toBe(0);
    expect(executor.userMgr.getGroup('zzz-wave6-g3')?.members).not.toContain('bob');
  });

  // ─── lsof ───────────────────────────────────────────────────────

  it('lsof -p PID lists the cwd row for that process', async () => {
    const shellProc = executor.processMgr.list({ comm: '-bash' })[0];
    expect(shellProc).toBeDefined();
    const io = makeIO();
    await interpreter.interpretLine(`lsof -p ${shellProc.pid}`, sessionFor('root', '/root'), io);
    const out = await io.out.readAll();
    expect(out).toContain('COMMAND     PID   USER   FD    TYPE DEVICE SIZE/OFF NODE NAME');
    expect(out).toContain(String(shellProc.pid));
  });

  it('lsof -p on an unknown PID with no matches reports "No such process"', async () => {
    const io = makeIO();
    await interpreter.interpretLine('lsof -p 999999', sessionFor('root', '/root'), io);
    expect(await io.out.readAll()).toBe('lsof: PID 999999: No such process\n');
  });

  // ─── audit ──────────────────────────────────────────────────────

  it('ausearch on an empty audit log reports "<no matches>"', async () => {
    const io = makeIO();
    await interpreter.interpretLine('ausearch -m USER_LOGIN', sessionFor('root', '/root'), io);
    expect(await io.out.readAll()).toBe('<no matches>\n');
  });

  it('ausearch by a non-root caller is refused', async () => {
    const io = makeIO();
    const code = await interpreter.interpretLine('ausearch', sessionFor('user', '/home/user'), io);
    expect(await io.out.readAll()).toBe('ausearch: Permission denied\n');
    expect(code).toBe(1);
  });

  it('aureport on an empty audit log succeeds', async () => {
    const io = makeIO();
    const code = await interpreter.interpretLine('aureport', sessionFor('root', '/root'), io);
    expect(code).toBe(0);
  });

  it('auditctl -l lists the (empty) rule set', async () => {
    const io = makeIO();
    const code = await interpreter.interpretLine('auditctl -l', sessionFor('root', '/root'), io);
    expect(code).toBe(0);
  });

  // ─── mount / umount / findmnt ───────────────────────────────────

  it('mount (bare) lists active mounts, no privilege required', async () => {
    const io = makeIO();
    const code = await interpreter.interpretLine('mount', sessionFor('user', '/home/user'), io);
    expect(await io.out.readAll()).toContain('on /proc type proc');
    expect(code).toBe(0);
  });

  it('mount SOURCE TARGET by a non-root caller is refused', async () => {
    const io = makeIO();
    const code = await interpreter.interpretLine('mount /dev/sdb1 /mnt', sessionFor('user', '/home/user'), io);
    expect(await io.out.readAll()).toBe('mount: only root can do that: Permission denied\n');
    expect(code).toBe(1);
  });

  it('umount by a non-root caller is refused', async () => {
    const io = makeIO();
    const code = await interpreter.interpretLine('umount /run/lock', sessionFor('user', '/home/user'), io);
    expect(await io.out.readAll()).toBe('umount: only root can do that: Permission denied\n');
    expect(code).toBe(1);
  });

  it('umount as root detaches a pseudo mount, then findmnt no longer reports it', async () => {
    const before = makeIO();
    await interpreter.interpretLine('findmnt /run/lock', sessionFor('root', '/root'), before);
    expect(await before.out.readAll()).toContain('/run/lock');

    const code = await interpreter.interpretLine('umount /run/lock', sessionFor('root', '/root'), makeIO());
    expect(code).toBe(0);

    const after = makeIO();
    await interpreter.interpretLine('findmnt /run/lock', sessionFor('root', '/root'), after);
    expect(await after.out.readAll()).not.toContain('/run/lock');
  });

  it('findmnt (bare) prints the TARGET SOURCE FSTYPE OPTIONS header', async () => {
    const io = makeIO();
    await interpreter.interpretLine('findmnt', sessionFor('root', '/root'), io);
    expect(await io.out.readAll()).toContain('TARGET SOURCE FSTYPE OPTIONS');
  });

  // ─── crontab ────────────────────────────────────────────────────

  it('crontab -l with nothing installed reports "no crontab for USER"', async () => {
    const io = makeIO();
    const code = await interpreter.interpretLine('crontab -l', sessionFor('user', '/home/user'), io);
    expect(await io.out.readAll()).toBe('no crontab for user\n');
    expect(code).toBe(1);
  });

  it('crontab - installs from stdin, then crontab -l shows it back', async () => {
    const install = makeIO();
    await install.stdin.write('* * * * * echo hi\n');
    await install.stdin.close();
    await interpreter.interpretLine('crontab -', sessionFor('user', '/home/user'), install);

    const io = makeIO();
    await interpreter.interpretLine('crontab -l', sessionFor('user', '/home/user'), io);
    expect(await io.out.readAll()).toContain('* * * * * echo hi');
  });

  // ─── at ─────────────────────────────────────────────────────────

  it('atq lists a spooled job, atrm removes it', async () => {
    const job = executor.getAtQueue().enqueue('echo hi', 'root', new Date('2030-01-01T10:00:00Z'));

    const listIo = makeIO();
    await interpreter.interpretLine('atq', sessionFor('root', '/root'), listIo);
    expect(await listIo.out.readAll()).toContain(`${job.id}\t`);

    await interpreter.interpretLine(`atrm ${job.id}`, sessionFor('root', '/root'), makeIO());
    expect(executor.getAtQueue().get(job.id)).toBeUndefined();
  });

  it('atrm on an unknown job id reports "Cannot find jobid"', async () => {
    const io = makeIO();
    await interpreter.interpretLine('atrm 999999', sessionFor('root', '/root'), io);
    expect(await io.out.readAll()).toBe('Cannot find jobid 999999\n');
  });

  // ─── runlevel ───────────────────────────────────────────────────

  it('runlevel reports N 5 for a workstation profile', async () => {
    const io = makeIO();
    await interpreter.interpretLine('runlevel', sessionFor('root', '/root'), io);
    expect(await io.out.readAll()).toBe('N 5\n');
  });
});
