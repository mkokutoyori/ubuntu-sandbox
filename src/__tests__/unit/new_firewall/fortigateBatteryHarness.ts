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

export interface ZoneSpec {
  readonly name: string;
  readonly records: readonly string[];
}

export const labZone = (records: readonly string[] = []): ZoneSpec => ({
  name: 'lab.lan',
  records: ['ns1 IN A 203.0.113.9', 'srv IN A 203.0.113.9', 'web IN A 203.0.113.9', ...records],
});

export const LAB_REVERSE_ZONE: ZoneSpec = {
  name: '113.0.203.in-addr.arpa',
  records: ['9 IN PTR srv.lab.lan.'],
};

export async function serveZones(server: Cli, zones: readonly ZoneSpec[]): Promise<void> {
  const lines = ['apt install -y bind9'];
  for (const zone of zones) {
    const text = [
      '$TTL 3600',
      '@ IN SOA ns1.lab.lan. admin.lab.lan. ( 1 3600 900 604800 300 )',
      '@ IN NS ns1.lab.lan.',
      ...zone.records,
    ].join('\\n');
    lines.push(
      `printf '${text}\\n' > /etc/bind/db.${zone.name}`,
      `echo 'zone "${zone.name}" { type master; file "/etc/bind/db.${zone.name}"; };' >> /etc/bind/named.conf.local`,
    );
  }
  lines.push('systemctl restart named');
  await taper(server, lines);
}

export async function grantKeyAccess(client: Cli, server: Cli, account = 'user'): Promise<void> {
  const keyPath = '~/.ssh/id_ed25519';
  if (!/ssh-ed25519/.test(await client.executeCommand(`cat ${keyPath}.pub`))) {
    await client.executeCommand(`ssh-keygen -t ed25519 -N "" -f ${keyPath}`);
  }
  const publicKey = (await client.executeCommand(`cat ${keyPath}.pub`)).trim();
  const home = account === 'root' ? '/root' : `/home/${account}`;
  const lines = account === 'root' ? [] : [`id ${account} || useradd -m ${account}`];
  await taper(server, [
    ...lines,
    `mkdir -p ${home}/.ssh`,
    `echo '${publicKey}' >> ${home}/.ssh/authorized_keys`,
    `chown -R ${account}:${account} ${home}/.ssh`,
    `chmod 700 ${home}/.ssh`,
    `chmod 600 ${home}/.ssh/authorized_keys`,
  ]);
}
