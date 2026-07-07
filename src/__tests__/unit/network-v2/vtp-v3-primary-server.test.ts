import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function setDomainMode(sw: CiscoSwitch, domain: string, mode: 'server' | 'client' | 'transparent'): Promise<void> {
  await sw.executeCommand('enable');
  await sw.executeCommand('configure terminal');
  await sw.executeCommand(`vtp domain ${domain}`);
  await sw.executeCommand(`vtp mode ${mode}`);
  await sw.executeCommand('end');
}

async function setVersion(sw: CiscoSwitch, version: 1 | 2 | 3): Promise<void> {
  await sw.executeCommand('enable');
  await sw.executeCommand('configure terminal');
  await sw.executeCommand(`vtp version ${version}`);
  await sw.executeCommand('end');
}

describe('VTP v3 — extended VLAN range (1006-4094)', () => {
  it('a VTP v1 server refuses to create an extended-range VLAN', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await setDomainMode(sw, 'LAB', 'server');
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    const out = await sw.executeCommand('vlan 2000');
    await sw.executeCommand('end');
    expect(out).toContain('%');
    expect(sw.getVLAN(2000)).toBeUndefined();
  });

  it('a VTP v3 server can create an extended-range VLAN locally', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await setDomainMode(sw, 'LAB', 'server');
    await setVersion(sw, 3);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('vlan 2000');
    await sw.executeCommand('end');
    expect(sw.getVLAN(2000)).toBeDefined();
  });

  it('a transparent switch can create an extended-range VLAN regardless of version', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await setDomainMode(sw, 'LAB', 'transparent');
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('vlan 3000');
    await sw.executeCommand('end');
    expect(sw.getVLAN(3000)).toBeDefined();
  });

  it('a VTP v3 domain propagates an extended-range VLAN from server to client', async () => {
    const server = new CiscoSwitch('switch-cisco', 'S1', 8);
    const client = new CiscoSwitch('switch-cisco', 'S2', 8);
    await setDomainMode(server, 'LAB', 'server');
    await setVersion(server, 3);
    await setDomainMode(client, 'LAB', 'client');
    await setVersion(client, 3);

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
    await server.executeCommand('vlan 2000');
    await server.executeCommand('end');

    expect(client.getVLAN(2000)).toBeDefined();
  });

  it('a VTP v1 domain never propagates an extended-range VLAN even if a peer somehow has one', async () => {
    const client = new CiscoSwitch('switch-cisco', 'S2', 8);
    await setDomainMode(client, 'LAB', 'client');
    await client.executeCommand('enable');
    await client.executeCommand('configure terminal');
    await client.executeCommand('interface FastEthernet0/1');
    await client.executeCommand('switchport mode trunk');
    await client.executeCommand('end');

    const agent = client.getVtpAgent();
    agent.handleFrame('FastEthernet0/1', {
      srcMAC: new MACAddress('00:11:22:33:44:55'),
      dstMAC: new MACAddress('01:00:0c:cc:cc:cc'),
      etherType: 0x2003,
      payload: {
        type: 'vtp', version: 1, messageType: 'summary',
        domain: 'LAB', revision: 5, updater: '00:11:22:33:44:55',
        passwordHash: '', vlans: [],
      },
    });
    agent.handleFrame('FastEthernet0/1', {
      srcMAC: new MACAddress('00:11:22:33:44:55'),
      dstMAC: new MACAddress('01:00:0c:cc:cc:cc'),
      etherType: 0x2003,
      payload: {
        type: 'vtp', version: 1, messageType: 'subset',
        domain: 'LAB', revision: 5, updater: '00:11:22:33:44:55',
        passwordHash: '',
        vlans: [
          { id: 55, name: 'VLAN0055', mtu: 1500, type: 'ethernet' },
          { id: 2000, name: 'VLAN2000', mtu: 1500, type: 'ethernet' },
        ],
      },
    });

    expect(client.getVLAN(55)).toBeDefined();
    expect(client.getVLAN(2000)).toBeUndefined();
  });
});

describe('VTP v3 — Primary Server election', () => {
  it('a VTP v1/v2 server cannot become Primary Server', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await setDomainMode(sw, 'LAB', 'server');
    const out = await sw.executeCommand('vtp primary');
    expect(out).toContain('%');
    expect(sw.getVtpAgent().getConfig().primaryServer).toBe(false);
  });

  it('a VTP v3 server becomes Primary Server on "vtp primary"', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await setDomainMode(sw, 'LAB', 'server');
    await setVersion(sw, 3);
    const out = await sw.executeCommand('vtp primary');
    expect(out).toContain('Primary Server');
    expect(sw.getVtpAgent().getConfig().primaryServer).toBe(true);
  });

  it('a lower-revision challenger is rejected without "force"', async () => {
    const s1 = new CiscoSwitch('switch-cisco', 'S1', 8);
    const s2 = new CiscoSwitch('switch-cisco', 'S2', 8);
    await setDomainMode(s1, 'LAB', 'server');
    await setVersion(s1, 3);
    await setDomainMode(s2, 'LAB', 'server');
    await setVersion(s2, 3);

    for (const [sw, port] of [[s1, 'FastEthernet0/1'], [s2, 'FastEthernet0/1']] as const) {
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand(`interface ${port}`);
      await sw.executeCommand('switchport mode trunk');
      await sw.executeCommand('end');
    }
    new Cable('w').connect(s1.getPort('FastEthernet0/1')!, s2.getPort('FastEthernet0/1')!);

    await s1.executeCommand('enable');
    await s1.executeCommand('configure terminal');
    await s1.executeCommand('vlan 10');
    await s1.executeCommand('end');

    await s1.executeCommand('vtp primary');
    expect(s1.getVtpAgent().getConfig().primaryServer).toBe(true);

    const out = await s2.executeCommand('vtp primary');
    expect(out).toContain('%');
    expect(s2.getVtpAgent().getConfig().primaryServer).toBe(false);
  });

  it('"vtp primary force" overrides an existing lower-or-equal-revision primary', async () => {
    const s1 = new CiscoSwitch('switch-cisco', 'S1', 8);
    const s2 = new CiscoSwitch('switch-cisco', 'S2', 8);
    await setDomainMode(s1, 'LAB', 'server');
    await setVersion(s1, 3);
    await setDomainMode(s2, 'LAB', 'server');
    await setVersion(s2, 3);

    for (const [sw, port] of [[s1, 'FastEthernet0/1'], [s2, 'FastEthernet0/1']] as const) {
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand(`interface ${port}`);
      await sw.executeCommand('switchport mode trunk');
      await sw.executeCommand('end');
    }
    new Cable('w').connect(s1.getPort('FastEthernet0/1')!, s2.getPort('FastEthernet0/1')!);

    await s1.executeCommand('vtp primary');
    expect(s1.getVtpAgent().getConfig().primaryServer).toBe(true);

    const out = await s2.executeCommand('vtp primary force');
    expect(out).toContain('Primary Server');
    expect(s2.getVtpAgent().getConfig().primaryServer).toBe(true);
    expect(s1.getVtpAgent().getConfig().primaryServer).toBe(false);
  });
});
