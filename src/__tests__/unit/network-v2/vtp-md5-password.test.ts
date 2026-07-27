import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { hashPassword } from '@/network/vtp/types';
import { md5, utf8ToBytes, bytesToHex } from '@/crypto';

function referenceDigest(domain: string, password: string, revision: number): string {
  const secret = md5(utf8ToBytes(password));
  const domainField = new Uint8Array(32);
  domainField.set(utf8ToBytes(domain).slice(0, 32));
  const revisionField = new Uint8Array([
    (revision >>> 24) & 0xff, (revision >>> 16) & 0xff, (revision >>> 8) & 0xff, revision & 0xff,
  ]);
  const body = new Uint8Array(secret.length * 2 + domainField.length + revisionField.length);
  body.set(secret, 0);
  body.set(domainField, secret.length);
  body.set(revisionField, secret.length + domainField.length);
  body.set(secret, secret.length + domainField.length + revisionField.length);
  return bytesToHex(md5(body));
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

describe('VTP password digest is a genuine MD5, not a placeholder hash', () => {
  it('matches an independently computed MD5 of the real Cisco field layout (domain/revision sandwiched by the password digest)', () => {
    expect(hashPassword('LAB', 'secret', 3)).toBe(referenceDigest('LAB', 'secret', 3));
    expect(hashPassword('PROD', 'other', 0)).toBe(referenceDigest('PROD', 'other', 0));
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
