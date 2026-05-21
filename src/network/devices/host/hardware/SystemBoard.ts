/**
 * SystemBoard — domain model of a host's firmware and motherboard.
 *
 * Together with the chassis these are the SMBIOS/DMI records `dmidecode`
 * walks (`-t bios`, `-t baseboard`, `-t system`) and that Windows surfaces
 * through `systeminfo` and WMI (`Win32_BIOS`, `Win32_BaseBoard`).
 */

// ─── Firmware (BIOS / UEFI) ─────────────────────────────────────────────

export type FirmwareKind = 'BIOS' | 'UEFI';

export interface FirmwareInit {
  vendor?: string;
  version?: string;
  releaseDate?: string;
  kind?: FirmwareKind;
}

export class Firmware {
  vendor: string;
  version: string;
  /** Release date in the SMBIOS `MM/DD/YYYY` form. */
  releaseDate: string;
  kind: FirmwareKind;

  constructor(init: FirmwareInit = {}) {
    this.vendor = init.vendor ?? 'SeaBIOS';
    this.version = init.version ?? '1.16.0-1';
    this.releaseDate = init.releaseDate ?? '04/01/2014';
    this.kind = init.kind ?? 'BIOS';
  }

  /** SMBIOS-style one-line summary, e.g. `SeaBIOS 1.16.0-1`. */
  describe(): string {
    return `${this.vendor} ${this.version}`;
  }
}

// ─── Motherboard / baseboard ────────────────────────────────────────────

export interface MainboardInit {
  manufacturer?: string;
  productName?: string;
  version?: string;
  serialNumber?: string;
}

export class Mainboard {
  manufacturer: string;
  productName: string;
  version: string;
  serialNumber: string;

  constructor(init: MainboardInit = {}) {
    this.manufacturer = init.manufacturer ?? 'Intel Corporation';
    this.productName = init.productName ?? '440BX Desktop Reference Platform';
    this.version = init.version ?? '1.0';
    this.serialNumber = init.serialNumber ?? 'None';
  }
}
