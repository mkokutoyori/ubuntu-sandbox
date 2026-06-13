/**
 * MemoryProfile — domain model of a host's RAM and swap.
 *
 * Two layers are modelled:
 *   - the *physical* inventory — the populated DIMM slots (`MemoryModule[]`),
 *     the kind of detail `dmidecode -t memory` reports;
 *   - the *kernel* accounting — `MemTotal`, free, buffers/cache, available,
 *     swap — the figures `free` and `/proc/meminfo` expose.
 *
 * It is the single source of truth behind `free` and `/proc/meminfo`, and
 * the memory lines of Windows `systeminfo`.
 */

// ─── Physical memory module (value object) ──────────────────────────────

export interface MemoryModuleInit {
  sizeMib: number;
  type?: string;
  speedMtps?: number;
  manufacturer?: string;
  locator?: string;
  formFactor?: string;
}

/** One populated memory slot — a DIMM. Immutable value object. */
export class MemoryModule {
  readonly sizeMib: number;
  readonly type: string;
  readonly speedMtps: number;
  readonly manufacturer: string;
  readonly locator: string;
  readonly formFactor: string;

  constructor(init: MemoryModuleInit) {
    this.sizeMib = init.sizeMib;
    this.type = init.type ?? 'DDR4';
    this.speedMtps = init.speedMtps ?? 2400;
    this.manufacturer = init.manufacturer ?? 'QEMU';
    this.locator = init.locator ?? 'DIMM 0';
    this.formFactor = init.formFactor ?? 'DIMM';
  }

  /** Human label, e.g. `4096 MB DDR4 @ 2400 MT/s`. */
  describe(): string {
    return `${this.sizeMib} MB ${this.type} @ ${this.speedMtps} MT/s`;
  }
}

// ─── Memory profile (kernel accounting + inventory) ─────────────────────

export interface MemoryProfileInit {
  totalKib?: number;
  usedKib?: number;
  freeKib?: number;
  sharedKib?: number;
  buffersKib?: number;
  cacheKib?: number;
  availableKib?: number;
  swapTotalKib?: number;
  swapUsedKib?: number;
  modules?: MemoryModule[];
}

/** Free-report column layout: an 8-wide label, then 12-wide value columns. */
const FREE_LABEL_WIDTH = 8;
const FREE_COLUMN_WIDTH = 12;

export class MemoryProfile {
  /** Kernel-visible RAM (`MemTotal`) — below installed RAM by firmware reserve. */
  totalKib: number;
  usedKib: number;
  freeKib: number;
  sharedKib: number;
  buffersKib: number;
  cacheKib: number;
  availableKib: number;
  swapTotalKib: number;
  swapUsedKib: number;
  /** Physically installed DIMMs. */
  modules: MemoryModule[];

  constructor(init: MemoryProfileInit = {}) {
    this.totalKib = init.totalKib ?? 3981312;
    this.usedKib = init.usedKib ?? 1258496;
    this.freeKib = init.freeKib ?? 1468416;
    this.sharedKib = init.sharedKib ?? 24576;
    this.buffersKib = init.buffersKib ?? 204800;
    this.cacheKib = init.cacheKib ?? 1049600;
    this.availableKib = init.availableKib ?? 2519040;
    this.swapTotalKib = init.swapTotalKib ?? 2097152;
    this.swapUsedKib = init.swapUsedKib ?? 0;
    this.modules = init.modules ?? [
      new MemoryModule({ sizeMib: 4096, locator: 'DIMM 0' }),
    ];
  }

  /** Combined buffers + page cache (`free`'s `buff/cache` column). */
  get buffCacheKib(): number {
    return this.buffersKib + this.cacheKib;
  }

  /** Reserve `kib` of shared memory (e.g. an SGA segment): it shows up in
   *  `free`'s shared + used columns and shrinks free/available. */
  reserveShared(kib: number): void {
    const amount = Math.max(0, Math.min(kib, this.freeKib + this.availableKib));
    this.sharedKib += amount;
    this.usedKib += amount;
    this.freeKib = Math.max(0, this.freeKib - amount);
    this.availableKib = Math.max(0, this.availableKib - amount);
  }

  /** Release a previously reserved shared-memory segment. */
  releaseShared(kib: number): void {
    const amount = Math.max(0, Math.min(kib, this.sharedKib));
    this.sharedKib -= amount;
    this.usedKib = Math.max(0, this.usedKib - amount);
    this.freeKib += amount;
    this.availableKib += amount;
  }

  /** Free swap. */
  get swapFreeKib(): number {
    return this.swapTotalKib - this.swapUsedKib;
  }

  /** Total physically installed RAM across every DIMM, in KiB. */
  get installedKib(): number {
    return this.modules.reduce((sum, m) => sum + m.sizeMib * 1024, 0);
  }

  // ─── Renderers ─────────────────────────────────────────────────────────

  /** Render the `free` report. `unit` selects the conversion divisor
   *  (KiB by default; matches `-b/-k/-m/-g` flags); `human` switches to
   *  `-h` (auto units); `wide` is `-w`; `total` is `-t`. */
  toFree(human = false, wide = false, unit: 'b' | 'k' | 'm' | 'g' = 'k', total = false): string {
    const divide = (kib: number): number => {
      switch (unit) {
        case 'b': return kib * 1024;
        case 'm': return Math.round(kib / 1024);
        case 'g': return Math.round(kib / 1024 / 1024);
        default:  return kib;
      }
    };
    const fmt = human
      ? (kib: number) => humanKib(kib)
      : (kib: number) => String(divide(kib));
    const memCols = wide
      ? ['total', 'used', 'free', 'shared', 'buffers', 'cache', 'available']
      : ['total', 'used', 'free', 'shared', 'buff/cache', 'available'];
    const memValues = wide
      ? [this.totalKib, this.usedKib, this.freeKib, this.sharedKib,
         this.buffersKib, this.cacheKib, this.availableKib]
      : [this.totalKib, this.usedKib, this.freeKib, this.sharedKib,
         this.buffCacheKib, this.availableKib];

    const header = ''.padEnd(FREE_LABEL_WIDTH) +
      memCols.map((c) => c.padStart(FREE_COLUMN_WIDTH)).join('');
    const memRow = 'Mem:'.padEnd(FREE_LABEL_WIDTH) +
      memValues.map((v) => fmt(v).padStart(FREE_COLUMN_WIDTH)).join('');
    const swapRow = 'Swap:'.padEnd(FREE_LABEL_WIDTH) +
      [this.swapTotalKib, this.swapUsedKib, this.swapFreeKib]
        .map((v) => fmt(v).padStart(FREE_COLUMN_WIDTH)).join('');

    const rows = [header, memRow, swapRow];
    if (total) {
      const totalKib = this.totalKib + this.swapTotalKib;
      const usedKib = this.usedKib + this.swapUsedKib;
      const freeKib = this.freeKib + this.swapFreeKib;
      rows.push('Total:'.padEnd(FREE_LABEL_WIDTH) +
        [totalKib, usedKib, freeKib]
          .map((v) => fmt(v).padStart(FREE_COLUMN_WIDTH)).join(''));
    }
    return rows.join('\n');
  }

  /** Render `/proc/meminfo`. */
  toProcMeminfo(): string {
    const line = (key: string, kib: number): string =>
      `${(key + ':').padEnd(16)}${String(kib).padStart(8)} kB`;
    return [
      line('MemTotal', this.totalKib),
      line('MemFree', this.freeKib),
      line('MemAvailable', this.availableKib),
      line('Buffers', this.buffersKib),
      line('Cached', this.cacheKib),
      line('SwapCached', 0),
      line('Active', Math.round(this.usedKib * 0.6)),
      line('Inactive', Math.round(this.usedKib * 0.4)),
      line('SwapTotal', this.swapTotalKib),
      line('SwapFree', this.swapFreeKib),
      line('Shmem', this.sharedKib),
    ].join('\n') + '\n';
  }
}

/** Format a KiB count the way `free -h` does: `0B`, `24Mi`, `3.8Gi`. */
export function humanKib(kib: number): string {
  if (kib === 0) return '0B';
  const units: Array<[suffix: string, kibPerUnit: number]> = [
    ['Ti', 1024 * 1024 * 1024],
    ['Gi', 1024 * 1024],
    ['Mi', 1024],
    ['Ki', 1],
  ];
  for (const [suffix, kibPerUnit] of units) {
    if (kib >= kibPerUnit) {
      const value = kib / kibPerUnit;
      const text = value >= 10 ? String(Math.round(value)) : value.toFixed(1);
      return `${text}${suffix}`;
    }
  }
  return `${kib}Ki`;
}
