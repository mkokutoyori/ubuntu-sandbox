import { vi } from 'vitest';
import { createDevice } from '@/network/devices/DeviceFactory';
import { Cable } from '@/network/hardware/Cable';
import type { DeviceType } from '@/network';
import type { Port } from '@/network/hardware/Port';

import { refuse, taper, type Cli } from './fortigateBatteryHarness';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

export interface LabDevice extends Cli {
  getName(): string;
}

type LabName =
  | 'PC1' | 'PC2' | 'Switch1' | 'FW1' | 'Router2' | 'R3' | 'HQ_MAIN_SW' | 'Server1' | 'WinServer1'
  | 'PC3' | 'PC4' | 'PC5' | 'PC6' | 'PC7' | 'Switch3' | 'Server2' | 'PC8' | 'R4' | 'BON_MAIN_SW'
  | 'PC9' | 'PC10' | 'PC11' | 'Switch5' | 'Server3';

export type UserLab = Record<LabName, LabDevice>;

const DEVICES: ReadonlyArray<readonly [LabName, DeviceType]> = [
  ['PC1', 'linux-pc'], ['PC2', 'windows-pc'], ['Switch1', 'switch-cisco'], ['FW1', 'firewall-fortinet'],
  ['Router2', 'router-cisco'], ['R3', 'router-cisco'], ['HQ_MAIN_SW', 'switch-cisco'],
  ['Server1', 'linux-server'], ['WinServer1', 'windows-server'], ['PC3', 'linux-pc'],
  ['PC4', 'windows-pc'], ['PC5', 'linux-pc'], ['PC6', 'windows-pc'], ['PC7', 'windows-pc'],
  ['Switch3', 'switch-cisco'], ['Server2', 'linux-server'], ['PC8', 'windows-pc'],
  ['R4', 'router-huawei'], ['BON_MAIN_SW', 'switch-huawei'], ['PC9', 'windows-pc'],
  ['PC10', 'windows-pc'], ['PC11', 'linux-pc'], ['Switch5', 'switch-huawei'], ['Server3', 'linux-server'],
];

const CABLES: ReadonlyArray<readonly [LabName, string, LabName, string]> = [
  ['PC2', 'eth0', 'Switch1', 'FastEthernet0/1'],
  ['PC1', 'eth0', 'Switch1', 'FastEthernet0/2'],
  ['Router2', 'GigabitEthernet0/0', 'Switch1', 'FastEthernet0/3'],
  ['FW1', 'port1', 'Switch1', 'FastEthernet0/4'],
  ['R3', 'GigabitEthernet0/0', 'FW1', 'port2'],
  ['HQ_MAIN_SW', 'FastEthernet0/1', 'R3', 'GigabitEthernet0/1'],
  ['Server1', 'eth0', 'HQ_MAIN_SW', 'FastEthernet0/2'],
  ['WinServer1', 'eth0', 'HQ_MAIN_SW', 'FastEthernet0/3'],
  ['PC3', 'eth0', 'HQ_MAIN_SW', 'FastEthernet0/4'],
  ['PC4', 'eth0', 'HQ_MAIN_SW', 'FastEthernet0/5'],
  ['PC5', 'eth0', 'HQ_MAIN_SW', 'FastEthernet0/6'],
  ['PC6', 'eth0', 'Switch1', 'FastEthernet0/5'],
  ['Switch1', 'FastEthernet0/6', 'PC7', 'eth0'],
  ['Switch3', 'FastEthernet0/1', 'Router2', 'GigabitEthernet0/1'],
  ['Server2', 'eth0', 'Switch3', 'FastEthernet0/2'],
  ['PC8', 'eth0', 'Switch3', 'FastEthernet0/3'],
  ['R4', 'GE0/0/0', 'HQ_MAIN_SW', 'FastEthernet0/7'],
  ['BON_MAIN_SW', 'GigabitEthernet0/0/0', 'R4', 'GE0/0/1'],
  ['PC9', 'eth0', 'BON_MAIN_SW', 'GigabitEthernet0/0/1'],
  ['PC10', 'eth0', 'BON_MAIN_SW', 'GigabitEthernet0/0/2'],
  ['BON_MAIN_SW', 'GigabitEthernet0/0/3', 'PC11', 'eth0'],
  ['Switch5', 'GigabitEthernet0/0/0', 'R4', 'GE0/0/2'],
  ['Server3', 'eth0', 'Switch1', 'FastEthernet0/7'],
];

const QUIET_ACCESS_PORTS = Array.from({ length: 10 }, (_, i) => `FastEthernet0/${i + 1}`);

const CISCO_SWITCH_CONFIG = [
  'enable', 'configure terminal',
  ...QUIET_ACCESS_PORTS.flatMap((port) => [
    `interface ${port}`, 'spanning-tree portfast', 'spanning-tree bpdufilter enable', 'exit',
  ]),
  'end',
];

const FW1_CONFIG = [
  'config system interface',
  'edit "port2"',
  'set description "Juste une simple description du port2"',
  'set ip 192.168.20.2 255.255.255.252',
  'set allowaccess ssh ping',
  'next',
  'end',
  'config firewall address',
  'edit "LAN_SUBNET"', 'set subnet 192.168.1.0 255.255.255.0', 'next',
  'edit "HQ_ADDRESS"', 'set subnet 192.168.30.0 255.255.255.0', 'next',
  'edit "BONAM_SUBNET"', 'next',
  'end',
  'config firewall policy',
  'edit 1',
  'set name "First Rule"',
  'set srcintf "port1"',
  'set dstintf "port2"',
  'set srcaddr "LAN_SUBNET"',
  'set dstaddr "HQ_ADDRESS"',
  'set service "ALL"',
  'set schedule "always"',
  'set action accept',
  'set nat enable',
  'next',
  'end',
];

const ROUTER2_CONFIG = [
  'enable', 'configure terminal',
  'ip dhcp pool LAN',
  'network 192.168.1.0 255.255.255.0', 'default-router 192.168.1.1', 'dns-server 4.4.4.4', 'lease 3',
  'exit',
  'interface GigabitEthernet0/0',
  'description Interface connecté au LAN', 'ip address 192.168.1.1 255.255.255.0', 'no shutdown',
  'exit',
  'interface GigabitEthernet0/2', 'shutdown', 'exit',
  'ip route 192.168.20.0 255.255.255.252 192.168.1.99',
  'ip route 192.168.30.0 255.255.255.0 192.168.1.99',
  'ip route 0.0.0.0 0.0.0.0 192.168.1.99',
  'end',
];

const R3_CONFIG = [
  'enable', 'configure terminal',
  'ip dhcp pool HQ',
  'network 192.168.30.0 255.255.255.0', 'default-router 192.168.30.1', 'dns-server 4.4.4.4', 'lease 4',
  'exit',
  'interface GigabitEthernet0/0', 'ip address 192.168.20.1 255.255.255.252', 'no shutdown', 'exit',
  'interface GigabitEthernet0/1', 'ip address 192.168.30.1 255.255.255.0', 'no shutdown', 'exit',
  'interface GigabitEthernet0/2', 'shutdown', 'exit',
  'ip route 192.168.1.0 255.255.255.0 192.168.20.2',
  'lldp run',
  'end',
];

const R4_CONFIG = [
  'system-view',
  'dhcp enable',
  'ip pool BONAMOUSSADI',
  'network 192.168.40.0 mask 255.255.255.0', 'gateway-list 192.168.40.1', 'dns-list 4.4.4.4', 'lease day 3',
  'quit',
  'dhcp server forbidden-ip 192.168.40.1 192.168.40.10',
  'interface GigabitEthernet0/0/0', 'undo shutdown', 'ip address dhcp-alloc', 'quit',
  'interface GigabitEthernet0/0/1', 'undo shutdown', 'ip address 192.168.40.1 255.255.255.0', 'quit',
  'ip route-static 0.0.0.0 0.0.0.0 192.168.30.1',
  'lldp enable',
  'return',
];

const BON_MAIN_SW_CONFIG = [
  'system-view',
  'vlan 10', 'name CCO', 'quit',
  'stp disable',
  'return',
];

const LINUX_DHCP = ['sudo dhclient eth0'];
const WINDOWS_DHCP = ['ipconfig /renew'];

async function configure(device: LabDevice, lines: readonly string[]): Promise<void> {
  for (const line of lines) {
    const output = await device.executeCommand(line);
    if (refuse(output)) throw new Error(`${device.getName()} refused \`${line}\`: ${output}`);
  }
}

export async function loadUserLab(): Promise<UserLab> {
  const lab = {} as UserLab;
  for (const [name, type] of DEVICES) {
    lab[name] = createDevice(type, 0, 0, name) as unknown as LabDevice;
  }
  for (const [a, portA, b, portB] of CABLES) {
    new Cable(`${a}-${b}`).connect(lab[a].getPort(portA) as Port, lab[b].getPort(portB) as Port);
  }

  for (const sw of [lab.Switch1, lab.HQ_MAIN_SW, lab.Switch3]) await configure(sw, CISCO_SWITCH_CONFIG);
  await configure(lab.FW1, FW1_CONFIG);
  await configure(lab.Router2, ROUTER2_CONFIG);
  await configure(lab.R3, R3_CONFIG);
  await configure(lab.BON_MAIN_SW, BON_MAIN_SW_CONFIG);

  await configure(lab.PC2, WINDOWS_DHCP);
  await configure(lab.PC1, LINUX_DHCP);
  await configure(lab.PC7, WINDOWS_DHCP);
  await configure(lab.Server3, LINUX_DHCP);
  await configure(lab.WinServer1, WINDOWS_DHCP);
  await configure(lab.R4, R4_CONFIG);
  await configure(lab.Server1, LINUX_DHCP);
  await configure(lab.PC5, LINUX_DHCP);
  await configure(lab.PC3, LINUX_DHCP);
  await configure(lab.PC9, WINDOWS_DHCP);

  await configure(lab.Server1, ['sudo systemctl enable --now nginx']);
  return lab;
}

export async function addRoutesToHq(lab: UserLab): Promise<void> {
  await taper(lab.Router2, [
    'enable', 'configure terminal',
    'ip route 192.168.30.0 255.255.255.0 192.168.1.99',
    'end',
  ]);
  await taper(lab.FW1, [
    'config router static', 'edit 1',
    'set dst 192.168.30.0 255.255.255.0', 'set gateway 192.168.20.1', 'set device "port2"',
    'next', 'end',
  ]);
}
