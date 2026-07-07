import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { hashPassword } from '@/network/vtp/types';
import { md5Hex } from '@/crypto';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

describe('VTP password digest is a genuine MD5, not a placeholder hash', () => {
  it('matches an independently computed MD5 of the same domain|password input', () => {
    expect(hashPassword('LAB', 'secret')).toBe(md5Hex('LAB|secret'));
    expect(hashPassword('PROD', 'other')).toBe(md5Hex('PROD|other'));
  });

  it('is a 32-character lowercase hex digest, the real MD5 output shape', () => {
    const digest = hashPassword('LAB', 'secret');
    expect(digest).toMatch(/^[0-9a-f]{32}$/);
  });

  it('a single-character change to the password produces a fully different digest (avalanche)', () => {
    const a = hashPassword('LAB', 'secreu');
    const b = hashPassword('LAB', 'secret');
    let differingHexDigits = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) differingHexDigits++;
    expect(differingHexDigits).toBeGreaterThan(a.length / 4);
  });

  it('a server and client authenticate using this real MD5 digest end to end', async () => {
    const server = new CiscoSwitch('switch-cisco', 'S1', 8);
    const client = new CiscoSwitch('switch-cisco', 'S2', 8);
    await server.executeCommand('enable');
    await server.executeCommand('configure terminal');
    await server.executeCommand('vtp domain LAB');
    await server.executeCommand('vtp password correct-horse');
    await server.executeCommand('end');
    await client.executeCommand('enable');
    await client.executeCommand('configure terminal');
    await client.executeCommand('vtp domain LAB');
    await client.executeCommand('vtp password correct-horse');
    await client.executeCommand('vtp mode client');
    await client.executeCommand('end');

    for (const [sw, port] of [[server, 'FastEthernet0/1'], [client, 'FastEthernet0/1']] as const) {
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand(`interface ${port}`);
      await sw.executeCommand('switchport mode trunk');
      await sw.executeCommand('end');
    }
    new Cable('w').connect(server.getPort('FastEthernet0/1')!, client.getPort('FastEthernet0/1')!);

    await server.executeCommand('enable');
    await server.executeCommand('configure terminal');
    await server.executeCommand('vlan 42');
    await server.executeCommand('end');

    expect(client.getVLAN(42)).toBeDefined();
  });
});
