import { useNetworkStore } from '@/store/networkStore';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { Equipment } from '@/network';
import type { Port } from '@/network/hardware/Port';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { decodeEthernetFrame } from '@/network/devices/linux/network/tcpdump/CaptureFrame';
import { buildDnsAgenceBancaire } from '@/labs/dnsAgenceBancaire/build';

export const WATCHED = ['PC-GUICHET1', 'PC-GUICHET2', 'PC-CONSEILLER', 'DC1', 'DNS-RES', 'ROOT-NS', 'TLD-NS', 'NS1-BANK'] as const;
export type Watched = typeof WATCHED[number];

export interface Bench {
  readonly asked: (device: Watched, shell: 'ps' | 'sh', line: string) => Promise<{ output: string; sent: Record<Watched, number>; received: Record<Watched, number> }>;
}

export function resetWorld(): void {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.reset();
  useNetworkStore.getState().clearAll();
}

export async function bench(): Promise<Bench> {
  await buildDnsAgenceBancaire();
  const devices = new Map<string, Equipment>([...useNetworkStore.getState().deviceInstances.values()].map((device) => [device.getName(), device]));
  const sent = Object.fromEntries(WATCHED.map((name) => [name, 0])) as Record<Watched, number>;
  const received = Object.fromEntries(WATCHED.map((name) => [name, 0])) as Record<Watched, number>;
  for (const name of WATCHED) {
    const ports = (devices.get(name) as unknown as { ports: Map<string, Port> }).ports;
    for (const port of ports.values()) {
      port.attachTap((tapped) => {
        if (tapped.iface === 'lo') return;
        const frame = decodeEthernetFrame(tapped.frame, tapped.iface, tapped.direction, tapped.at, tapped.atMicros);
        if (frame.l4 !== 'udp' || frame.dstPort !== 53) return;
        if (tapped.direction === 'out') sent[name]++;
        else received[name]++;
      });
    }
  }
  const shells = new Map<string, (line: string) => Promise<string>>();
  const powershell = (name: string): ((line: string) => Promise<string>) => {
    let run = shells.get(name);
    if (run === undefined) {
      const shell = PowerShellSubShell.create(devices.get(name) as never).subShell;
      run = async (line) => (await shell.processLine(line)).output.join('\n');
      shells.set(name, run);
    }
    return run;
  };
  return {
    asked: async (device, shell, line) => {
      const before = { sent: { ...sent }, received: { ...received } };
      const output = shell === 'ps' ? await powershell(device)(line) : await devices.get(device)!.executeCommand(line);
      const delta = (now: Record<Watched, number>, then: Record<Watched, number>) =>
        Object.fromEntries(WATCHED.map((name) => [name, now[name] - then[name]])) as Record<Watched, number>;
      return { output, sent: delta(sent, before.sent), received: delta(received, before.received) };
    },
  };
}
