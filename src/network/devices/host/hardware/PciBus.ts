export interface PciDeviceInit {
  domain?: number;
  bus: number;
  device: number;
  function: number;
  vendorId: number;
  deviceId: number;
  subVendorId?: number;
  subDeviceId?: number;
  classCode: number;
  subClass: number;
  progIf?: number;
  revision?: number;
  vendorName: string;
  deviceName: string;
  subsystemName?: string;
  className: string;
  kernelDriver?: string;
  kernelModules?: string[];
  irq?: number;
  capabilities?: string[];
}

export class PciDevice {
  domain: number;
  bus: number;
  device: number;
  function: number;
  vendorId: number;
  deviceId: number;
  subVendorId: number;
  subDeviceId: number;
  classCode: number;
  subClass: number;
  progIf: number;
  revision: number;
  vendorName: string;
  deviceName: string;
  subsystemName: string;
  className: string;
  kernelDriver: string;
  kernelModules: string[];
  irq: number;
  capabilities: string[];

  constructor(init: PciDeviceInit) {
    this.domain = init.domain ?? 0;
    this.bus = init.bus;
    this.device = init.device;
    this.function = init.function;
    this.vendorId = init.vendorId;
    this.deviceId = init.deviceId;
    this.subVendorId = init.subVendorId ?? init.vendorId;
    this.subDeviceId = init.subDeviceId ?? init.deviceId;
    this.classCode = init.classCode;
    this.subClass = init.subClass;
    this.progIf = init.progIf ?? 0;
    this.revision = init.revision ?? 0;
    this.vendorName = init.vendorName;
    this.deviceName = init.deviceName;
    this.subsystemName = init.subsystemName ?? init.deviceName;
    this.className = init.className;
    this.kernelDriver = init.kernelDriver ?? '';
    this.kernelModules = init.kernelModules ?? [];
    this.irq = init.irq ?? 0;
    this.capabilities = init.capabilities ?? [];
  }

  shortSlot(): string {
    return `${hex(this.bus, 2)}:${hex(this.device, 2)}.${this.function}`;
  }

  fullSlot(): string {
    return `${hex(this.domain, 4)}:${hex(this.bus, 2)}:${hex(this.device, 2)}.${this.function}`;
  }

  vendorIdHex(): string { return hex(this.vendorId, 4); }
  deviceIdHex(): string { return hex(this.deviceId, 4); }
  classHex(): string { return `${hex(this.classCode, 2)}${hex(this.subClass, 2)}`; }
}

function hex(n: number, width: number): string {
  return n.toString(16).padStart(width, '0');
}

export class PciBus {
  private readonly devices: PciDevice[] = [];

  add(dev: PciDevice): void { this.devices.push(dev); }
  list(): readonly PciDevice[] { return this.devices; }

  bySlot(slot: string): PciDevice | undefined {
    const norm = normalizeSlot(slot);
    return this.devices.find(d => d.shortSlot() === norm || d.fullSlot() === norm);
  }

  byClass(prefix: string): PciDevice[] {
    return this.devices.filter(d => d.className.toLowerCase().includes(prefix.toLowerCase()));
  }

  filterById(vendor: number | null, device: number | null): PciDevice[] {
    return this.devices.filter(d =>
      (vendor === null || d.vendorId === vendor) &&
      (device === null || d.deviceId === device),
    );
  }

  static defaultInventory(): PciBus {
    const bus = new PciBus();
    bus.add(new PciDevice({
      bus: 0, device: 0, function: 0,
      vendorId: 0x8086, deviceId: 0x1237,
      classCode: 0x06, subClass: 0x00,
      vendorName: 'Intel Corporation',
      deviceName: '440FX - 82441FX PMC [Natoma]',
      className: 'Host bridge',
      revision: 0x02,
      kernelDriver: '',
    }));
    bus.add(new PciDevice({
      bus: 0, device: 1, function: 0,
      vendorId: 0x8086, deviceId: 0x7000,
      classCode: 0x06, subClass: 0x01,
      vendorName: 'Intel Corporation',
      deviceName: '82371SB PIIX3 ISA [Natoma/Triton II]',
      className: 'ISA bridge',
      kernelDriver: '',
    }));
    bus.add(new PciDevice({
      bus: 0, device: 1, function: 1,
      vendorId: 0x8086, deviceId: 0x7010,
      classCode: 0x01, subClass: 0x01,
      vendorName: 'Intel Corporation',
      deviceName: '82371SB PIIX3 IDE [Natoma/Triton II]',
      className: 'IDE interface',
      kernelDriver: 'ata_piix',
      kernelModules: ['ata_piix', 'ata_generic'],
      capabilities: ['[40] Power Management version 2'],
    }));
    bus.add(new PciDevice({
      bus: 0, device: 1, function: 3,
      vendorId: 0x8086, deviceId: 0x7113,
      classCode: 0x06, subClass: 0x80,
      vendorName: 'Intel Corporation',
      deviceName: '82371AB/EB/MB PIIX4 ACPI',
      className: 'Bridge',
      revision: 0x03,
      kernelDriver: 'piix4_smbus',
      kernelModules: ['i2c_piix4'],
    }));
    bus.add(new PciDevice({
      bus: 0, device: 2, function: 0,
      vendorId: 0x1234, deviceId: 0x1111,
      classCode: 0x03, subClass: 0x00,
      vendorName: 'QEMU',
      deviceName: 'Virtual Video Controller',
      className: 'VGA compatible controller',
      kernelDriver: 'bochs-drm',
      kernelModules: ['bochs_drm'],
      capabilities: ['[40] MSI: Enable+ Count=1/1 Maskable- 64bit+'],
    }));
    bus.add(new PciDevice({
      bus: 0, device: 3, function: 0,
      vendorId: 0x8086, deviceId: 0x100e,
      classCode: 0x02, subClass: 0x00,
      vendorName: 'Intel Corporation',
      deviceName: '82540EM Gigabit Ethernet Controller',
      className: 'Network controller',
      kernelDriver: 'e1000',
      kernelModules: ['e1000'],
      irq: 11,
      capabilities: [
        '[dc] Power Management version 2',
        '[e4] PCI-X non-bridge device',
      ],
    }));
    bus.add(new PciDevice({
      bus: 0, device: 4, function: 0,
      vendorId: 0x8086, deviceId: 0x2922,
      classCode: 0x01, subClass: 0x06,
      progIf: 0x01,
      vendorName: 'Intel Corporation',
      deviceName: '82801IR/IO/IH (ICH9R/DO/DH) 6 port SATA Controller [AHCI mode]',
      className: 'SATA controller',
      kernelDriver: 'ahci',
      kernelModules: ['ahci'],
      capabilities: ['[80] MSI: Enable+ Count=1/1 Maskable- 64bit+'],
    }));
    bus.add(new PciDevice({
      bus: 0, device: 5, function: 0,
      vendorId: 0x8086, deviceId: 0x265c,
      classCode: 0x0c, subClass: 0x03,
      progIf: 0x20,
      vendorName: 'Intel Corporation',
      deviceName: '82801FB/FBM/FR/FW/FRW (ICH6 Family) USB2 EHCI Controller',
      className: 'USB controller',
      kernelDriver: 'ehci_pci',
      kernelModules: ['ehci_pci'],
      capabilities: ['[50] Power Management version 2'],
    }));
    bus.add(new PciDevice({
      bus: 0, device: 6, function: 0,
      vendorId: 0x10ec, deviceId: 0x8086,
      classCode: 0x04, subClass: 0x03,
      vendorName: 'Intel Corporation',
      deviceName: '82801AA AC97 Audio Controller',
      className: 'Audio device',
      kernelDriver: 'snd_intel8x0',
      kernelModules: ['snd_intel8x0'],
    }));
    bus.add(new PciDevice({
      bus: 0, device: 7, function: 0,
      vendorId: 0x1af4, deviceId: 0x1001,
      classCode: 0x01, subClass: 0x00,
      vendorName: 'Red Hat, Inc.',
      deviceName: 'Virtio block device',
      className: 'SCSI storage controller',
      kernelDriver: 'virtio-pci',
      kernelModules: ['virtio_pci'],
    }));
    bus.add(new PciDevice({
      bus: 0, device: 8, function: 0,
      vendorId: 0x8086, deviceId: 0x244e,
      classCode: 0x06, subClass: 0x04,
      vendorName: 'Intel Corporation',
      deviceName: '82801 PCI Bridge',
      className: 'PCI bridge',
      kernelDriver: 'pcieport',
      kernelModules: ['pcieport'],
      capabilities: [
        '[40] Power Management version 2',
        '[50] MSI: Enable+ Count=1/1 Maskable- 64bit+',
        '[60] Express (v2) Root Port (Slot+), MSI 00',
        '\t\tLnkCap: Port #0, Speed 5GT/s, Width x4, ASPM L0s L1, Latency L0 <512ns',
        '\t\tLnkCtl: ASPM Disabled; Disabled- CommClk-',
      ],
    }));
    return bus;
  }
}

function normalizeSlot(slot: string): string {
  if (/^[0-9a-fA-F]{4}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}\.[0-7]$/.test(slot)) return slot.toLowerCase();
  if (/^[0-9a-fA-F]{2}:[0-9a-fA-F]{2}\.[0-7]$/.test(slot)) return slot.toLowerCase();
  return slot.toLowerCase();
}

export function validatePciSlot(slot: string): boolean {
  const m = /^(?:([0-9a-fA-F]{4}):)?([0-9a-fA-F]{2}):([0-9a-fA-F]{2})\.([0-7])$/.exec(slot);
  if (!m) return false;
  const bus = parseInt(m[2], 16);
  const dev = parseInt(m[3], 16);
  return bus <= 0xff && dev <= 0x1f;
}
