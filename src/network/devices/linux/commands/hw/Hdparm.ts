import type { HardwareProfile } from '@/network/devices/host/hardware/HardwareProfile';
import type { StorageDevice } from '@/network/devices/host/hardware/StorageDevice';

interface Options {
  identify: boolean;
  timingsBuffered: boolean;
  timingsCached: boolean;
  geometry: boolean;
  readOnly: boolean;
  writeCache: boolean;
  dma: boolean;
  verbose: boolean;
  targets: string[];
}

const KNOWN = new Set(['I', 't', 'T', 'g', 'r', 'W', 'd', 'v', 'h', 'V']);

export function cmdHdparm(profile: HardwareProfile, args: string[], isPrivileged: boolean): { output: string; exitCode: number } {
  if (!isPrivileged) return { output: 'hdparm: cannot open /dev/sda: Permission denied', exitCode: 1 };
  const parsed = parseArgs(args);
  if ('error' in parsed) return { output: parsed.error, exitCode: 1 };
  const opts = parsed.opts;

  if (opts.targets.length === 0) return { output: helpText(), exitCode: 0 };

  const sections: string[] = [];
  for (const t of opts.targets) {
    if (!t.startsWith('/dev/')) return { output: `hdparm: ${t}: not a block device`, exitCode: 1 };
    const disk = profile.storage.find(d => d.devicePath === t);
    if (!disk) return { output: `hdparm: ${t}: No such file or directory`, exitCode: 1 };
    sections.push(renderDisk(disk, opts));
  }
  return { output: sections.join('\n\n'), exitCode: 0 };
}

function parseArgs(args: string[]): { opts: Options } | { error: string } {
  const opts: Options = {
    identify: false, timingsBuffered: false, timingsCached: false,
    geometry: false, readOnly: false, writeCache: false, dma: false,
    verbose: false, targets: [],
  };
  for (const a of args) {
    if (a.startsWith('--')) {
      if (a === '--help') return { error: helpText() };
      return { error: `hdparm: unrecognized option '${a}'` };
    }
    if (a.startsWith('-')) {
      const body = a.slice(1);
      for (const ch of body) {
        if (!KNOWN.has(ch)) return { error: `hdparm: unrecognized option '-${ch}'` };
      }
      if (body.includes('I')) opts.identify = true;
      if (body.includes('t')) opts.timingsBuffered = true;
      if (body.includes('T')) opts.timingsCached = true;
      if (body.includes('g')) opts.geometry = true;
      if (body.includes('r')) opts.readOnly = true;
      if (body.includes('W')) opts.writeCache = true;
      if (body.includes('d')) opts.dma = true;
      if (body.includes('v')) opts.verbose = true;
      if (body === 'h') return { error: helpText() };
      if (body === 'V') return { error: 'hdparm v9.60' };
      continue;
    }
    opts.targets.push(a);
  }
  return { opts };
}

function renderDisk(disk: StorageDevice, opts: Options): string {
  const out: string[] = [`\n${disk.devicePath}:`];
  if (opts.identify) return renderIdentify(disk);
  if (opts.timingsBuffered) {
    out.push(` Timing buffered disk reads: 350 MB in  3.00 seconds = 116.50 MB/sec`);
    return out.join('\n');
  }
  if (opts.timingsCached) {
    out.push(` Timing cached reads:   8000 MB in  2.00 seconds = 4000.00 MB/sec`);
    return out.join('\n');
  }
  if (opts.geometry) {
    const sectors = Math.floor(disk.sizeBytes / 512);
    const cyl = Math.floor(sectors / (16 * 63));
    out.push(` geometry      = ${cyl}/16/63, sectors = ${sectors}, start = 0`);
    return out.join('\n');
  }
  if (opts.readOnly) {
    out.push(` readonly      =  0 (off)`);
    return out.join('\n');
  }
  if (opts.writeCache) {
    out.push(` write-caching =  1 (on)`);
    return out.join('\n');
  }
  if (opts.dma) {
    out.push(` using_dma     =  1 (on)`);
    return out.join('\n');
  }
  return renderSummary(disk);
}

function renderSummary(disk: StorageDevice): string {
  const sectors = Math.floor(disk.sizeBytes / 512);
  return [
    ``,
    `${disk.devicePath}:`,
    ` multcount     =  0 (off)`,
    ` IO_support    =  1 (32-bit)`,
    ` readonly      =  0 (off)`,
    ` readahead     = 256 (on)`,
    ` geometry      = ${Math.floor(sectors / (16 * 63))}/16/63, sectors = ${sectors}, start = 0`,
  ].join('\n');
}

function renderIdentify(disk: StorageDevice): string {
  return [
    ``,
    `${disk.devicePath}:`,
    ``,
    `ATA device, with non-removable media`,
    `\tModel Number:       ${disk.model}`,
    `\tSerial Number:      ${disk.serial}`,
    `\tFirmware Revision:  2.5+`,
    `\tTransport:          Serial, ATA8-AST`,
    `Standards:`,
    `\tUsed: unknown (minor revision code 0x0028)`,
    `\tSupported: 8 7 6 5`,
    `\tLikely used: 8`,
    `Configuration:`,
    `\tLogical\t\tmax\tcurrent`,
    `\tcylinders\t16383\t16383`,
    `\theads\t\t16\t16`,
    `\tsectors/track\t63\t63`,
    `\t--`,
    `\tCHS current addressable sectors:    16514064`,
    `\tLBA    user addressable sectors:   ${Math.floor(disk.sizeBytes / 512)}`,
    `\tLogical/Physical Sector size:           512 bytes`,
    `\tdevice size with M = 1024*1024:    ${Math.floor(disk.sizeBytes / 1024 ** 2)} MBytes`,
    `\tdevice size with M = 1000*1000:    ${Math.floor(disk.sizeBytes / 1000 ** 2)} MBytes`,
    `Capabilities:`,
    `\tLBA, IORDY(can be disabled)`,
    `\tQueue depth: 32`,
    `\tStandby timer values: spec'd by Standard, no device specific minimum`,
    `\tR/W multiple sector transfer: Max = 1\tCurrent = 1`,
    `\tDMA: mdma0 mdma1 mdma2 udma0 udma1 *udma5`,
    `\t     Cycle time: min=120ns recommended=120ns`,
    `Security:`,
    `\tMaster password revision code = 65534`,
    `\t\tsupported`,
    `\tnot\tenabled`,
    `\tnot\tlocked`,
    `\tnot\tfrozen`,
    `\tnot\texpired: security count`,
  ].join('\n');
}

function helpText(): string {
  return [
    'hdparm - get/set hard disk parameters - version v9.60',
    '',
    'Usage:  hdparm  [options] [device ...]',
    '',
    'Options:',
    ' -I   Detailed/current information directly from drive',
    ' -t   Perform device read timings',
    ' -T   Perform cache read timings',
    ' -g   Display drive geometry',
    ' -r   Get/set device readonly flag (DEPRECATED)',
    ' -W   Get/set the IDE/SATA drive\'s write-caching feature',
    ' -d   Get/set using_dma flag',
    ' -v   Defaults; same as -mcAdgkmur',
  ].join('\n');
}
