import { describe, it, expect } from 'vitest';
import { SysfsTree } from '@/network/devices/linux/Sysfs';
import { HardwareProfile } from '@/network/devices/host/hardware';

function read(tree: SysfsTree, path: string): string | undefined {
  return tree.leaves().find((l) => l.path === path)?.read();
}

describe('SysfsTree', () => {
  it('exposes the kernel power state file', () => {
    const tree = new SysfsTree(HardwareProfile.workstation());
    expect(read(tree, '/sys/power/state')).toBe('freeze mem disk\n');
  });

  it('renders DMI identity from the hardware profile', () => {
    const hw = HardwareProfile.server();
    hw.productUuid = '11111111-2222-3333-4444-555555555555';
    hw.serialNumber = 'SN-DEADBEEF';
    const tree = new SysfsTree(hw);
    expect(read(tree, '/sys/devices/virtual/dmi/id/product_uuid')).toBe('11111111-2222-3333-4444-555555555555\n');
    expect(read(tree, '/sys/devices/virtual/dmi/id/product_serial')).toBe('SN-DEADBEEF\n');
    expect(read(tree, '/sys/devices/virtual/dmi/id/sys_vendor')).toBe('QEMU\n');
    expect(read(tree, '/sys/devices/virtual/dmi/id/chassis_type')).toBe('23\n');
  });

  it('derives the cpu topology range', () => {
    const tree = new SysfsTree(HardwareProfile.workstation());
    const n = HardwareProfile.workstation().cpu.logicalCpus;
    const expected = n > 1 ? `0-${n - 1}\n` : '0\n';
    expect(read(tree, '/sys/devices/system/cpu/online')).toBe(expected);
    expect(read(tree, '/sys/devices/system/cpu/present')).toBe(expected);
  });

  it('reflects block device geometry and rotational flag', () => {
    const tree = new SysfsTree(HardwareProfile.server());
    expect(read(tree, '/sys/block/sda/queue/rotational')).toBe('1\n');
    expect(read(tree, '/sys/block/sda/size')).toBe(`${Math.floor(50 * 1024 ** 3 / 512)}\n`);
    expect(read(tree, '/sys/block/sda/device/model')).toBe('QEMU HARDDISK\n');
    expect(read(tree, '/sys/block/sda/sda1/partition')).toBe('1\n');
    expect(read(tree, '/sys/block/sdb/sdb1/partition')).toBe('1\n');
  });

  it('marks SSD/NVMe media as non-rotational', () => {
    const hw = HardwareProfile.workstation();
    hw.storage[0].medium = 'SSD';
    const tree = new SysfsTree(hw);
    expect(read(tree, '/sys/block/sda/queue/rotational')).toBe('0\n');
  });

  it('renders the network class from the hardware adapters', () => {
    const tree = new SysfsTree(HardwareProfile.workstation());
    expect(read(tree, '/sys/class/net/eth0/address')).toBe('52:54:00:12:34:56\n');
    expect(read(tree, '/sys/class/net/eth0/operstate')).toBe('up\n');
    expect(read(tree, '/sys/class/net/lo/mtu')).toBe('65536\n');
  });
});
