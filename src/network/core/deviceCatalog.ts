import type { DeviceType } from './types';

export type DeviceOSType = 'linux' | 'windows' | 'cisco-ios' | 'huawei-vrp';

export type DeviceCategoryId = 'computers' | 'servers' | 'switches' | 'routers' | 'security';

export interface DeviceDefinition {
  label: string;
  description: string;
  osType: DeviceOSType;
  namePrefix: string;
  hasTerminal: boolean;
  fullyImplemented: boolean;
  paletteCategory: DeviceCategoryId | null;
}

export const DEVICE_CATALOG: Record<DeviceType, DeviceDefinition> = {
  'linux-pc': {
    label: 'Linux PC', description: 'Ubuntu/Debian workstation',
    osType: 'linux', namePrefix: 'PC',
    hasTerminal: true, fullyImplemented: true, paletteCategory: 'computers',
  },
  'windows-pc': {
    label: 'Windows PC', description: 'Windows 10/11 workstation',
    osType: 'windows', namePrefix: 'PC',
    hasTerminal: true, fullyImplemented: true, paletteCategory: 'computers',
  },
  'mac-pc': {
    label: 'Mac', description: 'macOS workstation',
    osType: 'linux', namePrefix: 'Mac',
    hasTerminal: true, fullyImplemented: false, paletteCategory: 'computers',
  },
  'linux-server': {
    label: 'Linux Server', description: 'Ubuntu/CentOS server',
    osType: 'linux', namePrefix: 'Server',
    hasTerminal: true, fullyImplemented: true, paletteCategory: 'servers',
  },
  'windows-server': {
    label: 'Windows Server', description: 'Windows Server 2019/2022',
    osType: 'windows', namePrefix: 'WinServer',
    hasTerminal: true, fullyImplemented: true, paletteCategory: 'servers',
  },
  'switch-cisco': {
    label: 'Cisco Switch', description: 'Layer 2 switching device',
    osType: 'cisco-ios', namePrefix: 'Switch',
    hasTerminal: true, fullyImplemented: true, paletteCategory: 'switches',
  },
  'switch-huawei': {
    label: 'Huawei Switch', description: 'Layer 2 switching device',
    osType: 'huawei-vrp', namePrefix: 'Switch',
    hasTerminal: true, fullyImplemented: true, paletteCategory: 'switches',
  },
  'switch-generic': {
    label: 'Generic Switch', description: 'Layer 2 switching device',
    osType: 'linux', namePrefix: 'Switch',
    hasTerminal: true, fullyImplemented: true, paletteCategory: null,
  },
  'hub': {
    label: 'Hub', description: 'Layer 1 repeater',
    osType: 'linux', namePrefix: 'Hub',
    hasTerminal: false, fullyImplemented: true, paletteCategory: 'switches',
  },
  'router-cisco': {
    label: 'Cisco Router', description: 'Layer 3 routing device',
    osType: 'cisco-ios', namePrefix: 'Router',
    hasTerminal: true, fullyImplemented: true, paletteCategory: 'routers',
  },
  'router-huawei': {
    label: 'Huawei Router', description: 'Layer 3 routing device',
    osType: 'huawei-vrp', namePrefix: 'Router',
    hasTerminal: true, fullyImplemented: true, paletteCategory: 'routers',
  },
  'firewall-cisco': {
    label: 'Cisco ASA', description: 'Cisco Adaptive Security Appliance',
    osType: 'linux', namePrefix: 'FW',
    hasTerminal: true, fullyImplemented: false, paletteCategory: 'security',
  },
  'firewall-fortinet': {
    label: 'FortiGate', description: 'Fortinet firewall',
    osType: 'linux', namePrefix: 'FW',
    hasTerminal: true, fullyImplemented: false, paletteCategory: 'security',
  },
  'firewall-paloalto': {
    label: 'Palo Alto', description: 'Palo Alto firewall',
    osType: 'linux', namePrefix: 'FW',
    hasTerminal: true, fullyImplemented: false, paletteCategory: 'security',
  },
  'access-point': {
    label: 'Access Point', description: 'Wireless access point',
    osType: 'linux', namePrefix: 'AP',
    hasTerminal: false, fullyImplemented: false, paletteCategory: null,
  },
  'cloud': {
    label: 'Cloud', description: 'External network',
    osType: 'linux', namePrefix: 'Cloud',
    hasTerminal: false, fullyImplemented: false, paletteCategory: null,
  },
};

export function deviceDefinition(type: DeviceType): DeviceDefinition {
  return DEVICE_CATALOG[type];
}

export interface DeviceCategory {
  id: string;
  name: string;
  devices: Array<{
    type: DeviceType;
    name: string;
    description: string;
  }>;
}

const CATEGORY_LABELS: Record<DeviceCategoryId, string> = {
  computers: 'Computers',
  servers: 'Servers',
  switches: 'Switches',
  routers: 'Routers',
  security: 'Firewalls',
};

export const DEVICE_CATEGORIES: DeviceCategory[] =
  (Object.keys(CATEGORY_LABELS) as DeviceCategoryId[]).map((id) => ({
    id,
    name: CATEGORY_LABELS[id],
    devices: (Object.entries(DEVICE_CATALOG) as Array<[DeviceType, DeviceDefinition]>)
      .filter(([, def]) => def.paletteCategory === id)
      .map(([type, def]) => ({ type, name: def.label, description: def.description })),
  }));
