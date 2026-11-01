/*
 * Probe — `ipconfig /all` prints the second and later DNS servers under the first one.
 *
 * Measured first: the value column of every `ipconfig /all` line starts at character 39 ("   DNS Servers . . . .
 * . . . . . . . : 10.20.20.10"), and the continuation lines of a multi-server list were indented by 41 spaces,
 * two characters to the right of the first server. The shape of a real transcript is a list whose entries stack
 * in one column. The two branches (DHCP lease and static configuration) wrote the same list by hand.
 *
 * Discrimination (git stash of WinIpconfig.ts): 2 of the 3 cases fall before the change. "a single server" is the
 * WITNESS: one entry has no continuation line, so it passes either way and proves the line itself is unchanged.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
});

async function dnsBlock(servers: string[]): Promise<string[]> {
  const pc = new WindowsPC('windows-pc', 'PC1');
  pc.powerOn();
  pc.setCurrentUser('Administrator');
  await pc.executeCommand('netsh interface ip set address "Ethernet 0" static 10.0.0.5 255.255.255.0 10.0.0.1');
  await pc.executeCommand(`netsh interface ip set dns "Ethernet 0" static ${servers[0]}`);
  for (const [index, server] of servers.slice(1).entries()) {
    await pc.executeCommand(`netsh interface ip add dns "Ethernet 0" ${server} index=${index + 2}`);
  }
  const lines = (await pc.executeCommand('ipconfig /all')).split('\n');
  const first = lines.findIndex((line) => line.includes('DNS Servers'));
  expect(first).toBeGreaterThan(-1);
  return lines.slice(first, first + servers.length);
}

const column = (line: string): number => line.length - line.trimStart().length;

describe('ipconfig /all DNS server list', () => {
  it('a single server stays on its own line at the value column', async () => {
    const [line] = await dnsBlock(['10.20.20.10']);
    expect(line.indexOf(': 10.20.20.10') + 2).toBe(39);
  });

  it('stacks a second server under the first', async () => {
    const [first, second] = await dnsBlock(['10.20.20.10', '10.20.20.53']);
    expect(first.indexOf(': 10.20.20.10') + 2).toBe(39);
    expect(column(second)).toBe(39);
    expect(second.trim()).toBe('10.20.20.53');
  });

  it('stacks every further server in the same column', async () => {
    const lines = await dnsBlock(['10.20.20.10', '10.20.20.53', '1.1.1.1']);
    expect(lines.slice(1).map(column)).toEqual([39, 39]);
    expect(lines.map((line) => line.trim().split(' ').pop())).toEqual(['10.20.20.10', '10.20.20.53', '1.1.1.1']);
  });
});
