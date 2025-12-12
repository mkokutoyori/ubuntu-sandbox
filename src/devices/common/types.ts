/**
 * Common Device Types - Base interfaces for all network devices
 * Consolidated types from Sprint 1 + UI layer
 */

// ==================== Device Type Definitions ====================

export type DeviceType =
  | 'linux-pc'
  | 'windows-pc'
  | 'mac-pc'
  | 'linux-server'
  | 'windows-server'
  | 'db-mysql'
  | 'db-postgres'
  | 'db-oracle'
  | 'db-sqlserver'
  | 'router-cisco'
  | 'router-huawei'
  | 'switch-cisco'
  | 'switch-huawei'
  | 'firewall-fortinet'
  | 'firewall-cisco'
  | 'firewall-paloalto'
  | 'access-point'
  | 'cloud';

export type DeviceOSType =
  | 'linux'
  | 'windows'
  | 'macos'
  | 'cisco-ios'
  | 'huawei-vrp'
  | 'fortios'
  | 'panos';

export type ConnectionType =
  | 'ethernet'
  | 'fiber'
  | 'wifi'
  | 'serial';

// ==================== Network Interface Types ====================

export interface NetworkInterfaceConfig {
  id: string;
  name: string;
  type: 'ethernet' | 'wifi' | 'fiber' | 'serial' | 'loopback';
  macAddress: string;
  ipAddress?: string;
  subnetMask?: string;
  gateway?: string;
  vlan?: number;
  isUp: boolean;
  speed: string;
  duplex: 'full' | 'half' | 'auto';
  // Pour les switches
  portMode?: 'access' | 'trunk';
  nativeVlan?: number;
  allowedVlans?: number[];
}

// ==================== Device Configuration ====================

export interface DeviceConfig {
  id: string;
  name: string;
  hostname: string;
  type: DeviceType;
  osType: DeviceOSType;
  interfaces: NetworkInterfaceConfig[];
  isPoweredOn: boolean;
  // UI positioning
  x?: number;
  y?: number;
  config?: Record<string, any>;
}

export interface CommandResult {
  output: string;
  error?: string;
  exitCode: number;
  newPrompt?: string;
}

// ==================== Network Tables ====================

export interface ARPEntry {
  ipAddress: string;
  macAddress: string;
  interface: string;
  type: 'static' | 'dynamic';
  age: number; // seconds
}

export interface RouteEntry {
  destination: string;
  netmask: string;
  gateway: string;
  interface: string;
  metric: number;
  protocol: 'connected' | 'static' | 'rip' | 'ospf' | 'eigrp';
}

export interface MACTableEntry {
  macAddress: string;
  vlan: number;
  interface: string;
  type: 'static' | 'dynamic';
  age: number;
}

// ==================== Connection Types ====================

export interface Connection {
  id: string;
  type: ConnectionType;
  sourceDeviceId: string;
  sourceInterfaceId: string;
  targetDeviceId: string;
  targetInterfaceId: string;
  bandwidth?: string;
  latency?: number;
  isActive?: boolean;
}

export interface NetworkTopology {
  id: string;
  name: string;
  devices: DeviceConfig[];
  connections: Connection[];
  createdAt: Date;
  updatedAt: Date;
}

// ==================== Device Categories for UI ====================

export interface DeviceCategory {
  id: string;
  name: string;
  icon: string;
  devices: {
    type: DeviceType;
    name: string;
    description: string;
  }[];
}

export const DEVICE_CATEGORIES: DeviceCategory[] = [
  {
    id: 'computers',
    name: 'Computers',
    icon: 'Monitor',
    devices: [
      { type: 'linux-pc', name: 'Linux PC', description: 'Ubuntu/Debian workstation' },
      { type: 'windows-pc', name: 'Windows PC', description: 'Windows 10/11 workstation' },
      { type: 'mac-pc', name: 'Mac', description: 'macOS workstation' },
    ]
  },
  {
    id: 'servers',
    name: 'Servers',
    icon: 'Server',
    devices: [
      { type: 'linux-server', name: 'Linux Server', description: 'Ubuntu Server / CentOS' },
      { type: 'windows-server', name: 'Windows Server', description: 'Windows Server 2022' },
    ]
  },
  {
    id: 'databases',
    name: 'Databases',
    icon: 'Database',
    devices: [
      { type: 'db-mysql', name: 'MySQL', description: 'MySQL Database Server' },
      { type: 'db-postgres', name: 'PostgreSQL', description: 'PostgreSQL Database Server' },
      { type: 'db-oracle', name: 'Oracle', description: 'Oracle Database Server' },
      { type: 'db-sqlserver', name: 'SQL Server', description: 'Microsoft SQL Server' },
    ]
  },
  {
    id: 'network',
    name: 'Network Devices',
    icon: 'Network',
    devices: [
      { type: 'router-cisco', name: 'Cisco Router', description: 'Cisco IOS Router' },
      { type: 'router-huawei', name: 'Huawei Router', description: 'Huawei VRP Router' },
      { type: 'switch-cisco', name: 'Cisco Switch', description: 'Cisco Catalyst Switch' },
      { type: 'switch-huawei', name: 'Huawei Switch', description: 'Huawei CloudEngine Switch' },
    ]
  },
  {
    id: 'security',
    name: 'Security',
    icon: 'Shield',
    devices: [
      { type: 'firewall-fortinet', name: 'FortiGate', description: 'Fortinet FortiGate Firewall' },
      { type: 'firewall-cisco', name: 'Cisco ASA', description: 'Cisco ASA Firewall' },
      { type: 'firewall-paloalto', name: 'Palo Alto', description: 'Palo Alto Networks Firewall' },
    ]
  },
  {
    id: 'wireless',
    name: 'Wireless',
    icon: 'Wifi',
    devices: [
      { type: 'access-point', name: 'Access Point', description: 'WiFi Access Point' },
    ]
  },
  {
    id: 'cloud',
    name: 'Cloud',
    icon: 'Cloud',
    devices: [
      { type: 'cloud', name: 'Internet Cloud', description: 'Internet / WAN Cloud' },
    ]
  }
];

// ==================== Helper Functions ====================

export function generateMacAddress(): string {
  const hexDigits = '0123456789ABCDEF';
  let mac = '00';  // Start with locally administered address
  for (let i = 0; i < 5; i++) {
    mac += ':';
    mac += hexDigits[Math.floor(Math.random() * 16)];
    mac += hexDigits[Math.floor(Math.random() * 16)];
  }
  return mac;
}

export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// Map DeviceType to DeviceOSType
export function getDeviceOSType(type: DeviceType): DeviceOSType {
  switch (type) {
    case 'linux-pc':
    case 'linux-server':
    case 'db-mysql':
    case 'db-postgres':
    case 'db-oracle':
    case 'db-sqlserver':
      return 'linux';
    case 'windows-pc':
    case 'windows-server':
      return 'windows';
    case 'mac-pc':
      return 'macos';
    case 'router-cisco':
    case 'switch-cisco':
    case 'firewall-cisco':
      return 'cisco-ios';
    case 'router-huawei':
    case 'switch-huawei':
      return 'huawei-vrp';
    case 'firewall-fortinet':
      return 'fortios';
    case 'firewall-paloalto':
      return 'panos';
    case 'access-point':
    case 'cloud':
      return 'linux';  // Default to Linux for now
    default:
      return 'linux';
  }
}

// Get default interfaces for a device type
export function getDefaultInterfaces(type: DeviceType): NetworkInterfaceConfig[] {
  const createInterface = (
    name: string,
    ifType: NetworkInterfaceConfig['type'] = 'ethernet'
  ): NetworkInterfaceConfig => ({
    id: generateId(),
    name,
    type: ifType,
    macAddress: generateMacAddress(),
    isUp: false,
    speed: '1Gbps',
    duplex: 'auto'
  });

  switch (type) {
    case 'linux-pc':
    case 'windows-pc':
    case 'mac-pc':
      return [createInterface('eth0')];

    case 'linux-server':
    case 'windows-server':
      return [
        createInterface('eth0'),
        createInterface('eth1')
      ];

    case 'db-mysql':
    case 'db-postgres':
    case 'db-oracle':
    case 'db-sqlserver':
      return [createInterface('eth0')];

    case 'router-cisco':
    case 'router-huawei':
      return [
        createInterface('GigabitEthernet0/0'),
        createInterface('GigabitEthernet0/1'),
        createInterface('GigabitEthernet0/2'),
        createInterface('GigabitEthernet0/3'),
        createInterface('Serial0/0', 'serial'),
        createInterface('Serial0/1', 'serial')
      ];

    case 'switch-cisco':
    case 'switch-huawei':
      return Array.from({ length: 24 }, (_, i) =>
        createInterface(`FastEthernet0/${i + 1}`)
      );

    case 'firewall-fortinet':
    case 'firewall-cisco':
    case 'firewall-paloalto':
      return [
        createInterface('wan1'),
        createInterface('wan2'),
        createInterface('lan1'),
        createInterface('lan2'),
        createInterface('dmz')
      ];

    case 'access-point':
      return [
        createInterface('eth0'),
        createInterface('wlan0', 'wifi')
      ];

    case 'cloud':
      return [
        createInterface('internet0'),
        createInterface('internet1')
      ];

    default:
      return [createInterface('eth0')];
  }
}

// Get default device name based on type
const deviceCounters: Record<string, number> = {};

export function getDefaultDeviceName(type: DeviceType): string {
  if (!deviceCounters[type]) deviceCounters[type] = 0;
  deviceCounters[type]++;

  const names: Record<DeviceType, string> = {
    'linux-pc': 'Linux-PC',
    'windows-pc': 'Windows-PC',
    'mac-pc': 'Mac',
    'linux-server': 'Linux-Server',
    'windows-server': 'Win-Server',
    'db-mysql': 'MySQL',
    'db-postgres': 'PostgreSQL',
    'db-oracle': 'Oracle',
    'db-sqlserver': 'SQLServer',
    'router-cisco': 'Router-Cisco',
    'router-huawei': 'Router-Huawei',
    'switch-cisco': 'Switch-Cisco',
    'switch-huawei': 'Switch-Huawei',
    'firewall-fortinet': 'FortiGate',
    'firewall-cisco': 'Cisco-ASA',
    'firewall-paloalto': 'PaloAlto',
    'access-point': 'AP',
    'cloud': 'Cloud'
  };

  return `${names[type]}-${deviceCounters[type]}`;
}

export function resetDeviceCounters(): void {
  Object.keys(deviceCounters).forEach(key => {
    deviceCounters[key] = 0;
  });
}

// Callback pour envoyer des paquets
export type PacketSender = (packet: import('../../core/network/packet').Packet, interfaceId: string) => void;
