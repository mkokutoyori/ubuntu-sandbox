/*
 * Probe: /var/log/wtmp, /var/log/btmp and /var/run/utmp hold the glibc struct utmpx (384 bytes) that last 2.39.3
 * reads (login-utils/last.c, checked byte for byte by last-oracle.test.ts): BOOT_TIME "reboot"/"~"/"~~" with the
 * kernel release in ut_host, RUN_LVL "runlevel" with pid ('N' << 8 | '5'), USER_PROCESS with line pts/N and id
 * "ts/N" and the client address, DEAD_PROCESS on logout, LOGIN_PROCESS "ssh:notty" in btmp, files 0664/0660
 * root:utmp.
 * Measured before the change (git stash push -u -- src/network): 8 of the 11 cases fall - the files held the
 * simulator's own delimited text, had no runlevel or DEAD_PROCESS records, and the wire path kept a second copy in
 * wtmp.json/btmp.json.  The three that pass either way are witnesses: 'wtmp size is a multiple of 384' (size kept
 * 384-faithful before), 'wtmp.json and btmp.json no longer exist' (the client path never wrote them) and 'a session
 * is listed by last while it is open'.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { UT, Utmpx, binaryStringToBytes } from '@/network/devices/linux/login/UtmpxRecord';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function buildLan() {
  const pc1 = new LinuxPC('linux-pc', 'pc1', 0, 0);
  const srv = new LinuxServer('linux-server', 'srv', 0, 0);
  new Cable('c1').connect(pc1.getPorts()[0], srv.getPorts()[0]);
  pc1.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  srv.getPorts()[0].configureIP(new IPAddress('10.0.0.10'), new SubnetMask('255.255.255.0'));
  const um = (srv as unknown as { executor: { userMgr: {
    setPassword(u: string, p: string): void;
    useradd(u: string, o?: object): void;
  } } }).executor.userMgr;
  um.setPassword('alice', 'admin');
  um.useradd('mallory', { m: true, s: '/bin/bash' });
  um.setPassword('mallory', 'x');
  return { pc1, srv };
}


function records(server: LinuxServer, path: string): Utmpx[] {
  const vfs = (server as unknown as { executor: { vfs: { readFile(p: string): string | null } } }).executor.vfs;
  const bytes = binaryStringToBytes(vfs.readFile(path) ?? '');
  return Array.from({ length: Math.floor(bytes.length / 384) }, (_, i) => new Utmpx(bytes.subarray(i * 384, (i + 1) * 384)));
}

describe('utmpx records written by the simulated host', () => {
  it('wtmp size is a multiple of 384', async () => {
    const { srv } = await buildLan();
    const size = Number((await srv.executeCommand("stat -c '%s' /var/log/wtmp")).trim());
    expect(size % 384).toBe(0);
    expect(size).toBeGreaterThan(0);
  });

  it('boot writes BOOT_TIME then RUN_LVL records with the kernel release in ut_host', async () => {
    const { srv } = await buildLan();
    const [boot, level] = records(srv, '/var/log/wtmp');
    expect([boot.type, boot.text('user'), boot.text('line'), boot.text('id')]).toEqual([UT.BOOT_TIME, 'reboot', '~', '~~']);
    expect(boot.text('host')).toBe((await srv.executeCommand('uname -r')).trim());
    expect([level.type, level.text('user'), level.text('line'), level.pid]).toEqual([UT.RUN_LVL, 'runlevel', '~', (0x4e << 8) | 0x35]);
  });

  it('last -x shows the runlevel record the way last prints it', async () => {
    const { srv } = await buildLan();
    expect(await srv.executeCommand('last -x')).toMatch(/^runlevel \(to lvl 5\)\s+\S+\s+\w{3} \w{3}\s+\d+ \d{2}:\d{2}/m);
  });

  it('an SSH login writes a USER_PROCESS with line pts/N, id ts/N, the client address and the sshd pid', async () => {
    const { pc1, srv } = await buildLan();
    await pc1.executeCommand('ssh alice@10.0.0.10 sleep 60', 'admin\n');
    const login = records(srv, '/var/log/wtmp').filter((r) => r.type === UT.USER_PROCESS && r.text('user') === 'alice').pop()!;
    expect(login.text('line')).toMatch(/^pts\/\d+$/);
    expect(login.text('id')).toBe(login.text('line').slice(-4));
    expect(login.text('host')).toBe('10.0.0.1');
    expect(Array.from(login.address.subarray(0, 4))).toEqual([10, 0, 0, 1]);
    expect(login.pid).toBeGreaterThan(1);
  });

  it('a closed session adds a DEAD_PROCESS record on the same line with an empty user', async () => {
    const { pc1, srv } = await buildLan();
    await pc1.executeCommand('ssh alice@10.0.0.10 whoami', 'admin\n');
    const all = records(srv, '/var/log/wtmp');
    const dead = all[all.length - 1];
    const login = all[all.length - 2];
    expect([login.type, dead.type]).toEqual([UT.USER_PROCESS, UT.DEAD_PROCESS]);
    expect(dead.text('line')).toBe(login.text('line'));
    expect(dead.text('user')).toBe('');
    expect(dead.pid).toBe(login.pid);
  });

  it('utmp keeps the open session as USER_PROCESS and turns it into DEAD_PROCESS on logout', async () => {
    const { pc1, srv } = await buildLan();
    await pc1.executeCommand('ssh alice@10.0.0.10 whoami', 'admin\n');
    const line = records(srv, '/var/log/wtmp').filter((r) => r.type === UT.USER_PROCESS).pop()!.text('line');
    const slot = records(srv, '/var/run/utmp').find((r) => r.text('line') === line)!;
    expect(slot.type).toBe(UT.DEAD_PROCESS);
  });

  it('a failed login writes a LOGIN_PROCESS on ssh:notty with the user and the address in btmp', async () => {
    const { pc1, srv } = await buildLan();
    await pc1.executeCommand('sshpass -p wrongpass ssh mallory@10.0.0.10 whoami');
    const entries = records(srv, '/var/log/btmp');
    expect(entries).toHaveLength(1);
    expect([entries[0].type, entries[0].text('line'), entries[0].text('user'), entries[0].text('host')]).toEqual([UT.LOGIN_PROCESS, 'ssh:notty', 'mallory', '10.0.0.1']);
  });

  it('files are 0664 and 0660 owned by root:utmp, and the group exists', async () => {
    const { srv } = await buildLan();
    expect((await srv.executeCommand("stat -c '%a %U:%G' /var/log/wtmp")).trim()).toBe('664 root:utmp');
    expect((await srv.executeCommand("stat -c '%a %U:%G' /var/log/btmp")).trim()).toBe('660 root:utmp');
    expect(await srv.executeCommand('getent group utmp')).toContain('utmp:x:43:');
  });

  it('wtmp.json and btmp.json no longer exist', async () => {
    const { pc1, srv } = await buildLan();
    await pc1.executeCommand('ssh alice@10.0.0.10 whoami', 'admin\n');
    expect(await srv.executeCommand('ls /var/log/wtmp.json /var/log/btmp.json 2>&1')).toContain('No such file');
  });

  it('a session is listed by last while it is open', async () => {
    const { pc1, srv } = await buildLan();
    await pc1.executeCommand('ssh alice@10.0.0.10 sleep 60', 'admin\n');
    expect(await srv.executeCommand('last')).toMatch(/alice\s+pts\/\d+\s+10\.0\.0\.1\s+\w{3} \w{3}\s+\d+ \d{2}:\d{2}\s+still logged in/);
  });

  it('lastb is refused to an ordinary user the way the real tool is', async () => {
    const { srv } = await buildLan();
    await srv.executeCommand('useradd -m -s /bin/bash plainuser');
    expect(await srv.executeCommand('su - plainuser -c "lastb"')).toContain('lastb: cannot open /var/log/btmp: Permission denied');
  });
});
