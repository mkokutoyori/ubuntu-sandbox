/**
 * CpuSpec — domain model of a host's central processing unit.
 *
 * A faithful descriptor of the silicon: vendor, micro-architecture identity
 * (family / model / stepping), the socket × core × thread topology, clock,
 * cache hierarchy and the instruction-set flag list. It is the single source
 * of truth behind `lscpu`, `/proc/cpuinfo`, `nproc` and the CPU lines of
 * Windows `systeminfo`.
 *
 * The class can render itself — `toLscpu()`, `toProcCpuinfo()` — so the
 * formatting lives with the data (the same approach `LinuxUserAccount` takes
 * with `toPasswdLine()`).
 */

export interface CpuSpecInit {
  vendor?: string;
  modelName?: string;
  architecture?: string;
  sockets?: number;
  coresPerSocket?: number;
  threadsPerCore?: number;
  clockMhz?: number;
  maxClockMhz?: number;
  minClockMhz?: number;
  bogoMips?: number;
  cpuFamily?: number;
  model?: number;
  stepping?: number;
  microcode?: string;
  l1dCacheKib?: number;
  l1iCacheKib?: number;
  l2CacheKib?: number;
  l3CacheKib?: number;
  physicalAddressBits?: number;
  virtualAddressBits?: number;
  byteOrder?: string;
  flags?: string[];
}

/** Instruction-set flags advertised by a stock virtualised Broadwell Xeon. */
const DEFAULT_CPU_FLAGS = [
  'fpu', 'vme', 'de', 'pse', 'tsc', 'msr', 'pae', 'mce', 'cx8', 'apic', 'sep',
  'mtrr', 'pge', 'mca', 'cmov', 'pat', 'pse36', 'clflush', 'mmx', 'fxsr',
  'sse', 'sse2', 'ss', 'ht', 'syscall', 'nx', 'pdpe1gb', 'rdtscp', 'lm',
  'constant_tsc', 'rep_good', 'nopl', 'xtopology', 'nonstop_tsc', 'cpuid',
  'pni', 'pclmulqdq', 'ssse3', 'fma', 'cx16', 'pcid', 'sse4_1', 'sse4_2',
  'x2apic', 'movbe', 'popcnt', 'aes', 'xsave', 'avx', 'f16c', 'rdrand',
  'hypervisor', 'lahf_lm', 'abm', '3dnowprefetch', 'invpcid_single', 'pti',
  'fsgsbase', 'bmi1', 'avx2', 'smep', 'bmi2', 'erms', 'invpcid', 'xsaveopt',
];

/** Width of the `lscpu` label column (label text + padding before the value). */
const LSCPU_LABEL_WIDTH = 33;

export class CpuSpec {
  vendor: string;
  modelName: string;
  architecture: string;
  /** Physical CPU packages. */
  sockets: number;
  /** Physical cores per socket. */
  coresPerSocket: number;
  /** Hardware threads per core (2 ⇒ SMT / Hyper-Threading). */
  threadsPerCore: number;
  /** Nominal clock in MHz. */
  clockMhz: number;
  maxClockMhz: number;
  minClockMhz: number;
  bogoMips: number;
  cpuFamily: number;
  model: number;
  stepping: number;
  microcode: string;
  l1dCacheKib: number;
  l1iCacheKib: number;
  l2CacheKib: number;
  l3CacheKib: number;
  physicalAddressBits: number;
  virtualAddressBits: number;
  byteOrder: string;
  flags: string[];

  constructor(init: CpuSpecInit = {}) {
    this.vendor = init.vendor ?? 'GenuineIntel';
    this.modelName = init.modelName ?? 'Intel(R) Xeon(R) CPU E5-2686 v4 @ 2.30GHz';
    this.architecture = init.architecture ?? 'x86_64';
    this.sockets = init.sockets ?? 1;
    this.coresPerSocket = init.coresPerSocket ?? 2;
    this.threadsPerCore = init.threadsPerCore ?? 1;
    this.clockMhz = init.clockMhz ?? 2300;
    this.maxClockMhz = init.maxClockMhz ?? this.clockMhz;
    this.minClockMhz = init.minClockMhz ?? this.clockMhz;
    this.bogoMips = init.bogoMips ?? 4600;
    this.cpuFamily = init.cpuFamily ?? 6;
    this.model = init.model ?? 79;
    this.stepping = init.stepping ?? 1;
    this.microcode = init.microcode ?? '0xb000040';
    this.l1dCacheKib = init.l1dCacheKib ?? 64;
    this.l1iCacheKib = init.l1iCacheKib ?? 64;
    this.l2CacheKib = init.l2CacheKib ?? 512;
    this.l3CacheKib = init.l3CacheKib ?? 46080;
    this.physicalAddressBits = init.physicalAddressBits ?? 46;
    this.virtualAddressBits = init.virtualAddressBits ?? 48;
    this.byteOrder = init.byteOrder ?? 'Little Endian';
    this.flags = init.flags ? [...init.flags] : [...DEFAULT_CPU_FLAGS];
  }

  // ─── Derived topology ──────────────────────────────────────────────────

  /** Total physical cores across every socket. */
  get physicalCores(): number {
    return this.sockets * this.coresPerSocket;
  }

  /** Total logical CPUs (what `nproc` and the scheduler see). */
  get logicalCpus(): number {
    return this.sockets * this.coresPerSocket * this.threadsPerCore;
  }

  /** Hardware threads sharing each socket (`/proc/cpuinfo` `siblings`). */
  get siblingsPerSocket(): number {
    return this.coresPerSocket * this.threadsPerCore;
  }

  // ─── Renderers ─────────────────────────────────────────────────────────

  /** Render the `lscpu` report. */
  toLscpu(): string {
    const row = (label: string, value: string): string =>
      label.padEnd(LSCPU_LABEL_WIDTH) + value;
    return [
      row('Architecture:', this.architecture),
      row('CPU op-mode(s):', '32-bit, 64-bit'),
      row('Byte Order:', this.byteOrder),
      row('Address sizes:', this.addressSizes()),
      row('CPU(s):', String(this.logicalCpus)),
      row('On-line CPU(s) list:', this.onlineCpuList()),
      row('Thread(s) per core:', String(this.threadsPerCore)),
      row('Core(s) per socket:', String(this.coresPerSocket)),
      row('Socket(s):', String(this.sockets)),
      row('Model name:', this.modelName),
      row('CPU MHz:', this.clockMhz.toFixed(3)),
      row('BogoMIPS:', this.bogoMips.toFixed(2)),
      row('L1d cache:', `${this.l1dCacheKib} KiB`),
      row('L1i cache:', `${this.l1iCacheKib} KiB`),
      row('L2 cache:', `${this.l2CacheKib} KiB`),
      row('L3 cache:', `${this.l3CacheKib} KiB`),
    ].join('\n');
  }

  /** Render `/proc/cpuinfo` — one block per logical CPU. */
  toProcCpuinfo(): string {
    const blocks: string[] = [];
    for (let cpu = 0; cpu < this.logicalCpus; cpu++) {
      const physicalId = Math.floor(cpu / this.siblingsPerSocket);
      const coreId = Math.floor((cpu % this.siblingsPerSocket) / this.threadsPerCore);
      const field = (key: string, value: string): string =>
        `${key.padEnd(16)}: ${value}`;
      blocks.push([
        field('processor', String(cpu)),
        field('vendor_id', this.vendor),
        field('cpu family', String(this.cpuFamily)),
        field('model', String(this.model)),
        field('model name', this.modelName),
        field('stepping', String(this.stepping)),
        field('microcode', this.microcode),
        field('cpu MHz', this.clockMhz.toFixed(3)),
        field('cache size', `${this.l3CacheKib} KB`),
        field('physical id', String(physicalId)),
        field('siblings', String(this.siblingsPerSocket)),
        field('core id', String(coreId)),
        field('cpu cores', String(this.coresPerSocket)),
        field('fpu', 'yes'),
        field('fpu_exception', 'yes'),
        field('cpuid level', '13'),
        field('wp', 'yes'),
        field('flags', this.flags.join(' ')),
        field('bogomips', this.bogoMips.toFixed(2)),
        field('clflush size', '64'),
        field('cache_alignment', '64'),
        field('address sizes', this.addressSizes()),
        'power management:',
      ].join('\n'));
    }
    return blocks.join('\n\n') + '\n';
  }

  private addressSizes(): string {
    return `${this.physicalAddressBits} bits physical, ${this.virtualAddressBits} bits virtual`;
  }

  /** `lscpu`-style online CPU list: `0` / `0,1` / `0-7`. */
  private onlineCpuList(): string {
    const n = this.logicalCpus;
    if (n <= 0) return '';
    if (n === 1) return '0';
    if (n === 2) return '0,1';
    return `0-${n - 1}`;
  }
}
