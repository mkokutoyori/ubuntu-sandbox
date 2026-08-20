import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { sshLocalFsFor, knownHostsPathFor } from '@/network/protocols/ssh/localFs/sshLocalFsFor';
import type { Equipment } from '@/network/equipment/Equipment';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.getInstance().clear();
});

const VENDORS: readonly (readonly [string, () => Equipment])[] = [
  ['linux', () => new LinuxPC('linux-pc', 'PC1') as unknown as Equipment],
  ['windows', () => new WindowsPC('windows-pc', 'WIN1') as unknown as Equipment],
  ['cisco', () => new CiscoRouter('router-cisco', 'R1') as unknown as Equipment],
  ['huawei', () => new HuaweiRouter('router-huawei', 'R2') as unknown as Equipment],
];

describe.each(VENDORS)('the ssh client store on a %s device', (_name, make) => {
  it('round-trips known_hosts', () => {
    const device = make();
    const fs = sshLocalFsFor(device);
    const path = knownHostsPathFor(device, 'admin');

    expect(fs.readFile(path)).toBeNull();
    expect(fs.writeFile(path, 'host ssh-ed25519 AAAA\n', 0, 0, 0o022)).toBe(true);
    expect(fs.readFile(path)).toBe('host ssh-ed25519 AAAA\n');
  });

  it('is the same store across calls, so an entry written once is found again', () => {
    const device = make();
    const path = knownHostsPathFor(device, 'admin');
    sshLocalFsFor(device).writeFile(path, 'first\n', 0, 0, 0o022);
    expect(sshLocalFsFor(device).readFile(path)).toBe('first\n');
  });

  it('keeps one device\'s entries out of another\'s', () => {
    const a = make();
    const b = make();
    const path = knownHostsPathFor(a, 'admin');
    sshLocalFsFor(a).writeFile(path, 'only-a\n', 0, 0, 0o022);
    expect(sshLocalFsFor(b).readFile(path)).toBeNull();
  });

  it('creates the parent directory on the way', () => {
    const device = make();
    const fs = sshLocalFsFor(device);
    const path = knownHostsPathFor(device, 'admin');
    fs.writeFile(path, 'x\n', 0, 0, 0o022);
    const dir = path.slice(0, path.lastIndexOf('/'));
    expect(fs.resolveInode(dir)?.type).toBe('directory');
    expect(fs.listDirectory(dir)?.map((e) => e.name)).toContain('known_hosts');
  });
});

describe('known_hosts lands where each vendor\'s admin would look', () => {
  it('uses a POSIX home on Linux', () => {
    const device = new LinuxPC('linux-pc', 'PC1') as unknown as Equipment;
    expect(knownHostsPathFor(device, 'alice')).toBe('/home/alice/.ssh/known_hosts');
    expect(knownHostsPathFor(device, 'root')).toBe('/root/.ssh/known_hosts');
  });

  it('uses the user profile on Windows', () => {
    const device = new WindowsPC('windows-pc', 'WIN1') as unknown as Equipment;
    expect(knownHostsPathFor(device, 'User')).toBe('/Users/User/.ssh/known_hosts');
  });

  it('puts a Windows entry on the real C: disk, not a side store', () => {
    const device = new WindowsPC('windows-pc', 'WIN1');
    const fs = sshLocalFsFor(device as unknown as Equipment);
    fs.writeFile(knownHostsPathFor(device as unknown as Equipment, 'User'), 'entry\n', 0, 0, 0o022);
    const onDisk = device.getFileSystem().readFile('C:\\Users\\User\\.ssh\\known_hosts');
    expect(onDisk.ok).toBe(true);
    expect(onDisk.content).toBe('entry\n');
  });
});
