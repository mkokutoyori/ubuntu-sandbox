import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { importTopology, type TopologyExport } from '@/store/topologySerializer';

import { taper, type Cli } from './fortigateBatteryHarness';

export interface LabDevice extends Cli {
  getName(): string;
}

export type UserLab = Record<
  'PC1' | 'PC2' | 'Switch1' | 'FW1' | 'Router2' | 'R3' | 'Switch2' | 'Server1' | 'WinServer1' | 'PC3',
  LabDevice
>;

const LAB_FILE = resolve(__dirname, 'lan_with_firewall_fortigate.topology (1).json');

export async function loadUserLab(): Promise<UserLab> {
  const exported = JSON.parse(readFileSync(LAB_FILE, 'utf8')) as TopologyExport;
  const imported = await importTopology(exported);
  const byName: Record<string, LabDevice> = {};
  for (const device of imported.deviceInstances.values()) {
    const named = device as unknown as LabDevice;
    byName[named.getName()] = named;
  }
  return byName as UserLab;
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
