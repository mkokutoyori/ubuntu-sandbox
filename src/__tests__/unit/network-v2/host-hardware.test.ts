/**
 * Host hardware inventory — unit tests.
 *
 * Covers the first vertical of the host-management model:
 *   - the hardware domain model (CpuSpec, MemoryProfile, StorageDevice,
 *     NetworkAdapter, SystemBoard, HardwareProfile)
 *   - its filesystem coherence on Linux (/proc/cpuinfo, /proc/meminfo) and
 *     the commands it drives (lscpu, free, nproc)
 *   - its surfacing through Windows `systeminfo`
 */

import { describe, it, expect } from 'vitest';
import {
  CpuSpec, MemoryProfile, MemoryModule, humanKib,
  StorageDevice, DiskPartition, NetworkAdapter,
  Firmware, Mainboard, HardwareProfile,
} from '@/network/devices/host/hardware';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';

// ═══════════════════════════════════════════════════════════════════
// CpuSpec
// ═══════════════════════════════════════════════════════════════════

describe('CpuSpec', () => {
  it('derives the socket × core × thread topology', () => {
    const cpu = new CpuSpec({ sockets: 2, coresPerSocket: 4, threadsPerCore: 2 });
    expect(cpu.physicalCores).toBe(8);
    expect(cpu.logicalCpus).toBe(16);
    expect(cpu.siblingsPerSocket).toBe(8);
  });

  it('defaults to a dual-core virtualised Xeon', () => {
    const cpu = new CpuSpec();
    expect(cpu.logicalCpus).toBe(2);
    expect(cpu.modelName).toContain('Xeon');
  });

  it('renders an lscpu report', () => {
    const out = new CpuSpec().toLscpu();
    expect(out).toContain('Architecture:');
    expect(out).toContain('x86_64');
    expect(out).toContain('CPU(s):');
    expect(out).toContain('Model name:');
    expect(out).toContain('Intel(R) Xeon(R) CPU E5-2686 v4 @ 2.30GHz');
  });

  it('renders one /proc/cpuinfo block per logical CPU', () => {
    const out = new CpuSpec({ sockets: 1, coresPerSocket: 4, threadsPerCore: 1 }).toProcCpuinfo();
    const processors = out.match(/^processor\s+:/gm) ?? [];
    expect(processors).toHaveLength(4);
    expect(out).toContain('model name');
    expect(out).toContain('flags');
  });
});

// ═══════════════════════════════════════════════════════════════════
// MemoryProfile
// ═══════════════════════════════════════════════════════════════════

describe('MemoryProfile', () => {
  it('combines buffers and cache for the buff/cache column', () => {
    const mem = new MemoryProfile();
    expect(mem.buffCacheKib).toBe(mem.buffersKib + mem.cacheKib);
  });

  it('derives free swap', () => {
    const mem = new MemoryProfile({ swapTotalKib: 1000, swapUsedKib: 250 });
    expect(mem.swapFreeKib).toBe(750);
  });

  it('sums installed DIMM capacity', () => {
    const mem = new MemoryProfile({
      modules: [
        new MemoryModule({ sizeMib: 4096 }),
        new MemoryModule({ sizeMib: 4096 }),
      ],
    });
    expect(mem.installedKib).toBe(8192 * 1024);
  });

  it('renders the default free report', () => {
    const out = new MemoryProfile().toFree();
    expect(out).toContain('Mem:');
    expect(out).toContain('Swap:');
    expect(out).toContain('3981312');
    expect(out).toContain('total');
  });

  it('renders a human-readable free report', () => {
    expect(new MemoryProfile().toFree(true)).toContain('3.8Gi');
  });

  it('renders /proc/meminfo', () => {
    const out = new MemoryProfile().toProcMeminfo();
    expect(out).toContain('MemTotal:');
    expect(out).toContain('3981312 kB');
    expect(out).toContain('SwapTotal:');
  });
});

describe('humanKib', () => {
  it('formats zero as 0B', () => {
    expect(humanKib(0)).toBe('0B');
  });

  it('formats whole MiB without a decimal', () => {
    expect(humanKib(24576)).toBe('24Mi');
  });

  it('formats sub-10 GiB with one decimal', () => {
    expect(humanKib(3981312)).toBe('3.8Gi');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Storage / network / board
// ═══════════════════════════════════════════════════════════════════

describe('StorageDevice', () => {
  it('reports rotational only for spinning media', () => {
    expect(new StorageDevice({ name: 'sda', sizeBytes: 1, medium: 'HDD' }).rotational).toBe(true);
    expect(new StorageDevice({ name: 'nvme0n1', sizeBytes: 1, medium: 'NVMe' }).rotational).toBe(false);
  });

  it('exposes the device node path', () => {
    expect(new StorageDevice({ name: 'sda', sizeBytes: 1 }).devicePath).toBe('/dev/sda');
  });

  it('lists only mounted partitions', () => {
    const disk = new StorageDevice({
      name: 'sda', sizeBytes: 1,
      partitions: [
        new DiskPartition({ name: 'sda1', sizeBytes: 1, mountPoint: '/' }),
        new DiskPartition({ name: 'sda2', sizeBytes: 1 }),
      ],
    });
    expect(disk.mountedPartitions()).toHaveLength(1);
  });
});

describe('NetworkAdapter', () => {
  it('labels gigabit links', () => {
    expect(new NetworkAdapter({ name: 'eth0', macAddress: 'x', speedMbps: 1000 }).linkSpeedLabel)
      .toBe('1 Gbps');
    expect(new NetworkAdapter({ name: 'eth0', macAddress: 'x', speedMbps: 100 }).linkSpeedLabel)
      .toBe('100 Mbps');
  });
});

describe('SystemBoard', () => {
  it('summarises firmware', () => {
    expect(new Firmware({ vendor: 'SeaBIOS', version: '1.16.0' }).describe()).toBe('SeaBIOS 1.16.0');
  });

  it('defaults the mainboard manufacturer', () => {
    expect(new Mainboard().manufacturer).toBe('Intel Corporation');
  });
});

// ═══════════════════════════════════════════════════════════════════
// HardwareProfile aggregate
// ═══════════════════════════════════════════════════════════════════

describe('HardwareProfile', () => {
  it('builds a workstation preset with a desktop chassis', () => {
    const hw = HardwareProfile.workstation();
    expect(hw.chassisType).toBe('Desktop');
    expect(hw.storage).toHaveLength(1);
    expect(hw.cpu.logicalCpus).toBe(2);
  });

  it('builds a server preset with a rack chassis and a data disk', () => {
    const hw = HardwareProfile.server();
    expect(hw.chassisType).toBe('Rack Mount Chassis');
    expect(hw.storage).toHaveLength(2);
  });

  it('selects a preset by role', () => {
    expect(HardwareProfile.defaultFor('server').chassisType).toBe('Rack Mount Chassis');
    expect(HardwareProfile.defaultFor('workstation').chassisType).toBe('Desktop');
  });

  it('aggregates mounted partitions and total storage', () => {
    const hw = HardwareProfile.server();
    expect(hw.mountedPartitions().length).toBeGreaterThan(0);
    expect(hw.totalStorageBytes).toBe(hw.storage.reduce((s, d) => s + d.sizeBytes, 0));
  });
});

// ═══════════════════════════════════════════════════════════════════
// Linux integration — filesystem coherence & commands
// ═══════════════════════════════════════════════════════════════════

describe('Linux host hardware coherence', () => {
  it('exposes the hardware inventory on the device', () => {
    const srv = new LinuxServer('linux-server', 'SRV1');
    expect(srv.getHardware().cpu.logicalCpus).toBe(2);
  });

  it('drives lscpu from the inventory', async () => {
    const srv = new LinuxServer('linux-server', 'SRV1');
    const out = await srv.executeCommand('lscpu');
    expect(out).toContain('Model name:');
    expect(out).toContain(srv.getHardware().cpu.modelName);
  });

  it('drives free from the inventory', async () => {
    const srv = new LinuxServer('linux-server', 'SRV1');
    const out = await srv.executeCommand('free');
    expect(out).toContain('Mem:');
    expect(out).toContain(String(srv.getHardware().memory.totalKib));
  });

  it('reports the logical CPU count via nproc', async () => {
    const srv = new LinuxServer('linux-server', 'SRV1');
    expect((await srv.executeCommand('nproc')).trim()).toBe('2');
  });

  it('materialises /proc/cpuinfo coherently with lscpu', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const cpuinfo = await pc.executeCommand('cat /proc/cpuinfo');
    expect(cpuinfo).toContain('model name');
    expect(cpuinfo).toContain(pc.getHardware().cpu.modelName);
  });

  it('materialises /proc/meminfo coherently with free', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const meminfo = await pc.executeCommand('cat /proc/meminfo');
    expect(meminfo).toContain('MemTotal:');
    expect(meminfo).toContain(String(pc.getHardware().memory.totalKib));
  });

  it('re-specs lscpu / free / nproc / procfs coherently via setHardware', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const custom = new HardwareProfile({
      cpu: new CpuSpec({
        sockets: 2, coresPerSocket: 8, threadsPerCore: 2,
        modelName: 'AMD EPYC 7763 64-Core Processor',
      }),
      memory: new MemoryProfile({ totalKib: 16_000_000 }),
    });
    pc.setHardware(custom);

    // getHardware, the Linux commands and the procfs must all agree.
    expect(pc.getHardware()).toBe(custom);
    expect((await pc.executeCommand('nproc')).trim()).toBe('32');
    expect(await pc.executeCommand('lscpu')).toContain('AMD EPYC 7763');
    expect(await pc.executeCommand('free')).toContain('16000000');
    expect(await pc.executeCommand('cat /proc/cpuinfo')).toContain('AMD EPYC 7763');
    expect(await pc.executeCommand('cat /proc/meminfo')).toContain('16000000');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Windows integration — systeminfo
// ═══════════════════════════════════════════════════════════════════

describe('Windows host hardware coherence', () => {
  it('exposes the hardware inventory on the device', () => {
    const pc = new WindowsPC('windows-pc', 'WIN1');
    expect(pc.getHardware().cpu.logicalCpus).toBe(2);
  });

  it('reports processor, BIOS and memory in systeminfo', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN1');
    const out = await pc.executeCommand('systeminfo');
    expect(out).toContain('System Manufacturer:');
    expect(out).toContain('Processor(s):');
    expect(out).toContain('BIOS Version:');
    expect(out).toContain('Total Physical Memory:');
    expect(out).toContain('3,888 MB');
  });
});
