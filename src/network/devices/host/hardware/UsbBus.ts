export interface UsbEndpointInit {
  address: number;
  direction: 'IN' | 'OUT';
  transferType: 'Control' | 'Bulk' | 'Interrupt' | 'Isochronous';
  maxPacketSize: number;
  interval?: number;
}

export interface UsbInterfaceInit {
  number: number;
  alternateSetting?: number;
  className: string;
  subClass?: number;
  protocol?: number;
  endpoints?: UsbEndpointInit[];
  driver?: string;
}

export interface UsbDeviceInit {
  bus: number;
  device: number;
  vendorId: number;
  productId: number;
  vendorName: string;
  productName: string;
  serial?: string;
  manufacturer?: string;
  classCode?: number;
  subClass?: number;
  protocol?: number;
  className?: string;
  bcdUsb?: number;
  speed?: '1.5MBit/s' | '12MBit/s' | '480MBit/s' | '5000MBit/s';
  maxPower?: number;
  interfaces?: UsbInterfaceInit[];
  isHub?: boolean;
  parentBus?: number;
  parentPort?: number;
}

export class UsbDevice {
  bus: number;
  device: number;
  vendorId: number;
  productId: number;
  vendorName: string;
  productName: string;
  serial: string;
  manufacturer: string;
  classCode: number;
  subClass: number;
  protocol: number;
  className: string;
  bcdUsb: number;
  speed: string;
  maxPower: number;
  interfaces: UsbInterfaceInit[];
  isHub: boolean;
  parentBus: number | null;
  parentPort: number | null;

  constructor(init: UsbDeviceInit) {
    this.bus = init.bus;
    this.device = init.device;
    this.vendorId = init.vendorId;
    this.productId = init.productId;
    this.vendorName = init.vendorName;
    this.productName = init.productName;
    this.serial = init.serial ?? '';
    this.manufacturer = init.manufacturer ?? init.vendorName;
    this.classCode = init.classCode ?? 0;
    this.subClass = init.subClass ?? 0;
    this.protocol = init.protocol ?? 0;
    this.className = init.className ?? '';
    this.bcdUsb = init.bcdUsb ?? 0x0200;
    this.speed = init.speed ?? '480MBit/s';
    this.maxPower = init.maxPower ?? 100;
    this.interfaces = init.interfaces ?? [];
    this.isHub = init.isHub ?? false;
    this.parentBus = init.parentBus ?? null;
    this.parentPort = init.parentPort ?? null;
  }

  shortId(): string {
    return `${hex(this.vendorId, 4)}:${hex(this.productId, 4)}`;
  }
}

function hex(n: number, width: number): string {
  return n.toString(16).padStart(width, '0');
}

export class UsbBus {
  private readonly devices: UsbDevice[] = [];

  add(dev: UsbDevice): void { this.devices.push(dev); }
  list(): readonly UsbDevice[] { return this.devices; }

  bySlot(bus: number, device: number): UsbDevice | undefined {
    return this.devices.find(d => d.bus === bus && d.device === device);
  }

  filterById(vendor: number | null, product: number | null): UsbDevice[] {
    return this.devices.filter(d =>
      (vendor === null || d.vendorId === vendor) &&
      (product === null || d.productId === product),
    );
  }

  static defaultInventory(): UsbBus {
    const bus = new UsbBus();
    bus.add(new UsbDevice({
      bus: 1, device: 1,
      vendorId: 0x1d6b, productId: 0x0002,
      vendorName: 'Linux Foundation', productName: '2.0 Root Hub',
      manufacturer: 'Linux 5.15.0 ehci_hcd',
      classCode: 0x09, subClass: 0x00, protocol: 0x00,
      className: 'Hub', bcdUsb: 0x0200, speed: '480MBit/s', isHub: true,
      interfaces: [{ number: 0, className: 'Hub', endpoints: [{ address: 0x81, direction: 'IN', transferType: 'Interrupt', maxPacketSize: 4, interval: 12 }], driver: 'hub' }],
    }));
    bus.add(new UsbDevice({
      bus: 2, device: 1,
      vendorId: 0x1d6b, productId: 0x0003,
      vendorName: 'Linux Foundation', productName: '3.0 Root Hub',
      manufacturer: 'Linux 5.15.0 xhci_hcd',
      classCode: 0x09, subClass: 0x00, protocol: 0x03,
      className: 'Hub', bcdUsb: 0x0300, speed: '5000MBit/s', isHub: true,
      interfaces: [{ number: 0, className: 'Hub', endpoints: [{ address: 0x81, direction: 'IN', transferType: 'Interrupt', maxPacketSize: 4, interval: 12 }], driver: 'hub' }],
    }));
    bus.add(new UsbDevice({
      bus: 1, device: 2,
      vendorId: 0x046d, productId: 0xc31c,
      vendorName: 'Logitech, Inc.', productName: 'Keyboard K120',
      manufacturer: 'Logitech', serial: 'NoSerial',
      classCode: 0x03, subClass: 0x01, protocol: 0x01,
      className: 'Human Interface Device',
      bcdUsb: 0x0110, speed: '1.5MBit/s', maxPower: 90,
      parentBus: 1, parentPort: 1,
      interfaces: [{
        number: 0, className: 'Human Interface Device',
        subClass: 0x01, protocol: 0x01, driver: 'usbhid',
        endpoints: [{ address: 0x81, direction: 'IN', transferType: 'Interrupt', maxPacketSize: 8, interval: 10 }],
      }],
    }));
    bus.add(new UsbDevice({
      bus: 1, device: 3,
      vendorId: 0x046d, productId: 0xc077,
      vendorName: 'Logitech, Inc.', productName: 'M105 Optical Mouse',
      manufacturer: 'Logitech',
      classCode: 0x03, subClass: 0x01, protocol: 0x02,
      className: 'Human Interface Device',
      bcdUsb: 0x0200, speed: '1.5MBit/s', maxPower: 98,
      parentBus: 1, parentPort: 2,
      interfaces: [{
        number: 0, className: 'Human Interface Device',
        subClass: 0x01, protocol: 0x02, driver: 'usbhid',
        endpoints: [{ address: 0x81, direction: 'IN', transferType: 'Interrupt', maxPacketSize: 6, interval: 10 }],
      }],
    }));
    return bus;
  }
}

export function validateUsbSlot(slot: string): boolean {
  const m = /^(\d{1,3}):(\d{1,3})$/.exec(slot);
  if (!m) return false;
  const b = parseInt(m[1], 10);
  const d = parseInt(m[2], 10);
  return b >= 1 && b <= 127 && d >= 1 && d <= 127;
}
