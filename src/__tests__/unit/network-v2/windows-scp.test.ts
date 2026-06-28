import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function buildLab() {
  const win = new WindowsPC('windows-pc', 'WIN1', 0, 0);
  const srv = new LinuxServer('linux-server', 'srv1', 0, 0);
  new Cable('c1').connect(win.getPorts()[0], srv.getPorts()[0]);
  win.getPorts()[0].configureIP(new IPAddress('10.0.0.10'), new SubnetMask('255.255.255.0'));
  srv.getPorts()[0].configureIP(new IPAddress('10.0.0.20'), new SubnetMask('255.255.255.0'));
  srv.setHostname('srv1');
  const um = (srv as unknown as { executor: { userMgr: {
    useradd(u: string, o?: object): void;
    setPassword(u: string, p: string): void;
  } } }).executor.userMgr;
  um.useradd('alice', { m: true, s: '/bin/bash' });
  um.setPassword('alice', 'admin');
  return { win, srv };
}

describe('Windows scp.exe — OpenSSH for Windows', () => {
  it('uploads a local Windows file to a remote Linux server', async () => {
    const { win, srv } = await buildLab();
    win.fs.createFile('C:\\Users\\User\\notes.txt', 'hello-from-windows');
    const out = await win.executeCommand('scp C:\\Users\\User\\notes.txt alice@10.0.0.20:/tmp/notes.txt');
    expect(out).toMatch(/notes\.txt/);
    expect(out).toMatch(/100%/);
    const vfs = (srv as unknown as { executor: { vfs: { readFile(p: string): string | null } } }).executor.vfs;
    expect(vfs.readFile('/tmp/notes.txt')).toBe('hello-from-windows');
  });

  it('downloads a remote Linux file to the Windows filesystem', async () => {
    const { win, srv } = await buildLab();
    const vfs = (srv as unknown as { executor: { vfs: { writeFile(p: string, c: string, u: number, g: number, m: number): void } } }).executor.vfs;
    vfs.writeFile('/tmp/remote.txt', 'pulled-from-linux', 0, 0, 0o022);
    const out = await win.executeCommand('scp alice@10.0.0.20:/tmp/remote.txt C:\\Users\\User\\fetched.txt');
    expect(out).toMatch(/100%/);
    const got = win.fs.readFile('C:\\Users\\User\\fetched.txt');
    expect(got.ok).toBe(true);
    expect(got.content).toBe('pulled-from-linux');
  });

  it('rejects local-to-local copy with a clear error', async () => {
    const { win } = await buildLab();
    const out = await win.executeCommand('scp C:\\a.txt C:\\b.txt');
    expect(out).toMatch(/^scp: exactly one of source\/destination must be remote/);
  });

  it('rejects remote-to-remote copy as unsupported', async () => {
    const { win } = await buildLab();
    const out = await win.executeCommand('scp alice@10.0.0.20:/a alice@10.0.0.20:/b');
    expect(out).toMatch(/remote-to-remote/);
  });

  it('prints OpenSSH-style usage when called with no arguments', async () => {
    const { win } = await buildLab();
    const out = await win.executeCommand('scp');
    expect(out).toMatch(/^usage: scp/);
  });

  it('returns "Connection refused" when the remote IP has no route (TCP gate)', async () => {
    const { win } = await buildLab();
    win.fs.createFile('C:\\Users\\User\\x.txt', 'x');
    const out = await win.executeCommand('scp C:\\Users\\User\\x.txt alice@10.99.99.99:/tmp/x.txt');
    expect(out).toMatch(/ssh: connect to host 10\.99\.99\.99 port 22: Connection refused/);
  });

  it('fails over a downed link (TCP probe cannot complete the handshake)', async () => {
    const { win, srv } = await buildLab();
    srv.getPorts()[0].setUp(false);
    win.fs.createFile('C:\\Users\\User\\x.txt', 'x');
    const out = await win.executeCommand('scp C:\\Users\\User\\x.txt alice@10.0.0.20:/tmp/x.txt');
    expect(out).toMatch(/Connection refused|No route to host/);
  });
});
