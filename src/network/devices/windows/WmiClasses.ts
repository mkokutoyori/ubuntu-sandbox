export interface WmiHost {
  readonly hostname: string;
  readonly os: { prettyName: string; version: string };
  readonly hardware: {
    manufacturer: string;
    productName: string;
    productUuid: string;
    serialNumber: string;
    cpu: { sockets: number; vendor: string; clockMhz: number };
    memory: {
      totalKib: number;
      modules: ReadonlyArray<{
        sizeMib: number; type: string; speedMtps: number;
        manufacturer: string; locator: string; formFactor: string;
      }>;
    };
    firmware: { vendor: string; version: string; releaseDate: string };
    mainboard: { manufacturer: string; productName: string; version: string; serialNumber: string };
    storage: ReadonlyArray<{
      name: string; sizeBytes: number; model: string; serial: string;
      partitions: ReadonlyArray<unknown>;
    }>;
  };
  readonly volumes: {
    letters(): string[];
    capacityBytes(letter: string): number;
    freeBytes(letter: string): number;
    label(letter: string): string;
  };
  getVolumeSerialNumber(letter: string): string;
}

export type WmiRow = Record<string, string>;

export interface WmiClass {
  /** Le nom CIM, celui que `Get-CimInstance` prend. */
  readonly name: string;
  /** L'alias que `wmic` prend pour la meme classe. */
  readonly alias: string;
  readonly properties: readonly string[];
  rows(host: WmiHost): WmiRow[];
}

const CPU_MODEL = 'Intel(R) Core(TM) i7 CPU @ 2.50GHz';
const X64_SYSTEM_TYPE = 'x64-based PC';

function logicalDiskRows(host: WmiHost): WmiRow[] {
  return host.volumes.letters().map((drive) => {
    const letter = drive.charAt(0).toUpperCase();
    return {
      Caption: `${letter}:`,
      Description: 'Local Fixed Disk',
      DeviceID: `${letter}:`,
      DriveType: '3',
      FileSystem: 'NTFS',
      FreeSpace: String(host.volumes.freeBytes(letter)),
      Name: `${letter}:`,
      Size: String(host.volumes.capacityBytes(letter)),
      VolumeName: host.volumes.label(letter),
      VolumeSerialNumber: host.getVolumeSerialNumber(letter).replace('-', ''),
    };
  });
}

function diskDriveRows(host: WmiHost): WmiRow[] {
  return host.hardware.storage.map((disk, index) => ({
    Caption: disk.model,
    DeviceID: `\\\\.\\PHYSICALDRIVE${index}`,
    Index: String(index),
    InterfaceType: 'IDE',
    MediaType: 'Fixed hard disk media',
    Model: disk.model,
    Partitions: String(disk.partitions.length),
    SerialNumber: disk.serial,
    Size: String(disk.sizeBytes),
    Status: 'OK',
  }));
}

function csProductRows(host: WmiHost): WmiRow[] {
  return [{
    IdentifyingNumber: host.hardware.serialNumber,
    Name: host.hardware.productName,
    UUID: host.hardware.productUuid,
    Vendor: host.hardware.manufacturer,
    Version: 'pc-i440fx',
  }];
}

/**
 * Le chassis vu par WMI. Constructeur, modele et memoire viennent de
 * `HardwareProfile` — le meme inventaire que lit `systeminfo`, qui
 * annoncait « QEMU / Standard PC » quand cette classe repondait
 * « Microsoft Corporation / Virtual Machine ».
 */
function computerSystemRows(host: WmiHost): WmiRow[] {
  return [{
    Caption: host.hostname.toUpperCase(),
    Manufacturer: host.hardware.manufacturer,
    Model: host.hardware.productName,
    Name: host.hostname.toUpperCase(),
    NumberOfProcessors: String(host.hardware.cpu.sockets),
    SystemType: X64_SYSTEM_TYPE,
    TotalPhysicalMemory: String(host.hardware.memory.totalKib * 1024),
  }];
}

function biosRows(host: WmiHost): WmiRow[] {
  const fw = host.hardware.firmware;
  return [{
    Manufacturer: fw.vendor,
    Name: `${fw.vendor} ${fw.version}`,
    ReleaseDate: fw.releaseDate,
    SerialNumber: host.hardware.serialNumber,
    SMBIOSBIOSVersion: fw.version,
    Version: `${fw.vendor} - 1`,
  }];
}

function baseBoardRows(host: WmiHost): WmiRow[] {
  const mb = host.hardware.mainboard;
  return [{
    Manufacturer: mb.manufacturer,
    Product: mb.productName,
    SerialNumber: mb.serialNumber,
    Version: mb.version,
  }];
}

function physicalMemoryRows(host: WmiHost): WmiRow[] {
  return host.hardware.memory.modules.map((m) => ({
    Capacity: String(m.sizeMib * 1024 * 1024),
    DeviceLocator: m.locator,
    FormFactor: m.formFactor === 'DIMM' ? '8' : '0',
    Manufacturer: m.manufacturer,
    MemoryType: '0',
    PartNumber: m.type,
    Speed: String(m.speedMtps),
  }));
}

function processorRows(host: WmiHost): WmiRow[] {
  const cpu = host.hardware.cpu;
  return [{
    Architecture: '9',
    Manufacturer: cpu.vendor,
    MaxClockSpeed: String(Math.round(cpu.clockMhz)),
    Name: CPU_MODEL,
    NumberOfCores: String(cpu.sockets),
    NumberOfLogicalProcessors: String(cpu.sockets),
  }];
}

function operatingSystemRows(host: WmiHost): WmiRow[] {
  const build = /Build (\d+)/.exec(host.os.version)?.[1]
    ?? host.os.version.split(' ')[0].split('.')[2] ?? '';
  return [{
    BuildNumber: build,
    Caption: host.os.prettyName,
    CSName: host.hostname.toUpperCase(),
    OSArchitecture: '64-bit',
    Version: host.os.version.split(' ')[0],
  }];
}

function declare(
  name: string, alias: string, rows: (host: WmiHost) => WmiRow[], properties: readonly string[],
): WmiClass {
  return { name, alias, properties, rows };
}

export const WMI_CLASSES: readonly WmiClass[] = [
  declare('Win32_LogicalDisk', 'logicaldisk', logicalDiskRows, [
    'Caption', 'Description', 'DeviceID', 'DriveType', 'FileSystem',
    'FreeSpace', 'Name', 'Size', 'VolumeName', 'VolumeSerialNumber']),
  declare('Win32_DiskDrive', 'diskdrive', diskDriveRows, [
    'Caption', 'DeviceID', 'Index', 'InterfaceType', 'MediaType', 'Model',
    'Partitions', 'SerialNumber', 'Size', 'Status']),
  declare('Win32_ComputerSystemProduct', 'csproduct', csProductRows, [
    'IdentifyingNumber', 'Name', 'UUID', 'Vendor', 'Version']),
  declare('Win32_ComputerSystem', 'computersystem', computerSystemRows, [
    'Caption', 'Manufacturer', 'Model', 'Name', 'NumberOfProcessors',
    'SystemType', 'TotalPhysicalMemory']),
  declare('Win32_BIOS', 'bios', biosRows, [
    'Manufacturer', 'Name', 'ReleaseDate', 'SerialNumber', 'SMBIOSBIOSVersion', 'Version']),
  declare('Win32_BaseBoard', 'baseboard', baseBoardRows, [
    'Manufacturer', 'Product', 'SerialNumber', 'Version']),
  declare('Win32_PhysicalMemory', 'memorychip', physicalMemoryRows, [
    'Capacity', 'DeviceLocator', 'FormFactor', 'Manufacturer', 'MemoryType',
    'PartNumber', 'Speed']),
  declare('Win32_Processor', 'cpu', processorRows, [
    'Architecture', 'Manufacturer', 'MaxClockSpeed', 'Name',
    'NumberOfCores', 'NumberOfLogicalProcessors']),
  declare('Win32_OperatingSystem', 'os', operatingSystemRows, [
    'BuildNumber', 'Caption', 'CSName', 'OSArchitecture', 'Version']),
];

/**
 * La classe designee, par son alias `wmic` ou par son nom CIM. Les deux
 * facades tirent donc de la MEME declaration : une machine n'a qu'un
 * WMI, et `wmic logicaldisk` ne peut pas connaitre une classe que
 * `Get-CimInstance Win32_LogicalDisk` ignore.
 */
export function findWmiClass(nameOrAlias: string): WmiClass | undefined {
  const wanted = nameOrAlias.toLowerCase();
  return WMI_CLASSES.find((c) => c.alias === wanted || c.name.toLowerCase() === wanted);
}
