/**
 * NetworkAdapter — domain model of a host's physical network interface card.
 *
 * This is the *hardware* descriptor: the controller model, its driver, the
 * burned-in MAC, link speed and bus location — the data `lshw -class network`
 * and Windows `systeminfo` report. It is deliberately distinct from the
 * simulator's logical `Port` (which carries the live link and addressing):
 * a NIC is the card, a Port is the interface bound to it, linked by `name`.
 */

export interface NetworkAdapterInit {
  name: string;
  macAddress: string;
  model?: string;
  vendor?: string;
  driver?: string;
  speedMbps?: number;
  busInfo?: string;
}

export class NetworkAdapter {
  /** Interface name the NIC is bound to, e.g. `eth0`. */
  name: string;
  /** Burned-in hardware MAC address. */
  macAddress: string;
  model: string;
  vendor: string;
  /** Kernel driver module, e.g. `e1000`. */
  driver: string;
  /** Negotiated/maximum link speed in Mbit/s. */
  speedMbps: number;
  /** PCI bus location, e.g. `0000:00:03.0`. */
  busInfo: string;

  constructor(init: NetworkAdapterInit) {
    this.name = init.name;
    this.macAddress = init.macAddress;
    this.model = init.model ?? 'Intel(R) 82540EM Gigabit Ethernet Controller';
    this.vendor = init.vendor ?? 'Intel Corporation';
    this.driver = init.driver ?? 'e1000';
    this.speedMbps = init.speedMbps ?? 1000;
    this.busInfo = init.busInfo ?? '0000:00:03.0';
  }

  /** Human link-speed label, e.g. `1 Gbps` / `100 Mbps`. */
  get linkSpeedLabel(): string {
    return this.speedMbps >= 1000
      ? `${this.speedMbps / 1000} Gbps`
      : `${this.speedMbps} Mbps`;
  }
}
