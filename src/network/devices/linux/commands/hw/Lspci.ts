import type { PciBus, PciDevice } from '@/network/devices/host/hardware/PciBus';
import { validatePciSlot } from '@/network/devices/host/hardware/PciBus';

type Verbosity = 0 | 1 | 2 | 3;

interface Options {
  verbosity: Verbosity;
  numeric: 0 | 1 | 2;
  tree: boolean;
  showKernel: boolean;
  showHex: boolean;
  fullDomain: boolean;
  slot: string | null;
  idFilter: { vendor: number | null; device: number | null } | null;
}

const KNOWN_SHORT = new Set(['v', 'n', 'nn', 'k', 't', 's', 'd', 'x', 'i', 'm', 'mm', 'D']);
const KNOWN_LONG = new Set(['version', 'help']);

export function cmdLspci(bus: PciBus, args: string[]): { output: string; exitCode: number } {
  const parsed = parseArgs(args);
  if ('error' in parsed) return { output: parsed.error, exitCode: 1 };
  const opts = parsed.opts;

  let devices: readonly PciDevice[] = bus.list();
  if (opts.slot) {
    const filtered = devices.filter(d => matchesSlot(d, opts.slot!));
    if (filtered.length === 0) return { output: '', exitCode: 0 };
    devices = filtered;
  }
  if (opts.idFilter) {
    devices = devices.filter(d =>
      (opts.idFilter!.vendor === null || d.vendorId === opts.idFilter!.vendor) &&
      (opts.idFilter!.device === null || d.deviceId === opts.idFilter!.device),
    );
  }

  if (opts.tree) return { output: renderTree(devices), exitCode: 0 };
  if (opts.verbosity > 0) return { output: renderVerbose(devices, opts), exitCode: 0 };
  if (opts.showHex) return { output: renderHex(devices), exitCode: 0 };
  if (opts.showKernel) return { output: renderShortWithKernel(devices, opts), exitCode: 0 };
  return { output: renderShort(devices, opts), exitCode: 0 };
}

function renderShortWithKernel(devices: readonly PciDevice[], opts: Options): string {
  const out: string[] = [];
  for (const d of devices) {
    out.push(renderShort([d], opts));
    if (d.kernelDriver) out.push(`\tKernel driver in use: ${d.kernelDriver}`);
    if (d.kernelModules.length > 0) out.push(`\tKernel modules: ${d.kernelModules.join(', ')}`);
  }
  return out.join('\n');
}

function parseArgs(args: string[]): { opts: Options } | { error: string } {
  const opts: Options = {
    verbosity: 0, numeric: 0, tree: false, showKernel: false, showHex: false,
    fullDomain: false, slot: null, idFilter: null,
  };
  let slotSeen = 0;
  let idSeen = 0;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const long = a.slice(2);
      if (!KNOWN_LONG.has(long)) return { error: `lspci: unrecognized option '${a}'` };
      if (long === 'version') return { error: `lspci version 3.7.0` };
      if (long === 'help') return { error: helpText() };
      continue;
    }
    if (!a.startsWith('-')) return { error: `lspci: unrecognized argument: ${a}` };
    const body = a.slice(1);
    if (body === 'v') { opts.verbosity = Math.min(3, opts.verbosity + 1) as Verbosity; continue; }
    if (body === 'vv') { opts.verbosity = 2; continue; }
    if (body === 'vvv') { opts.verbosity = 3; continue; }
    if (body === 'n') { opts.numeric = 1; continue; }
    if (body === 'nn') { opts.numeric = 2; continue; }
    if (body === 't') { opts.tree = true; continue; }
    if (body === 'k') { opts.showKernel = true; continue; }
    if (body === 'x' || body === 'xxx' || body === 'xxxx') { opts.showHex = true; continue; }
    if (body === 'D') { opts.fullDomain = true; continue; }
    if (body === 's') {
      slotSeen++;
      if (slotSeen > 1) return { error: `lspci: error: multiple slot filters` };
      const next = args[++i];
      if (!next) return { error: `lspci: error: -s requires an argument` };
      if (!validatePciSlot(next)) return { error: `lspci: error: invalid slot syntax: ${next}` };
      opts.slot = next;
      continue;
    }
    if (body === 'd') {
      idSeen++;
      if (idSeen > 1) return { error: `lspci: error: multiple ID filters` };
      const next = args[++i];
      if (!next) return { error: `lspci: error: -d requires an argument` };
      const parsed = parseIdFilter(next);
      if (!parsed) return { error: `lspci: error: invalid ID syntax: ${next}` };
      opts.idFilter = parsed;
      continue;
    }
    if (!KNOWN_SHORT.has(body)) return { error: `lspci: unrecognized option '-${body}'` };
  }
  return { opts };
}

function parseIdFilter(s: string): { vendor: number | null; device: number | null } | null {
  const parts = s.split(':');
  if (parts.length !== 2) return null;
  const vendor = parseHexField(parts[0]);
  const device = parseHexField(parts[1]);
  if (vendor === undefined || device === undefined) return null;
  return { vendor, device };
}

function parseHexField(s: string): number | null | undefined {
  if (s === '') return null;
  if (!/^[0-9a-fA-F]{1,4}$/.test(s)) return undefined;
  return parseInt(s, 16);
}

function matchesSlot(dev: PciDevice, slot: string): boolean {
  const s = slot.toLowerCase();
  return dev.shortSlot() === s || dev.fullSlot() === s;
}

function renderShort(devices: readonly PciDevice[], opts: Options): string {
  return devices.map(d => {
    const slot = opts.fullDomain ? d.fullSlot() : d.shortSlot();
    if (opts.numeric === 1) {
      return `${slot} ${d.classHex()}: ${d.vendorIdHex()}:${d.deviceIdHex()} (rev ${d.revision.toString(16).padStart(2, '0')})`;
    }
    const tail = d.revision > 0 ? ` (rev ${d.revision.toString(16).padStart(2, '0')})` : '';
    if (opts.numeric === 2) {
      return `${slot} ${d.className} [${d.classHex()}]: ${d.vendorName} ${d.deviceName} [${d.vendorIdHex()}:${d.deviceIdHex()}]${tail}`;
    }
    return `${slot} ${d.className}: ${d.vendorName} ${d.deviceName}${tail}`;
  }).join('\n');
}

function renderVerbose(devices: readonly PciDevice[], opts: Options): string {
  const blocks: string[] = [];
  for (const d of devices) {
    const lines: string[] = [];
    lines.push(`${d.shortSlot()} ${d.className}: ${d.vendorName} ${d.deviceName}` + (d.revision > 0 ? ` (rev ${d.revision.toString(16).padStart(2, '0')})` : ''));
    lines.push(`\tSubsystem: ${d.vendorName} ${d.subsystemName}`);
    if (d.irq > 0) lines.push(`\tFlags: bus master, fast devsel, latency 0, IRQ ${d.irq}`);
    else lines.push(`\tFlags: bus master, fast devsel, latency 0`);
    if (opts.verbosity >= 2 || opts.showKernel) {
      for (const c of d.capabilities) lines.push(`\tCapabilities: ${c}`);
    }
    if (opts.showKernel || opts.verbosity >= 1) {
      if (d.kernelDriver) lines.push(`\tKernel driver in use: ${d.kernelDriver}`);
      if (d.kernelModules.length > 0) lines.push(`\tKernel modules: ${d.kernelModules.join(', ')}`);
    }
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n');
}

function renderHex(devices: readonly PciDevice[]): string {
  return devices.map(d => {
    const head = `${d.shortSlot()} ${d.className}: ${d.vendorName} ${d.deviceName}`;
    const dump = Array.from({ length: 4 }, (_, row) => {
      const offset = (row * 16).toString(16).padStart(2, '0');
      const bytes = Array.from({ length: 16 }, () => '00').join(' ');
      return `${offset}: ${bytes}`;
    }).join('\n');
    return `${head}\n${dump}`;
  }).join('\n');
}

function renderTree(devices: readonly PciDevice[]): string {
  const lines: string[] = ['-[0000:00]-'];
  const byDevice = new Map<number, PciDevice[]>();
  for (const d of devices) {
    if (!byDevice.has(d.device)) byDevice.set(d.device, []);
    byDevice.get(d.device)!.push(d);
  }
  const slots = [...byDevice.keys()].sort((a, b) => a - b);
  for (const s of slots) {
    const fns = byDevice.get(s)!.sort((a, b) => a.function - b.function);
    for (const f of fns) {
      lines.push(`           +-${f.device.toString(16).padStart(2, '0')}.${f.function}`);
    }
  }
  return lines.join('\n');
}

function helpText(): string {
  return [
    'Usage: lspci [<switches>]',
    '',
    'Basic display modes:',
    '-mm\t\tProduce machine-readable output (single line per device)',
    '-t\t\tShow bus tree',
    '',
    'Display options:',
    '-v\t\tBe verbose (-vv or -vvv for higher verbosity)',
    '-k\t\tShow kernel drivers handling each device',
    '-x\t\tShow hex-dump of the standard part of the config space',
    '-n\t\tShow numeric ID',
    '-nn\t\tShow both textual and numeric ID',
    '',
    'Selection of devices:',
    '-s [[[[<domain>]:]<bus>]:][<slot>][.[<func>]]\tShow only devices in selected slots',
    '-d [<vendor>]:[<device>]\tShow only devices with specified ID',
  ].join('\n');
}
