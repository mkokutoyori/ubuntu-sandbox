/*
 * Probe: /var/log/lastlog is the glibc struct lastlog table (292 bytes per uid: int32 time, line[32], host[256]) that
 * lastlog 4.13 reads (src/lastlog.c, checked byte for byte by lastlog-oracle.test.ts), written by the SSH login and
 * read back by both the lastlog command and the "Last login:" banner; the JSON copy kept by the SSH context and the
 * in-memory map of the machine are gone.  Measured before the change (git stash push -u -- src/network): 6 of the 8
 * cases fall.  The two that pass either way are witnesses: 'lastlog -u alice prints Never logged in before any login'
 * and 'a non-root user may read the file'.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { binaryStringToBytes } from '@/network/devices/linux/login/UtmpxRecord';

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


function recordOf(server: LinuxServer, uid: number): { seconds: number; line: string; host: string } {
  const vfs = (server as unknown as { executor: { vfs: { readFile(p: string): string | null } } }).executor.vfs;
  const bytes = binaryStringToBytes(vfs.readFile('/var/log/lastlog') ?? '');
  const record = bytes.subarray(uid * 292, uid * 292 + 292);
  const text = (from: number, to: number): string => new TextDecoder().decode(record.subarray(from, to)).replace(/\0.*$/s, '');
  return { seconds: new DataView(record.buffer, record.byteOffset, 292).getInt32(0, true), line: text(4, 36), host: text(36, 292) };
}

describe('binary lastlog store', () => {
  it('lastlog -u alice prints Never logged in before any login', async () => {
    const { srv } = await buildLan();
    expect(await srv.executeCommand('lastlog -u alice')).toMatch(/\*\*Never logged in\*\*/);
  });

  it('an SSH login writes the record of the uid with the pty line and the client address', async () => {
    const { pc1, srv } = await buildLan();
    await pc1.executeCommand('ssh alice@10.0.0.10 sleep 60', 'admin\n');
    const uid = Number((await srv.executeCommand('id -u alice')).trim());
    const record = recordOf(srv, uid);
    expect(record.line).toMatch(/^pts\/\d+$/);
    expect(record.host).toBe('10.0.0.1');
    expect(record.seconds).toBeGreaterThan(1_000_000_000);
  });

  it('the file is 0664 root:utmp and its size is a multiple of the 292-byte record', async () => {
    const { pc1, srv } = await buildLan();
    await pc1.executeCommand('ssh alice@10.0.0.10 whoami', 'admin\n');
    expect((await srv.executeCommand("stat -c '%a %U:%G' /var/log/lastlog")).trim()).toBe('664 root:utmp');
    expect(Number((await srv.executeCommand("stat -c '%s' /var/log/lastlog")).trim()) % 292).toBe(0);
  });

  it('lastlog prints the shadow layout: 16-column name, 8-column port, 42-column host, local time with offset', async () => {
    const { pc1, srv } = await buildLan();
    await pc1.executeCommand('ssh alice@10.0.0.10 whoami', 'admin\n');
    const out = await srv.executeCommand('lastlog -u alice');
    expect(out.split('\n')[0]).toBe('Username         Port     From                                       Latest');
    expect(out.split('\n')[1]).toMatch(/^alice            pts\/\d+ {4,5}10\.0\.0\.1 +\w{3} \w{3} [ \d]\d \d{2}:\d{2}:\d{2} [+-]\d{4} \d{4}$/);
  });

  it('-t and -b select on the age of the record and print the header only with a first row', async () => {
    const { pc1, srv } = await buildLan();
    await pc1.executeCommand('ssh alice@10.0.0.10 whoami', 'admin\n');
    expect(await srv.executeCommand('lastlog -u alice -b 1')).toBe('');
    expect(await srv.executeCommand('lastlog -u alice -t 1')).toMatch(/^Username/);
  });

  it('lastlog -C and -S as a non-root user fail on the file permission like the real tool', async () => {
    const { srv } = await buildLan();
    await srv.executeCommand('useradd -m -s /bin/bash plainuser');
    expect(await srv.executeCommand('su - plainuser -c "lastlog -S -u plainuser"')).toContain('/var/log/lastlog: Permission denied');
  });

  it('a non-root user may read the file', async () => {
    const { srv } = await buildLan();
    await srv.executeCommand('useradd -m -s /bin/bash plainuser');
    expect(await srv.executeCommand('su - plainuser -c "lastlog -u root"')).toMatch(/^Username/);
  });

  it('no lastlog.json copy remains', async () => {
    const { pc1, srv } = await buildLan();
    await pc1.executeCommand('ssh alice@10.0.0.10 whoami', 'admin\n');
    expect(await srv.executeCommand('ls /var/log/lastlog.json 2>&1')).toContain('No such file');
  });
});
