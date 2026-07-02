import type { CpuSpec } from '@/network/devices/host/hardware/CpuSpec';

const KNOWN_SHORT = new Set(['p', 'J', 'e', 'a', 'b', 'c', 's', 'x', 'y', 'B', 'C', 'h', 'V']);
const KNOWN_LONG = new Set(['parse', 'json', 'extended', 'all', 'online', 'offline', 'bytes', 'caches', 'help', 'version', 'hex']);

export function cmdLscpu(cpu: CpuSpec, args: string[]): { output: string; exitCode: number } {
  let parseMode: 'none' | 'p' | 'J' | 'e' = 'none';
  let parseColumns: string[] | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-p' || a === '--parse') { parseMode = 'p'; continue; }
    if (a.startsWith('-p=') || a.startsWith('--parse=')) {
      parseMode = 'p';
      parseColumns = a.split('=')[1].split(',').map(s => s.toUpperCase());
      continue;
    }
    if (a === '-J' || a === '--json') { parseMode = 'J'; continue; }
    if (a === '-e' || a === '--extended') { parseMode = 'e'; continue; }
    if (a === '-h' || a === '--help') return { output: helpText(), exitCode: 0 };
    if (a === '-V' || a === '--version') return { output: 'lscpu from util-linux 2.37', exitCode: 0 };
    if (a.startsWith('--')) {
      const long = a.slice(2).split('=')[0];
      if (!KNOWN_LONG.has(long)) return { output: `lscpu: unrecognized option '${a}'`, exitCode: 1 };
      continue;
    }
    if (a.startsWith('-')) {
      for (const ch of a.slice(1)) {
        if (!KNOWN_SHORT.has(ch)) return { output: `lscpu: invalid option -- '${ch}'`, exitCode: 1 };
      }
      continue;
    }
    return { output: `lscpu: unexpected argument: ${a}`, exitCode: 1 };
  }

  if (parseMode === 'p') return { output: renderParse(cpu, parseColumns), exitCode: 0 };
  if (parseMode === 'J') return { output: renderJson(cpu), exitCode: 0 };
  if (parseMode === 'e') return { output: renderExtended(cpu), exitCode: 0 };
  return { output: renderHumanWithExtras(cpu), exitCode: 0 };
}

function renderHumanWithExtras(cpu: CpuSpec): string {
  const base = cpu.toLscpu();
  const extras = [
    'Virtualization:                  VT-x',
    'Hypervisor vendor:               KVM',
    'Virtualization type:             full',
  ];
  return [base, ...extras].join('\n');
}

function renderParse(cpu: CpuSpec, columns: string[] | null): string {
  const cols = columns ?? ['CPU', 'CORE', 'SOCKET', 'NODE'];
  const lines: string[] = [
    '# The following is the parsable format, which can be fed to other',
    '# programs. Each different item in every column has an unique ID',
    '# starting from zero.',
    `# ${cols.join(',')}`,
  ];
  for (let i = 0; i < cpu.logicalCpus; i++) {
    const socket = Math.floor(i / cpu.siblingsPerSocket);
    const core = Math.floor((i % cpu.siblingsPerSocket) / cpu.threadsPerCore);
    const row = cols.map(c => {
      switch (c) {
        case 'CPU': return String(i);
        case 'CORE': return String(core);
        case 'SOCKET': return String(socket);
        case 'NODE': return '0';
        default: return '';
      }
    });
    lines.push(row.join(','));
  }
  return lines.join('\n');
}

function renderJson(cpu: CpuSpec): string {
  return JSON.stringify({
    lscpu: [
      { field: 'Architecture:', data: cpu.architecture },
      { field: 'CPU op-mode(s):', data: '32-bit, 64-bit' },
      { field: 'Byte Order:', data: cpu.byteOrder },
      { field: 'CPU(s):', data: String(cpu.logicalCpus) },
      { field: 'Thread(s) per core:', data: String(cpu.threadsPerCore) },
      { field: 'Core(s) per socket:', data: String(cpu.coresPerSocket) },
      { field: 'Socket(s):', data: String(cpu.sockets) },
      { field: 'Model name:', data: cpu.modelName },
      { field: 'CPU MHz:', data: cpu.clockMhz.toFixed(3) },
      { field: 'L1d cache:', data: `${cpu.l1dCacheKib} KiB` },
      { field: 'L1i cache:', data: `${cpu.l1iCacheKib} KiB` },
      { field: 'L2 cache:', data: `${cpu.l2CacheKib} KiB` },
      { field: 'L3 cache:', data: `${cpu.l3CacheKib} KiB` },
    ],
  }, null, 2);
}

function renderExtended(cpu: CpuSpec): string {
  const lines: string[] = ['CPU NODE SOCKET CORE L1d:L1i:L2:L3 ONLINE'];
  for (let i = 0; i < cpu.logicalCpus; i++) {
    const socket = Math.floor(i / cpu.siblingsPerSocket);
    const core = Math.floor((i % cpu.siblingsPerSocket) / cpu.threadsPerCore);
    lines.push(`${i.toString().padStart(3, ' ')}    0      ${socket}    ${core} ${core}:${core}:${socket}:0 yes`);
  }
  return lines.join('\n');
}

function helpText(): string {
  return [
    'Usage: lscpu [options]',
    '',
    'Display information about the CPU architecture.',
    '',
    '  -a, --all               print online and offline CPUs (default for -e)',
    '  -b, --online            print online CPUs only (default for -p)',
    '  -B, --bytes             print sizes in bytes rather than in human readable format',
    '  -C, --caches[=<list>]   info about caches in extended readable format',
    '  -c, --offline           print offline CPUs only',
    '  -J, --json              use JSON for default or extended format',
    '  -e, --extended[=<list>] print out an extended readable format',
    '  -p, --parse[=<list>]    print out a parsable format',
    '  -s, --sysroot <dir>     use specified directory as system root',
    '  -x, --hex               print hexadecimal masks rather than lists of CPUs',
    '  -y, --physical          print physical instead of logical IDs',
    '      --output-all        print all available columns for -e, -p or -C',
    '',
    '  -h, --help              display this help',
    '  -V, --version           display version',
  ].join('\n');
}
