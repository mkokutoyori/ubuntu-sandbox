export interface HuaweiHardwareProfile {
  readonly family: 'router' | 'switch';
  readonly model: string;
  readonly description: string;
  readonly softwareBranch: string;
  readonly versionString: string;
  readonly boardType: string;
  readonly boardItem: string;
  readonly boardCardSlots: ReadonlyArray<{
    slot: string;
    sub: string;
    type: string;
    role: 'Master' | 'Slave' | '-';
    online: boolean;
  }>;
  readonly elabelDescription: string;
  readonly elabelBarCodePrefix: string;
  readonly elabelItem: string;
  readonly vendor: string;
  readonly manufactured: string;
  readonly snmpSysDescr: string;
  readonly snmpSysObjectId: string;
  readonly memoryBytes: number;
  readonly flashBytes: number;
  readonly defaultInterfaceNames: readonly string[];
}

export const AR2220_HARDWARE_PROFILE: HuaweiHardwareProfile = {
  family: 'router',
  model: 'AR2220',
  description: 'Huawei AR2220 Enterprise Router',
  softwareBranch: 'V200R009C00SPC500',
  versionString: 'VRP (R) software, Version 5.170 (AR2220 V200R009C00SPC500)',
  boardType: 'AR2220',
  boardItem: '02113965',
  boardCardSlots: [
    { slot: '0', sub: '-', type: 'AR2220', role: 'Master', online: true },
    { slot: '1', sub: '-', type: '2GE-COMBO', role: '-', online: true },
    { slot: '2', sub: '-', type: '2SA', role: '-', online: true },
    { slot: '3', sub: '-', type: '4FE', role: '-', online: false },
  ],
  elabelDescription: 'Huawei AR2220 Enterprise Router',
  elabelBarCodePrefix: '210305',
  elabelItem: '02113965',
  vendor: 'Huawei',
  manufactured: '2024-01-01',
  snmpSysDescr: 'Huawei Versatile Routing Platform Software\nVRP (R) software, Version 5.170 (AR2220 V200R009C00SPC500)',
  snmpSysObjectId: '1.3.6.1.4.1.2011.2.224',
  memoryBytes: 1073741824,
  flashBytes: 268435456,
  defaultInterfaceNames: [
    'GigabitEthernet0/0/0', 'GigabitEthernet0/0/1', 'GigabitEthernet0/0/2',
  ],
};

export const S5720_HARDWARE_PROFILE: HuaweiHardwareProfile = {
  family: 'switch',
  model: 'S5720-28X-LI-AC',
  description: 'Huawei S5720-28X-LI-AC Switch',
  softwareBranch: 'V200R019C10SPC500',
  versionString: 'VRP (R) software, Version 5.170 (S5720 V200R019C10SPC500)',
  boardType: 'S5720-28X-LI',
  boardItem: '02359556',
  boardCardSlots: [
    { slot: '1', sub: '-', type: 'S5720-28X-LI', role: 'Master', online: true },
  ],
  elabelDescription: 'Huawei S5720-28X-LI-AC Switch',
  elabelBarCodePrefix: '210235',
  elabelItem: '02359556',
  vendor: 'Huawei',
  manufactured: '2024-01-01',
  snmpSysDescr: 'Huawei Versatile Routing Platform Software\nVRP (R) software, Version 5.170 (S5720 V200R019C10SPC500)',
  snmpSysObjectId: '1.3.6.1.4.1.2011.2.23.94',
  memoryBytes: 536870912,
  flashBytes: 134217728,
  defaultInterfaceNames: [],
};

export function renderHardwareDevice(
  hostname: string,
  profile: HuaweiHardwareProfile,
): string {
  const header = [
    `${hostname}'s Device status:`,
    '-------------------------------------------------------------------------------',
    'Slot  Sub  Type            Online    Power    Register     Status   Role',
    '-------------------------------------------------------------------------------',
  ];
  const rows = profile.boardCardSlots.map((s) => {
    const online = s.online ? 'Present  ' : 'Absent   ';
    const power = s.online ? 'On      ' : 'Off     ';
    const reg = s.online ? 'Registered' : '-         ';
    const status = s.online ? 'Normal' : '-     ';
    const role = s.role;
    const type = s.type.padEnd(15);
    return `${s.slot.padEnd(6)}${s.sub.padEnd(5)}${type} ${online} ${power} ${reg}   ${status}   ${role}`;
  });
  return [...header, ...rows,
    '-------------------------------------------------------------------------------',
  ].join('\n');
}

export function renderHardwareElabel(
  hostname: string,
  profile: HuaweiHardwareProfile,
): string {
  const tag = hostname.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'HOST0001';
  return [
    '/$[ARCHIVES INFO VERSION]',
    '/$ArchivesInfoVersion=3.0;',
    '',
    '[Slot_1]',
    '/$[Board Integrated Component]',
    `/$BoardType=${profile.boardType};`,
    `/$BarCode=${profile.elabelBarCodePrefix}${tag};`,
    `/$Item=${profile.elabelItem};`,
    `/$Description=${profile.elabelDescription};`,
    `/$Manufactured=${profile.manufactured};`,
    `/$VendorName=${profile.vendor};`,
  ].join('\n');
}

export function renderHardwareVersion(
  hostname: string,
  uptime: string,
  profile: HuaweiHardwareProfile,
): string {
  return [
    'Huawei Versatile Routing Platform Software',
    profile.versionString,
    'Copyright (C) 2000-2025 HUAWEI TECH CO., LTD',
    '',
    `BOARD TYPE:          ${profile.boardType}`,
    'BootROM Version:     1.0',
    `${hostname} uptime is ${uptime}`,
  ].join('\n');
}
