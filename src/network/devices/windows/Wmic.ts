import { renderTable, type TableStyle } from '../shells/cli/TextTable';

export interface WmicHost {
  readonly hostname: string;
  readonly os: { prettyName: string; version: string };
  readonly hardware: {
    manufacturer: string;
    productName: string;
    productUuid: string;
    serialNumber: string;
    cpu: { sockets: number; vendor: string; clockMhz: number };
    storage: ReadonlyArray<{
      name: string;
      sizeBytes: number;
      model: string;
      serial: string;
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

type WmicRow = Record<string, string>;

const WMIC_TABLE: TableStyle = { gap: 0, rule: false, padTrailing: true };

const LOGICAL_DISK_PROPERTIES = [
  'Caption', 'Description', 'DeviceID', 'DriveType', 'FileSystem',
  'FreeSpace', 'Name', 'Size', 'VolumeName', 'VolumeSerialNumber',
];

const DISK_DRIVE_PROPERTIES = [
  'Caption', 'DeviceID', 'Index', 'InterfaceType', 'MediaType', 'Model',
  'Partitions', 'SerialNumber', 'Size', 'Status',
];

const CS_PRODUCT_PROPERTIES = [
  'IdentifyingNumber', 'Name', 'UUID', 'Vendor', 'Version',
];

const OS_PROPERTIES = [
  'BuildNumber', 'Caption', 'CSName', 'OSArchitecture', 'Version',
];

const CPU_PROPERTIES = [
  'Manufacturer', 'MaxClockSpeed', 'Name', 'NumberOfCores',
];

function logicalDiskRows(host: WmicHost): WmicRow[] {
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

function diskDriveRows(host: WmicHost): WmicRow[] {
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

function csProductRows(host: WmicHost): WmicRow[] {
  return [{
    IdentifyingNumber: host.hardware.serialNumber,
    Name: host.hardware.productName,
    UUID: host.hardware.productUuid,
    Vendor: host.hardware.manufacturer,
    Version: 'pc-i440fx',
  }];
}

function osRows(host: WmicHost): WmicRow[] {
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

function cpuRows(host: WmicHost): WmicRow[] {
  return [{
    Manufacturer: host.hardware.cpu.vendor,
    MaxClockSpeed: String(Math.round(host.hardware.cpu.clockMhz)),
    Name: 'Intel(R) Core(TM) i7 CPU @ 2.50GHz',
    NumberOfCores: String(host.hardware.cpu.sockets),
  }];
}

interface WmicClass {
  properties: readonly string[];
  rows(host: WmicHost): WmicRow[];
}

const CLASSES: Readonly<Record<string, WmicClass>> = {
  logicaldisk: { properties: LOGICAL_DISK_PROPERTIES, rows: logicalDiskRows },
  diskdrive: { properties: DISK_DRIVE_PROPERTIES, rows: diskDriveRows },
  csproduct: { properties: CS_PRODUCT_PROPERTIES, rows: csProductRows },
  os: { properties: OS_PROPERTIES, rows: osRows },
  cpu: { properties: CPU_PROPERTIES, rows: cpuRows },
};

export function wmicClassNames(): string[] {
  return Object.keys(CLASSES);
}

function invalidQuery(host: WmicHost): string {
  return [`Node - ${host.hostname.toUpperCase()}`, 'ERROR:', 'Description = Invalid query'].join('\n');
}

/**
 * Les colonnes que WMIC rend sont celles qu'on lui demande, RANGEES par
 * nom de propriete — `get size,model,serialnumber` sort `Model`,
 * `SerialNumber`, `Size`. Une propriete que la classe ne porte pas fait
 * echouer la requete entiere, elle n'est pas ignoree.
 */
export function wmicQuery(host: WmicHost, alias: string, asked: readonly string[]): string | null {
  const klass = CLASSES[alias.toLowerCase()];
  if (!klass) return null;

  const wanted = asked.length === 0 ? [...klass.properties] : asked.map((a) => {
    const match = klass.properties.find((p) => p.toLowerCase() === a.toLowerCase());
    return match ?? '';
  });
  if (wanted.some((w) => w === '')) return invalidQuery(host);

  const selected = [...wanted].sort((a, b) => a.localeCompare(b));
  const rows = klass.rows(host);
  const columns = selected.map((property) => ({
    header: property,
    value: (row: WmicRow) => row[property] ?? '',
    width: Math.max(property.length, ...rows.map((r) => (r[property] ?? '').length)) + 2,
  }));
  return renderTable(rows, columns, WMIC_TABLE).join('\n');
}

export function parseWmicProperties(tokens: readonly string[]): string[] {
  return tokens.join(' ').split(',').map((t) => t.trim()).filter((t) => t.length > 0);
}
