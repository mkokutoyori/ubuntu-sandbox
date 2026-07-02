import { describe, it, expect } from 'vitest';
import { MountTable, MountEntry } from '@/network/devices/linux/MountTable';
import { HardwareProfile } from '@/network/devices/host/hardware';

describe('MountTable', () => {
  it('seeds from a server hardware profile with root, boot, data and pseudo mounts', () => {
    const table = MountTable.fromHardware(HardwareProfile.server().storage);
    const targets = table.list().map((e) => e.target);
    expect(targets).toContain('/');
    expect(targets).toContain('/boot');
    expect(targets).toContain('/u01');
    expect(targets).toContain('/proc');
    expect(targets).toContain('/sys');
    expect(targets).toContain('/dev/shm');
  });

  it('maps partitions to their device nodes', () => {
    const table = MountTable.fromHardware(HardwareProfile.workstation().storage);
    expect(table.find('/')?.source).toBe('/dev/sda1');
    expect(table.find('/boot')?.source).toBe('/dev/sda2');
  });

  it('resolves a path to the longest matching mount point', () => {
    const table = MountTable.fromHardware(HardwareProfile.server().storage);
    expect(table.resolve('/u01/app/oracle')?.target).toBe('/u01');
    expect(table.resolve('/boot/grub/grub.cfg')?.target).toBe('/boot');
    expect(table.resolve('/etc/passwd')?.target).toBe('/');
  });

  it('reports read-only state after a ro remount of an existing mount', () => {
    const table = MountTable.fromHardware(HardwareProfile.server().storage);
    expect(table.isReadOnly('/u01/x')).toBe(false);
    table.remount('/u01', ['ro', 'remount']);
    expect(table.isReadOnly('/u01/x')).toBe(true);
    expect(table.find('/u01')?.readOnly).toBe(true);
  });

  it('remount on a non-mountpoint path overlays a read-only mount there', () => {
    const table = MountTable.fromHardware(HardwareProfile.workstation().storage);
    table.remount('/tmp/ro_dir', ['ro', 'remount']);
    expect(table.isReadOnly('/tmp/ro_dir/file')).toBe(true);
    expect(table.isReadOnly('/tmp/other')).toBe(false);
  });

  it('flips a read-only mount back to read-write', () => {
    const table = MountTable.fromHardware(HardwareProfile.workstation().storage);
    table.remount('/', ['ro', 'remount']);
    expect(table.isReadOnly('/etc/passwd')).toBe(true);
    table.remount('/', ['rw', 'remount']);
    expect(table.isReadOnly('/etc/passwd')).toBe(false);
  });

  it('creates a bind mount that inherits its origin', () => {
    const table = MountTable.fromHardware(HardwareProfile.workstation().storage);
    const entry = table.bind('/tmp/dir1', '/tmp/dir2');
    expect(entry.isBind).toBe(true);
    expect(entry.bindOrigin).toBe('/tmp/dir1');
    expect(table.find('/tmp/dir2')?.bindOrigin).toBe('/tmp/dir1');
  });

  it('umount removes a mount point', () => {
    const table = MountTable.fromHardware(HardwareProfile.server().storage);
    expect(table.umount('/u01')).toBe(true);
    expect(table.has('/u01')).toBe(false);
    expect(table.umount('/u01')).toBe(false);
  });

  it('renders mount output, /proc/mounts and mountinfo', () => {
    const table = new MountTable([
      new MountEntry({ source: '/dev/sda1', target: '/', fstype: 'ext4', options: ['rw', 'relatime', 'errors=remount-ro'] }),
    ]);
    expect(table.toMountOutput()).toContain('/dev/sda1 on / type ext4 (rw,relatime,errors=remount-ro)');
    expect(table.toProcMounts()).toContain('/dev/sda1 / ext4 rw,relatime,errors=remount-ro 0 0');
    expect(table.toMountInfo()).toContain('ext4 /dev/sda1');
  });

  it('filters mount output by filesystem type', () => {
    const table = MountTable.fromHardware(HardwareProfile.server().storage);
    const out = table.toMountOutput('ext4');
    expect(out).toContain('type ext4');
    expect(out).not.toContain('type proc');
  });
});
