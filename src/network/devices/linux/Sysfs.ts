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
  /** Interfaces the machine really carries — `/sys/class/net` lists them all. */
  liveInterfaces?: () => string[];
  /** MTU actually in force on the interface. */
  liveMtu?: (iface: string) => number | null;
  /** Real link state of the interface — drives `carrier` and `operstate`. */
  liveLink?: (iface: string) => { carrier: boolean; operUp: boolean } | null;
  /**
   * Les compteurs de l'interface, ceux que `ip -s link`, `ifconfig`,
   * `ethtool -S`, `/proc/net/dev` et `netstat -i` rendent deja. `/sys`
   * ne les portait pas, alors que c'est la que lit un agent de
   * supervision.
   */
  liveCounters?: (iface: string) => {
    framesIn: number; framesOut: number; bytesIn: number; bytesOut: number;
    errorsIn?: number; errorsOut?: number;
  } | null;
  /** Le numero que `ip link` affiche devant le nom. */
  liveIfIndex?: (iface: string) => number | null;
}

/**
 * Les vingt-quatre compteurs qu'une interface expose sous
 * `statistics/`, releves sur la machine reelle. Ce simulateur en mesure
 * six ; les dix-huit autres valent zero, ce qui est le compte JUSTE —
 * rien ici ne produit d'erreur de trame, de collision ni de depassement
 * de file.
 */
const STAT_ZEROS = [
  'multicast', 'rx_compressed', 'rx_crc_errors', 'rx_fifo_errors',
  'rx_frame_errors', 'rx_length_errors', 'rx_missed_errors', 'rx_nohandler',
  'rx_over_errors', 'tx_aborted_errors', 'tx_carrier_errors', 'tx_compressed',
  'tx_fifo_errors', 'tx_heartbeat_errors', 'tx_window_errors', 'collisions',
  'rx_dropped', 'tx_dropped',
];

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
    const link = (iface: string) => this.hooks.liveLink?.(iface) ?? { carrier: true, operUp: true };
    const vivantes = this.hooks.liveInterfaces?.() ?? [];
    const noms = vivantes.length > 0
      ? vivantes.filter((n) => n !== 'lo')
      : this.hw.adapters.map((a) => a.name);
    const profil = (nom: string) => this.hw.adapters.find((a) => a.name === nom);
    for (const nom of noms) {
      const base = `/sys/class/net/${nom}`;
      out.push(
        { path: `${base}/address`, read: () => `${(live?.(nom) ?? profil(nom)?.macAddress ?? '00:00:00:00:00:00').toLowerCase()}\n` },
        { path: `${base}/mtu`, read: () => `${this.hooks.liveMtu?.(nom) ?? 1500}\n` },
        { path: `${base}/operstate`, read: () => `${link(nom).operUp ? 'up' : 'down'}\n` },
        { path: `${base}/carrier`, read: () => `${link(nom).carrier ? 1 : 0}\n` },
        { path: `${base}/speed`, read: () => `${profil(nom)?.speedMbps ?? 1000}\n` },
        { path: `${base}/type`, read: () => '1\n' },
        { path: `${base}/arp`, read: () => '1\n' },
        { path: `${base}/flags`, read: () => '0x1003\n' },
        { path: `${base}/tx_queue_len`, read: () => '1000\n' },
        { path: `${base}/broadcast`, read: () => 'ff:ff:ff:ff:ff:ff\n' },
      );
      out.push(...this.netStatistics(nom));
    }
    out.push(
      { path: '/sys/class/net/lo/address', read: () => '00:00:00:00:00:00\n' },
      { path: '/sys/class/net/lo/mtu', read: () => '65536\n' },
      { path: '/sys/class/net/lo/operstate', read: () => 'unknown\n' },
      { path: '/sys/class/net/lo/type', read: () => '772\n' },
      { path: '/sys/class/net/lo/arp', read: () => '0\n' },
      ...this.netStatistics('lo'),
    );
    return out;
  }

  /**
   * `statistics/` et `ifindex` d'une interface. Les six compteurs
   * mesures viennent de la MEME source que `ethtool -S` et
   * `/proc/net/dev` : la machine ne compte ses trames qu'une fois.
   */
  private netStatistics(nom: string): SysfsLeaf[] {
    const base = `/sys/class/net/${nom}`;
    const c = () => this.hooks.liveCounters?.(nom)
      ?? { framesIn: 0, framesOut: 0, bytesIn: 0, bytesOut: 0 };
    const mesures: Array<[string, () => number]> = [
      ['rx_packets', () => c().framesIn],
      ['tx_packets', () => c().framesOut],
      ['rx_bytes', () => c().bytesIn],
      ['tx_bytes', () => c().bytesOut],
      ['rx_errors', () => c().errorsIn ?? 0],
      ['tx_errors', () => c().errorsOut ?? 0],
    ];
    return [
      { path: `${base}/ifindex`, read: () => `${this.hooks.liveIfIndex?.(nom) ?? 0}\n` },
      ...mesures.map(([n, lire]) => ({ path: `${base}/statistics/${n}`, read: () => `${lire()}\n` })),
      ...STAT_ZEROS.map((n) => ({ path: `${base}/statistics/${n}`, read: () => '0\n' })),
    ];
  }
}

function partitionNumber(name: string): number {
  const m = name.match(/(\d+)$/);
  return m ? Number(m[1]) : 0;
}
