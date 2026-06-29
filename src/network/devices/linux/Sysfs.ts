import type { HardwareProfile } from '../host/hardware';
import type { ChassisType } from '../host/hardware';

export interface SysfsLeaf {
  path: string;
  read: () => string;
}

const CHASSIS_CODE: Record<ChassisType, string> = {
  Desktop: '3',
  Tower: '7',
  Laptop: '9',
  Notebook: '10',
  'Rack Mount Chassis': '23',
  Other: '2',
};

export interface SysfsHooks {
  liveMac?: (iface: string) => string | null;
}

export class SysfsTree {
  private readonly get: () => HardwareProfile;
  private readonly hooks: SysfsHooks;

  constructor(hw: HardwareProfile | (() => HardwareProfile), hooks: SysfsHooks = {}) {
    this.get = typeof hw === 'function' ? hw : () => hw;
    this.hooks = hooks;
  }

  private get hw(): HardwareProfile {
    return this.get();
  }

  leaves(): SysfsLeaf[] {
    return [
      ...this.power(),
      ...this.dmi(),
      ...this.cpu(),
      ...this.block(),
      ...this.net(),
    ];
  }

  private power(): SysfsLeaf[] {
    return [
      { path: '/sys/power/state', read: () => 'freeze mem disk\n' },
      { path: '/sys/power/disk', read: () => '[platform] shutdown reboot suspend test_resume\n' },
    ];
  }

  private dmi(): SysfsLeaf[] {
    const base = '/sys/devices/virtual/dmi/id';
    return [
      { path: `${base}/product_uuid`, read: () => `${this.hw.productUuid}\n` },
      { path: `${base}/product_name`, read: () => `${this.hw.productName}\n` },
      { path: `${base}/product_serial`, read: () => `${this.hw.serialNumber}\n` },
      { path: `${base}/sys_vendor`, read: () => `${this.hw.manufacturer}\n` },
      { path: `${base}/chassis_type`, read: () => `${CHASSIS_CODE[this.hw.chassisType]}\n` },
      { path: `${base}/bios_vendor`, read: () => `${this.hw.firmware.vendor}\n` },
      { path: `${base}/bios_version`, read: () => `${this.hw.firmware.version}\n` },
      { path: `${base}/bios_date`, read: () => `${this.hw.firmware.releaseDate}\n` },
      { path: `${base}/board_vendor`, read: () => `${this.hw.mainboard.manufacturer}\n` },
      { path: `${base}/board_name`, read: () => `${this.hw.mainboard.productName}\n` },
    ];
  }

  private cpu(): SysfsLeaf[] {
    const range = () => {
      const n = this.hw.cpu.logicalCpus;
      return n > 1 ? `0-${n - 1}\n` : '0\n';
    };
    return [
      { path: '/sys/devices/system/cpu/online', read: range },
      { path: '/sys/devices/system/cpu/possible', read: range },
      { path: '/sys/devices/system/cpu/present', read: range },
      { path: '/sys/devices/system/cpu/offline', read: () => '\n' },
      { path: '/sys/devices/system/cpu/kernel_max', read: () => '8191\n' },
    ];
  }

  private block(): SysfsLeaf[] {
    const out: SysfsLeaf[] = [];
    for (const disk of this.hw.storage) {
      const base = `/sys/block/${disk.name}`;
      const sectors = Math.floor(disk.sizeBytes / 512);
      out.push(
        { path: `${base}/size`, read: () => `${sectors}\n` },
        { path: `${base}/removable`, read: () => '0\n' },
        { path: `${base}/ro`, read: () => '0\n' },
        { path: `${base}/queue/rotational`, read: () => `${disk.rotational ? 1 : 0}\n` },
        { path: `${base}/queue/logical_block_size`, read: () => '512\n' },
        { path: `${base}/device/model`, read: () => `${disk.model}\n` },
        { path: `${base}/device/vendor`, read: () => `${disk.vendor}\n` },
      );
      for (const part of disk.partitions) {
        const pbase = `${base}/${part.name}`;
        const psectors = Math.floor(part.sizeBytes / 512);
        out.push(
          { path: `${pbase}/size`, read: () => `${psectors}\n` },
          { path: `${pbase}/partition`, read: () => `${partitionNumber(part.name)}\n` },
          { path: `${pbase}/ro`, read: () => '0\n' },
        );
      }
    }
    return out;
  }

  private net(): SysfsLeaf[] {
    const out: SysfsLeaf[] = [];
    const live = this.hooks.liveMac;
    for (const a of this.hw.adapters) {
      const base = `/sys/class/net/${a.name}`;
      out.push(
        { path: `${base}/address`, read: () => `${(live?.(a.name) ?? a.macAddress).toLowerCase()}\n` },
        { path: `${base}/mtu`, read: () => '1500\n' },
        { path: `${base}/operstate`, read: () => 'up\n' },
        { path: `${base}/carrier`, read: () => '1\n' },
        { path: `${base}/speed`, read: () => `${a.speedMbps}\n` },
        { path: `${base}/type`, read: () => '1\n' },
        { path: `${base}/arp`, read: () => '1\n' },
        { path: `${base}/flags`, read: () => '0x1003\n' },
        { path: `${base}/tx_queue_len`, read: () => '1000\n' },
        { path: `${base}/broadcast`, read: () => 'ff:ff:ff:ff:ff:ff\n' },
      );
    }
    out.push(
      { path: '/sys/class/net/lo/address', read: () => '00:00:00:00:00:00\n' },
      { path: '/sys/class/net/lo/mtu', read: () => '65536\n' },
      { path: '/sys/class/net/lo/operstate', read: () => 'unknown\n' },
      { path: '/sys/class/net/lo/type', read: () => '772\n' },
      { path: '/sys/class/net/lo/arp', read: () => '0\n' },
    );
    return out;
  }
}

function partitionNumber(name: string): number {
  const m = name.match(/(\d+)$/);
  return m ? Number(m[1]) : 0;
}
