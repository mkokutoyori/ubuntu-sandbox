import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

async function sw(): Promise<CiscoSwitch> {
  const s = new CiscoSwitch('Switch1');
  await s.executeCommand('enable');
  return s;
}

describe('Cisco switch — privileged EXEC is a superset of user EXEC', () => {
  it('user EXEC commands (ping) are also reachable in privileged mode', async () => {
    const s = await sw();
    const help = await s.executeCommand('?');
    expect(help).toContain('ping');
    // The command is dispatched (not rejected as invalid input) in priv mode.
    expect(await s.executeCommand('ping 1.1.1.1')).not.toContain('Invalid input');
  });
});

describe('Cisco switch — clear mac address-table', () => {
  it('appears in clear help and accepts the standard forms', async () => {
    const s = await sw();
    expect(await s.executeCommand('clear mac address-table')).toBe('');
    expect(await s.executeCommand('clear mac address-table dynamic')).toBe('');
    expect(await s.executeCommand('clear mac address-table dynamic vlan 10')).toBe('');
    expect(await s.executeCommand('clear mac address-table dynamic interface GigabitEthernet0/1')).toBe('');
  });

  it('rejects an unknown interface', async () => {
    const s = await sw();
    expect(await s.executeCommand('clear mac address-table dynamic interface bogus'))
      .toContain('Invalid interface');
  });

  it('clears only dynamic entries, preserving static ones', async () => {
    const s = await sw();
    const table = (s as unknown as { macTable: Map<string, { mac: string; vlan: number; port: string; type: string; age: number; timestamp: number }> }).macTable;
    table.set('1:0000.0000.0001', { mac: '0000.0000.0001', vlan: 1, port: 'GigabitEthernet0/1', type: 'dynamic', age: 300, timestamp: Date.now() });
    table.set('1:0000.0000.0002', { mac: '0000.0000.0002', vlan: 1, port: 'GigabitEthernet0/2', type: 'static', age: 0, timestamp: Date.now() });
    expect(s.getMACTable()).toHaveLength(2);
    await s.executeCommand('clear mac address-table dynamic');
    const remaining = s.getMACTable();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].type).toBe('static');
  });
});
