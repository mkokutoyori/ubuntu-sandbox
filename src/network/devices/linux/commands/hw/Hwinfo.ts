import type { HardwareProfile } from '@/network/devices/host/hardware/HardwareProfile';

const FILTERS = new Set(['cpu', 'disk', 'pci', 'usb', 'network', 'memory', 'keyboard', 'mouse', 'bios', 'monitor', 'sound']);

export function cmdHwinfo(profile: HardwareProfile, args: string[]): { output: string; exitCode: number } {
  let short = false;
  const filters: string[] = [];
  for (const a of args) {
    if (a === '--short') { short = true; continue; }
    if (a === '--help') return { output: helpText(), exitCode: 0 };
    if (a === '--version') return { output: 'hwinfo 21.81', exitCode: 0 };
    if (a.startsWith('--')) {
      const name = a.slice(2);
      if (FILTERS.has(name)) { filters.push(name); continue; }
      if (name === 'all') continue;
      return { output: `hwinfo: unrecognized option '${a}'`, exitCode: 1 };
    }
    if (a.startsWith('-')) return { output: `hwinfo: unrecognized option '${a}'`, exitCode: 1 };
  }

  const wanted = filters.length > 0 ? new Set(filters) : new Set([...FILTERS]);
  const blocks: string[] = [];
  if (wanted.has('cpu')) blocks.push(cpuBlock(profile));
  if (wanted.has('memory')) blocks.push(memoryBlock(profile));
  if (wanted.has('disk')) blocks.push(diskBlock(profile));
  if (wanted.has('pci')) blocks.push(pciBlock(profile));
  if (wanted.has('usb')) blocks.push(usbBlock(profile));
  if (wanted.has('network')) blocks.push(networkBlock(profile));
  if (wanted.has('keyboard')) blocks.push(keyboardBlock());
  if (wanted.has('mouse')) blocks.push(mouseBlock());
  if (wanted.has('bios')) blocks.push(biosBlock(profile));
  if (wanted.has('monitor')) blocks.push(monitorBlock());
  if (wanted.has('sound')) blocks.push(soundBlock());

  return { output: short ? blocks.map(short_).join('\n') : blocks.join('\n\n'), exitCode: 0 };
}

function short_(block: string): string {
  const head = block.split('\n', 1)[0];
  return head;
}

function cpuBlock(p: HardwareProfile): string {
  return [
    'cpu:',
    `  Hardware Class: cpu`,
    `  Model: "${p.cpu.modelName}"`,
    `  Vendor: "${p.cpu.vendor}"`,
    `  Clock: ${p.cpu.clockMhz} MHz`,
    `  BogoMips: ${p.cpu.bogoMips.toFixed(2)}`,
  ].join('\n');
}

function memoryBlock(p: HardwareProfile): string {
  return [
    'memory:',
    `  Hardware Class: memory`,
    `  Memory Range: 0x00000000-0x${(p.memory.totalKib * 1024 - 1).toString(16)}`,
    `  Memory Size: ${Math.ceil(p.memory.totalKib / 1024)} MiB`,
  ].join('\n');
}

function diskBlock(p: HardwareProfile): string {
  return [
    'disk:',
    ...p.storage.map(d => `  ${d.devicePath}: ${d.model} (${Math.ceil(d.sizeBytes / 1024 ** 3)} GB)`),
  ].join('\n');
}

function pciBlock(p: HardwareProfile): string {
  return [
    'pci:',
    ...p.pciBus.list().map(d => `  ${d.shortSlot()}: ${d.className} ${d.vendorName} ${d.deviceName}`),
  ].join('\n');
}

function usbBlock(p: HardwareProfile): string {
  return [
    'usb:',
    ...p.usbBus.list().map(d => `  Bus ${d.bus} Device ${d.device}: ${d.vendorName} ${d.productName}`),
  ].join('\n');
}

function networkBlock(p: HardwareProfile): string {
  return [
    'network:',
    ...p.adapters.map(a => `  ${a.name}: MAC ${a.macAddress}`),
  ].join('\n');
}

function keyboardBlock(): string {
  return 'keyboard:\n  Hardware Class: keyboard\n  Model: "Logitech Keyboard K120"';
}

function mouseBlock(): string {
  return 'mouse:\n  Hardware Class: mouse\n  Model: "Logitech M105 Optical Mouse"';
}

function biosBlock(p: HardwareProfile): string {
  return `bios:\n  Hardware Class: bios\n  Vendor: "${p.firmware.vendor}"\n  Version: "${p.firmware.version}"`;
}

function monitorBlock(): string {
  return 'monitor:\n  Hardware Class: monitor\n  Model: "Generic Monitor"';
}

function soundBlock(): string {
  return 'sound:\n  Hardware Class: sound\n  Model: "AC97 Audio"';
}

function helpText(): string {
  return [
    'Usage: hwinfo [OPTIONS]',
    '  --short              show only a summary',
    '  --cpu                show CPU info',
    '  --disk               show disk info',
    '  --pci                show PCI info',
    '  --usb                show USB info',
    '  --network            show network info',
    '  --memory             show memory info',
    '  --bios               show BIOS info',
    '  --version            show hwinfo version',
  ].join('\n');
}
