import { afterEach, beforeEach } from 'vitest';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { LinuxMachine } from '@/network/devices/LinuxMachine';
import { Switch } from '@/network/devices/Switch';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Logger } from '@/network/core/Logger';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

export interface Cli {
  executeCommand(command: string): Promise<string>;
  getPortNames(): string[];
  getPort(name: string): unknown;
}

const REFUSAL = /Unknown action|command parse error|Invalid|Incomplete|Command fail/i;

export const refuse = (output: string): boolean => REFUSAL.test(output);

export async function taper(device: Cli, lines: readonly string[]): Promise<void> {
  for (const line of lines) await device.executeCommand(line);
}

let activeClock: VirtualTimeScheduler | null = null;

type AsyncMethod = (this: unknown, ...args: unknown[]) => Promise<unknown>;

const drivenPrototypes: Array<[{ prototype: object }, string]> = [
  [LinuxMachine, 'executeCommand'],
  [Switch, 'executeCommand'],
  [WindowsPC, 'executeCommand'],
  [FortiGate, 'executeCommand'],
  [PowerShellSubShell, 'processLine'],
];

for (const [owner, method] of drivenPrototypes) {
  const prototype = owner.prototype as Record<string, AsyncMethod>;
  const original = prototype[method];
  prototype[method] = function drivenByVirtualClock(this: unknown, ...args: unknown[]) {
    const work = original.apply(this, args);
    return activeClock ? activeClock.advanceUntilSettled(work) : work;
  };
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
  activeClock = new VirtualTimeScheduler();
  __setDefaultScheduler(activeClock);
});

afterEach(() => {
  activeClock = null;
});
