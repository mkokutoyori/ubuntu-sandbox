import type { HardwareProfile } from '@/network/devices/host/hardware/HardwareProfile';

const TYPES = new Map<string, number>([
  ['bios', 0], ['system', 1], ['baseboard', 2], ['chassis', 3],
  ['processor', 4], ['memory', 16], ['memory-controller', 5],
  ['memory-device', 17], ['cache', 7], ['connector', 8], ['slot', 9],
]);

const STRINGS = new Set([
  'bios-vendor', 'bios-version', 'bios-release-date',
  'system-manufacturer', 'system-product-name', 'system-version',
  'system-serial-number', 'system-uuid', 'system-family',
  'baseboard-manufacturer', 'baseboard-product-name',
  'baseboard-version', 'baseboard-serial-number', 'baseboard-asset-tag',
  'chassis-manufacturer', 'chassis-type', 'chassis-version',
  'chassis-serial-number', 'chassis-asset-tag',
  'processor-family', 'processor-manufacturer', 'processor-version',
  'processor-frequency',
]);

export function cmdDmidecode(profile: HardwareProfile, args: string[], _isPrivileged: boolean): { output: string; exitCode: number } {

  let typeFilter: string | null = null;
  let stringKey: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-t' || a === '--type') {
      const v = args[++i];
      if (!v || (!TYPES.has(v.toLowerCase()) && !/^\d+$/.test(v))) {
        return { output: `dmidecode: invalid argument "${v ?? ''}" for option --type`, exitCode: 1 };
      }
      typeFilter = v.toLowerCase();
      continue;
    }
    if (a === '-s' || a === '--string') {
      const v = args[++i];
      if (!v || !STRINGS.has(v)) {
        return { output: `dmidecode: invalid argument "${v ?? ''}" for option --string`, exitCode: 1 };
      }
      stringKey = v;
      continue;
    }
    if (a === '-h' || a === '--help') return { output: helpText(), exitCode: 0 };
    if (a === '-V' || a === '--version') return { output: '# dmidecode 3.3', exitCode: 0 };
    if (a.startsWith('--')) return { output: `dmidecode: unrecognized option '${a}'`, exitCode: 1 };
    if (a.startsWith('-')) return { output: `dmidecode: invalid option -- '${a.slice(1)}'`, exitCode: 1 };
  }

  if (stringKey) return { output: renderString(profile, stringKey), exitCode: 0 };
  return { output: renderTables(profile, typeFilter), exitCode: 0 };
}

function renderString(p: HardwareProfile, key: string): string {
  switch (key) {
    case 'bios-vendor': return p.firmware.vendor;
    case 'bios-version': return p.firmware.version;
    case 'bios-release-date': return p.firmware.releaseDate;
    case 'system-manufacturer': return p.manufacturer;
    case 'system-product-name': return p.productName;
    case 'system-uuid': return p.productUuid;
    case 'system-serial-number': return p.serialNumber;
    case 'system-version': return p.productName;
    case 'system-family': return 'Server';
    case 'baseboard-manufacturer': return p.mainboard.manufacturer;
    case 'baseboard-product-name': return p.mainboard.productName;
    case 'baseboard-version': return p.mainboard.version;
    case 'baseboard-serial-number': return p.mainboard.serialNumber;
    case 'baseboard-asset-tag': return 'Not Specified';
    case 'chassis-manufacturer': return p.manufacturer;
    case 'chassis-type': return p.chassisType;
    case 'chassis-version': return 'Not Specified';
    case 'chassis-serial-number': return p.serialNumber;
    case 'chassis-asset-tag': return 'Not Specified';
    case 'processor-family': return 'Xeon';
    case 'processor-manufacturer': return p.cpu.vendor;
    case 'processor-version': return p.cpu.modelName;
    case 'processor-frequency': return `${p.cpu.clockMhz} MHz`;
    default: return '';
  }
}

function renderTables(p: HardwareProfile, filter: string | null): string {
  const header = [
    '# dmidecode 3.3',
    'Getting SMBIOS data from sysfs.',
    'SMBIOS 2.8 present.',
    '',
  ];
  const sections: string[] = [];
  const want = (name: string) => !filter || filter === name || filter === String(TYPES.get(name));
  if (want('bios')) sections.push(biosTable(p));
  if (want('system')) sections.push(systemTable(p));
  if (want('baseboard')) sections.push(baseboardTable(p));
  if (want('chassis')) sections.push(chassisTable(p));
  if (want('processor')) sections.push(processorTable(p));
  if (want('cache')) sections.push(cacheTable(p));
  if (want('memory') || want('memory-device')) sections.push(memoryTable(p));
  return header.join('\n') + sections.join('\n\n');
}

function biosTable(p: HardwareProfile): string {
  return [
    'Handle 0x0000, DMI type 0, 24 bytes',
    'BIOS Information',
    `\tVendor: ${p.firmware.vendor}`,
    `\tVersion: ${p.firmware.version}`,
    `\tRelease Date: ${p.firmware.releaseDate}`,
    `\tAddress: 0xE8000`,
    `\tRuntime Size: 96 kB`,
    `\tROM Size: 64 kB`,
    `\tCharacteristics:`,
    `\t\tBIOS characteristics not supported`,
    `\t\tTargeted content distribution is supported`,
  ].join('\n');
}

function systemTable(p: HardwareProfile): string {
  return [
    'Handle 0x0100, DMI type 1, 27 bytes',
    'System Information',
    `\tManufacturer: ${p.manufacturer}`,
    `\tProduct Name: ${p.productName}`,
    `\tVersion: Not Specified`,
    `\tSerial Number: ${p.serialNumber}`,
    `\tUUID: ${p.productUuid}`,
    `\tWake-up Type: Power Switch`,
    `\tSKU Number: Not Specified`,
    `\tFamily: Not Specified`,
  ].join('\n');
}

function baseboardTable(p: HardwareProfile): string {
  return [
    'Handle 0x0200, DMI type 2, 8 bytes',
    'Base Board Information',
    `\tManufacturer: ${p.mainboard.manufacturer}`,
    `\tProduct Name: ${p.mainboard.productName}`,
    `\tVersion: ${p.mainboard.version}`,
    `\tSerial Number: ${p.mainboard.serialNumber}`,
  ].join('\n');
}

function chassisTable(p: HardwareProfile): string {
  return [
    'Handle 0x0300, DMI type 3, 21 bytes',
    'Chassis Information',
    `\tManufacturer: ${p.manufacturer}`,
    `\tType: ${p.chassisType}`,
    `\tLock: Not Present`,
    `\tVersion: Not Specified`,
    `\tSerial Number: ${p.serialNumber}`,
  ].join('\n');
}

function processorTable(p: HardwareProfile): string {
  return [
    'Handle 0x0401, DMI type 4, 48 bytes',
    'Processor Information',
    `\tSocket Designation: CPU 1`,
    `\tType: Central Processor`,
    `\tFamily: Xeon`,
    `\tManufacturer: ${p.cpu.vendor}`,
    `\tVersion: ${p.cpu.modelName}`,
    `\tCurrent Speed: ${p.cpu.clockMhz} MHz`,
    `\tMax Speed: ${p.cpu.maxClockMhz} MHz`,
    `\tCore Count: ${p.cpu.coresPerSocket}`,
    `\tThread Count: ${p.cpu.coresPerSocket * p.cpu.threadsPerCore}`,
    `\tStatus: Populated, Enabled`,
  ].join('\n');
}

function cacheTable(p: HardwareProfile): string {
  return [
    'Handle 0x0700, DMI type 7, 27 bytes',
    'Cache Information',
    `\tSocket Designation: L1`,
    `\tConfiguration: Enabled, Not Socketed, Level 1`,
    `\tInstalled Size: ${p.cpu.l1dCacheKib + p.cpu.l1iCacheKib} kB`,
    `\tMaximum Size: ${p.cpu.l1dCacheKib + p.cpu.l1iCacheKib} kB`,
    '',
    'Handle 0x0701, DMI type 7, 27 bytes',
    'Cache Information',
    `\tSocket Designation: L2`,
    `\tInstalled Size: ${p.cpu.l2CacheKib} kB`,
    '',
    'Handle 0x0702, DMI type 7, 27 bytes',
    'Cache Information',
    `\tSocket Designation: L3`,
    `\tInstalled Size: ${p.cpu.l3CacheKib} kB`,
  ].join('\n');
}

function memoryTable(p: HardwareProfile): string {
  const total = p.memory.totalKib;
  return [
    'Handle 0x1000, DMI type 16, 23 bytes',
    'Physical Memory Array',
    `\tLocation: System Board Or Motherboard`,
    `\tUse: System Memory`,
    `\tMaximum Capacity: ${Math.ceil(total / 1024)} MB`,
    `\tNumber Of Devices: 1`,
    '',
    'Handle 0x1100, DMI type 17, 40 bytes',
    'Memory Device',
    `\tArray Handle: 0x1000`,
    `\tSize: ${Math.ceil(total / 1024)} MB`,
    `\tForm Factor: DIMM`,
    `\tType: DDR4`,
    `\tSpeed: 2400 MT/s`,
    `\tManufacturer: ${p.manufacturer}`,
  ].join('\n');
}

function helpText(): string {
  return [
    'Usage: dmidecode [OPTIONS]',
    'Options are:',
    ' -d, --dev-mem FILE       Read memory from device FILE (default: /dev/mem)',
    ' -h, --help               Display this help text and exit',
    ' -q, --quiet              Less verbose output',
    ' -s, --string KEYWORD     Only display the value of the given DMI string',
    ' -t, --type TYPE          Only display the entries of given type',
    ' -V, --version            Display the version and exit',
  ].join('\n');
}
