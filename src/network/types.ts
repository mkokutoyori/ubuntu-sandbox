/**
 * Network Simulator Types
 */

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

export type ConnectionType = 
  | 'ethernet'
  | 'fiber'
  | 'wifi'
  | 'serial';

export interface NetworkInterface {
  id: string;
  name: string;
  type: 'ethernet' | 'wifi' | 'fiber' | 'serial';
  ipAddress?: string;
  subnetMask?: string;
  gateway?: string;
  macAddress: string;
  isUp: boolean;
  speed?: string; // e.g., "1Gbps", "10Gbps"
}

export interface NetworkDevice {
  id: string;
  type: DeviceType;
  name: string;
  x: number;
  y: number;
  interfaces: NetworkInterface[];
  config?: Record<string, any>;
  isSelected?: boolean;
  isPoweredOn?: boolean;
}

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
  devices: NetworkDevice[];
  connections: Connection[];
  createdAt: Date;
  updatedAt: Date;
}

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

export function generateMacAddress(): string {
  const hexDigits = '0123456789ABCDEF';
  let mac = '';
  for (let i = 0; i < 6; i++) {
    if (i > 0) mac += ':';
    mac += hexDigits[Math.floor(Math.random() * 16)];
    mac += hexDigits[Math.floor(Math.random() * 16)];
  }
  return mac;
}

export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

export function getDefaultInterfaces(type: DeviceType): NetworkInterface[] {
  const createInterface = (name: string, ifType: NetworkInterface['type'] = 'ethernet'): NetworkInterface => ({
    id: generateId(),
    name,
    type: ifType,
    macAddress: generateMacAddress(),
    isUp: false
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
