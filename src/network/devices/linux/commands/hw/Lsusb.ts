import type { UsbBus, UsbDevice } from '@/network/devices/host/hardware/UsbBus';
import { validateUsbSlot } from '@/network/devices/host/hardware/UsbBus';

interface Options {
  verbose: boolean;
  tree: boolean;
  busSlot: { bus: number; device: number } | null;
  idFilter: { vendor: number | null; product: number | null } | null;
  descriptorPath: string | null;
}

const KNOWN_SHORT = new Set(['v', 't', 's', 'd', 'D', 'V']);
const KNOWN_LONG = new Set(['verbose', 'tree', 'version', 'help']);

export function cmdLsusb(bus: UsbBus, args: string[]): { output: string; exitCode: number } {
  const parsed = parseArgs(args);
  if ('error' in parsed) return { output: parsed.error, exitCode: 1 };
  const opts = parsed.opts;

  let devices: readonly UsbDevice[] = bus.list();

  if (opts.descriptorPath) {
    const m = /^\/dev\/bus\/usb\/(\d+)\/(\d+)$/.exec(opts.descriptorPath);
    if (!m) return { output: `lsusb: cannot open ${opts.descriptorPath}: No such file or directory`, exitCode: 1 };
    const found = bus.bySlot(parseInt(m[1], 10), parseInt(m[2], 10));
    if (!found) return { output: `lsusb: cannot open ${opts.descriptorPath}: No such file or directory`, exitCode: 1 };
    return { output: renderVerbose([found]), exitCode: 0 };
  }

  if (opts.busSlot) {
    const slot = opts.busSlot;
    devices = devices.filter(d => d.bus === slot.bus && d.device === slot.device);
    if (devices.length === 0) return { output: `lsusb: bus ${slot.bus} device ${slot.device} not found`, exitCode: 1 };
  }
  if (opts.idFilter) {
    devices = devices.filter(d =>
      (opts.idFilter!.vendor === null || d.vendorId === opts.idFilter!.vendor) &&
      (opts.idFilter!.product === null || d.productId === opts.idFilter!.product),
    );
  }

  if (opts.tree) return { output: renderTree(bus, devices), exitCode: 0 };
  if (opts.verbose) return { output: renderVerbose(devices), exitCode: 0 };
  return { output: renderShort(devices), exitCode: 0 };
}

function parseArgs(args: string[]): { opts: Options } | { error: string } {
  const opts: Options = {
    verbose: false, tree: false, busSlot: null, idFilter: null, descriptorPath: null,
  };
  let slotSeen = 0;
  let idSeen = 0;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const long = a.slice(2);
      if (!KNOWN_LONG.has(long)) return { error: `lsusb: unrecognized option '${a}'` };
      if (long === 'verbose') { opts.verbose = true; continue; }
      if (long === 'tree') { opts.tree = true; continue; }
      if (long === 'version') return { error: `lsusb (usbutils) 014` };
      if (long === 'help') return { error: helpText() };
      continue;
    }
    if (!a.startsWith('-')) return { error: `lsusb: unrecognized argument: ${a}` };
    const body = a.slice(1);
    if (body === 'v') { opts.verbose = true; continue; }
    if (body === 't') { opts.tree = true; continue; }
    if (body === 'V') return { error: `lsusb (usbutils) 014` };
    if (body === 's') {
      slotSeen++;
      if (slotSeen > 1) return { error: `lsusb: error: multiple slot filters` };
      const next = args[++i];
      if (!next) return { error: `lsusb: error: -s requires an argument` };
      if (!validateUsbSlot(next)) return { error: `lsusb: error: invalid bus/dev syntax: ${next}` };
      const parts = next.split(':').map(n => parseInt(n, 10));
      opts.busSlot = { bus: parts[0], device: parts[1] };
      continue;
    }
    if (body === 'd') {
      idSeen++;
      if (idSeen > 1) return { error: `lsusb: error: multiple ID filters` };
      const next = args[++i];
      if (!next) return { error: `lsusb: error: -d requires an argument` };
      const parsed = parseIdFilter(next);
      if (!parsed) return { error: `lsusb: error: invalid ID syntax: ${next}` };
      opts.idFilter = parsed;
      continue;
    }
    if (body === 'D') {
      const next = args[++i];
      if (!next) return { error: `lsusb: error: -D requires a path` };
      opts.descriptorPath = next;
      continue;
    }
    if (!KNOWN_SHORT.has(body)) return { error: `lsusb: unrecognized option '-${body}'` };
  }
  return { opts };
}

function parseIdFilter(s: string): { vendor: number | null; product: number | null } | null {
  const parts = s.split(':');
  if (parts.length !== 2) return null;
  const vendor = parseHexField(parts[0]);
  const product = parseHexField(parts[1]);
  if (vendor === undefined || product === undefined) return null;
  return { vendor, product };
}

function parseHexField(s: string): number | null | undefined {
  if (s === '') return null;
  if (!/^[0-9a-fA-F]{1,4}$/.test(s)) return undefined;
  return parseInt(s, 16);
}

function renderShort(devices: readonly UsbDevice[]): string {
  return devices.map(d => {
    const id = `${d.vendorId.toString(16).padStart(4, '0')}:${d.productId.toString(16).padStart(4, '0')}`;
    return `Bus ${d.bus.toString().padStart(3, '0')} Device ${d.device.toString().padStart(3, '0')}: ID ${id} ${d.vendorName} ${d.productName}`;
  }).join('\n');
}

function renderVerbose(devices: readonly UsbDevice[]): string {
  const blocks: string[] = [];
  for (const d of devices) {
    const head = `Bus ${d.bus.toString().padStart(3, '0')} Device ${d.device.toString().padStart(3, '0')}: ID ${d.vendorId.toString(16).padStart(4, '0')}:${d.productId.toString(16).padStart(4, '0')} ${d.vendorName} ${d.productName}`;
    const lines: string[] = [head, 'Device Descriptor:'];
    lines.push(`  bLength                ${'18'}`);
    lines.push(`  bDescriptorType         1`);
    lines.push(`  bcdUSB               ${bcdToString(d.bcdUsb)}`);
    lines.push(`  bDeviceClass         ${pad3(d.classCode)} ${d.className}`);
    lines.push(`  bDeviceSubClass      ${pad3(d.subClass)}`);
    lines.push(`  bDeviceProtocol      ${pad3(d.protocol)}`);
    lines.push(`  bMaxPacketSize0        64`);
    lines.push(`  idVendor           ${hex4(d.vendorId)} ${d.vendorName}`);
    lines.push(`  idProduct          ${hex4(d.productId)} ${d.productName}`);
    lines.push(`  bcdDevice            ${bcdToString(0x0100)}`);
    lines.push(`  iManufacturer           1 ${d.manufacturer}`);
    lines.push(`  iProduct                2 ${d.productName}`);
    lines.push(`  iSerial                 3 ${d.serial}`);
    lines.push(`  bNumConfigurations      1`);
    lines.push(`  Configuration Descriptor:`);
    lines.push(`    bLength                 9`);
    lines.push(`    bDescriptorType         2`);
    lines.push(`    wTotalLength       ${(34).toString().padStart(4, '0')}`);
    lines.push(`    bNumInterfaces          ${d.interfaces.length}`);
    lines.push(`    bConfigurationValue     1`);
    lines.push(`    iConfiguration          0`);
    lines.push(`    bmAttributes         0x80`);
    lines.push(`      (Bus Powered)`);
    lines.push(`    MaxPower              ${d.maxPower}mA`);
    for (const iface of d.interfaces) {
      lines.push(`    Interface Descriptor:`);
      lines.push(`      bLength                 9`);
      lines.push(`      bDescriptorType         4`);
      lines.push(`      bInterfaceNumber        ${iface.number}`);
      lines.push(`      bAlternateSetting       ${iface.alternateSetting ?? 0}`);
      lines.push(`      bNumEndpoints           ${iface.endpoints?.length ?? 0}`);
      lines.push(`      bInterfaceClass       ${pad3(d.classCode)} ${iface.className}`);
      lines.push(`      bInterfaceSubClass    ${pad3(iface.subClass ?? 0)}`);
      lines.push(`      bInterfaceProtocol    ${pad3(iface.protocol ?? 0)}`);
      lines.push(`      iInterface              0`);
      for (const ep of iface.endpoints ?? []) {
        lines.push(`      Endpoint Descriptor:`);
        lines.push(`        bLength                 7`);
        lines.push(`        bDescriptorType         5`);
        lines.push(`        bEndpointAddress     0x${ep.address.toString(16).padStart(2, '0')} EP ${ep.address & 0x0f} ${ep.direction}`);
        lines.push(`        bmAttributes            ${ep.transferType === 'Interrupt' ? 3 : 2}`);
        lines.push(`          Transfer Type            ${ep.transferType}`);
        lines.push(`        wMaxPacketSize     0x${ep.maxPacketSize.toString(16).padStart(4, '0')}  1x ${ep.maxPacketSize} bytes`);
        lines.push(`        bInterval               ${ep.interval ?? 0}`);
      }
    }
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n');
}

function renderTree(bus: UsbBus, _filter: readonly UsbDevice[]): string {
  const hubs = bus.list().filter(d => d.isHub);
  const others = bus.list().filter(d => !d.isHub);
  const lines: string[] = [];
  for (const h of hubs) {
    lines.push(`/:  Bus ${h.bus.toString().padStart(2, '0')}.Port 001: Dev 1, Class=Hub, Driver=hub/2p, ${h.speed}`);
    for (const d of others.filter(o => o.parentBus === h.bus)) {
      lines.push(`    |__ Port ${(d.parentPort ?? 1).toString().padStart(3, '0')}: Dev ${d.device}, If 0, Class=HID, Driver=usbhid, ${d.speed}`);
    }
  }
  return lines.join('\n');
}

function bcdToString(bcd: number): string {
  const major = (bcd >> 8) & 0xff;
  const minor = bcd & 0xff;
  return `${major.toString(16)}.${minor.toString(16).padStart(2, '0')}`;
}

function pad3(n: number): string { return n.toString().padStart(3, '0'); }
function hex4(n: number): string { return `0x${n.toString(16).padStart(4, '0')}`; }

function helpText(): string {
  return [
    'Usage: lsusb [options]...',
    'List USB devices',
    '  -v, --verbose',
    '      Increase verbosity (show descriptors)',
    '  -s [[bus]:][devnum]',
    '      Show only devices with specified device and/or bus numbers',
    '  -d vendor:[product]',
    '      Show only devices with the specified vendor and product ID',
    '  -D device',
    '      Selects which device lsusb will examine',
    '  -t, --tree',
    '      Dump the physical USB device hierarchy as a tree',
    '  -V, --version',
    '      Show version of program',
  ].join('\n');
}
