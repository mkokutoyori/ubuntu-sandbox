import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { ETHERTYPE_VTP, VTP_MULTICAST_MAC, hashPassword } from '@/network/vtp/types';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function setupAsServer(sw: CiscoSwitch, domain: string): Promise<void> {
  await sw.executeCommand('enable');
  await sw.executeCommand('configure terminal');
  await sw.executeCommand(`vtp domain ${domain}`);
  await sw.executeCommand('vtp mode server');
  await sw.executeCommand('end');
}

async function setupAsClient(sw: CiscoSwitch, domain: string): Promise<void> {
  await sw.executeCommand('enable');
  await sw.executeCommand('configure terminal');
  await sw.executeCommand(`vtp domain ${domain}`);
  await sw.executeCommand('vtp mode client');
  await sw.executeCommand('end');
}

async function makeTrunk(sw: CiscoSwitch, port: string): Promise<void> {
  await sw.executeCommand('configure terminal');
  await sw.executeCommand(`interface ${port}`);
  await sw.executeCommand('switchport mode trunk');
  await sw.executeCommand('end');
}

describe('VTP — defaults', () => {
  it('a Cisco switch boots in server mode with no domain', () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    const cfg = sw.getVtpAgent().getConfig();
    expect(cfg.mode).toBe('server');
    expect(cfg.domain).toBe('');
    expect(cfg.revision).toBe(0);
  });

  it('hashPassword is stable and domain-scoped', () => {
    expect(hashPassword('lab', 'secret')).toBe(hashPassword('lab', 'secret'));
    expect(hashPassword('lab', 'secret')).not.toBe(hashPassword('prod', 'secret'));
    expect(hashPassword('lab', '')).toBe('');
  });
});

describe('VTP — CLI knobs', () => {
  it('vtp domain / mode / version round-trip into running-config', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('vtp domain LAB');
    await sw.executeCommand('vtp mode client');
    await sw.executeCommand('vtp version 2');
    await sw.executeCommand('vtp password seekrit');
    await sw.executeCommand('vtp pruning');
    await sw.executeCommand('end');
    const out = sw.getRunningConfig();
    expect(out).toMatch(/vtp domain LAB/);
    expect(out).toMatch(/vtp mode client/);
    expect(out).toMatch(/vtp version 2/);
    expect(out).toMatch(/vtp password seekrit/);
    expect(out).toMatch(/vtp pruning/);
  });

  it('show vtp status reflects live state', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await setupAsServer(sw, 'LAB');
    const out = await sw.executeCommand('show vtp status');
    expect(out).toMatch(/VTP Domain Name\s+:\s+LAB/);
    expect(out).toMatch(/VTP Operating Mode\s+:\s+Server/);
  });
});

describe('VTP — revision bumps on local change', () => {
  it('creating a VLAN as server bumps the revision', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await setupAsServer(sw, 'LAB');
    expect(sw.getVtpAgent().getConfig().revision).toBe(0);
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('vlan 10');
    await sw.executeCommand('end');
    expect(sw.getVtpAgent().getConfig().revision).toBe(1);
  });

  it('deleting a VLAN as server bumps the revision', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await setupAsServer(sw, 'LAB');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('vlan 20');
    await sw.executeCommand('end');
    const rev1 = sw.getVtpAgent().getConfig().revision;
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('no vlan 20');
    await sw.executeCommand('end');
    expect(sw.getVtpAgent().getConfig().revision).toBe(rev1 + 1);
  });

  it('renaming a VLAN bumps the revision', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await setupAsServer(sw, 'LAB');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('vlan 30');
    await sw.executeCommand('name finance');
    await sw.executeCommand('exit');
    await sw.executeCommand('end');
    expect(sw.getVtpAgent().getConfig().revision).toBeGreaterThanOrEqual(2);
  });
});

describe('VTP — Updater Identity is an IP, not the Device ID MAC', () => {
  it('a local VLAN change stamps lastUpdaterIdentity as an IP and a real timestamp', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await setupAsServer(sw, 'LAB');
    const before = Date.now();
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('vlan 10');
    await sw.executeCommand('end');
    const cfg = sw.getVtpAgent().getConfig();
    expect(cfg.lastUpdaterIdentity).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(cfg.lastUpdateTimestamp).toBeGreaterThanOrEqual(before);
  });

  it('the frame actually delivered over the wire carries the IP-formatted updater and a matching updateTimestamp', async () => {
    const server = new CiscoSwitch('switch-cisco', 'S1', 8);
    const client = new CiscoSwitch('switch-cisco', 'S2', 8);
    await setupAsServer(server, 'LAB');
    await setupAsClient(client, 'LAB');
    new Cable('c1').connect(server.getPort('FastEthernet0/1')!, client.getPort('FastEthernet0/1')!);
    await makeTrunk(server, 'FastEthernet0/1');
    await makeTrunk(client, 'FastEthernet0/1');

    const received: import('@/network/vtp/types').VtpFrame[] = [];
    const clientAgent = client.getVtpAgent();
    const originalHandleFrame = clientAgent.handleFrame.bind(clientAgent);
    clientAgent.handleFrame = (port, frame) => {
      const payload = frame.payload as import('@/network/vtp/types').VtpFrame | undefined;
      if (payload?.type === 'vtp' && payload.messageType === 'summary') received.push(payload);
      originalHandleFrame(port, frame);
    };

    await server.executeCommand('configure terminal');
    await server.executeCommand('vlan 10');
    await server.executeCommand('end');
    clientAgent.handleFrame = originalHandleFrame;

    expect(received.length).toBeGreaterThan(0);
    const serverCfg = server.getVtpAgent().getConfig();
    expect(received[received.length - 1].updater).toBe(serverCfg.lastUpdaterIdentity);
    expect(received[received.length - 1].updater).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(received[received.length - 1].updateTimestamp).toBe(serverCfg.lastUpdateTimestamp);
  });

  it('a client learns the server IP as updater and never touches its own Device ID MAC', async () => {
    const server = new CiscoSwitch('switch-cisco', 'S1', 8);
    const client = new CiscoSwitch('switch-cisco', 'S2', 8);
    await setupAsServer(server, 'LAB');
    await setupAsClient(client, 'LAB');
    new Cable('c1').connect(server.getPort('FastEthernet0/1')!, client.getPort('FastEthernet0/1')!);
    await makeTrunk(server, 'FastEthernet0/1');
    await makeTrunk(client, 'FastEthernet0/1');

    const clientDeviceIdBefore = client.getVtpAgent().getConfig().updaterMac;
    await server.executeCommand('configure terminal');
    await server.executeCommand('vlan 77');
    await server.executeCommand('end');

    const clientCfg = client.getVtpAgent().getConfig();
    expect(clientCfg.lastUpdaterIdentity).toBe(server.getVtpAgent().getConfig().lastUpdaterIdentity);
    expect(clientCfg.updaterMac).toBe(clientDeviceIdBefore);
  });
});

describe('VTP — server pushes its DB to a client', () => {
  it('client syncs the server VLAN when revisions advance', async () => {
    const server = new CiscoSwitch('switch-cisco', 'S1', 8);
    const client = new CiscoSwitch('switch-cisco', 'S2', 8);
    await setupAsServer(server, 'LAB');
    await setupAsClient(client, 'LAB');
    await makeTrunk(server, 'FastEthernet0/1');
    await makeTrunk(client, 'FastEthernet0/1');
    new Cable('w').connect(server.getPort('FastEthernet0/1')!,
                            client.getPort('FastEthernet0/1')!);

    expect(client.getVLAN(50)).toBeUndefined();
    await server.executeCommand('configure terminal');
    await server.executeCommand('vlan 50');
    await server.executeCommand('name ops');
    await server.executeCommand('exit');
    await server.executeCommand('end');

    expect(client.getVLAN(50)).toBeDefined();
    expect(client.getVLAN(50)?.name).toBe('ops');
    expect(client.getVtpAgent().getConfig().revision).toBe(server.getVtpAgent().getConfig().revision);
  });

  it('a fresh client adopts the server domain on first frame', async () => {
    const server = new CiscoSwitch('switch-cisco', 'S1', 8);
    const client = new CiscoSwitch('switch-cisco', 'S2', 8);
    await setupAsServer(server, 'LAB');
    await client.executeCommand('enable');
    await client.executeCommand('configure terminal');
    await client.executeCommand('vtp mode client');
    await client.executeCommand('end');
    expect(client.getVtpAgent().getConfig().domain).toBe('');
    await makeTrunk(server, 'FastEthernet0/1');
    await makeTrunk(client, 'FastEthernet0/1');
    new Cable('w').connect(server.getPort('FastEthernet0/1')!,
                            client.getPort('FastEthernet0/1')!);
    await server.executeCommand('configure terminal');
    await server.executeCommand('vlan 60');
    await server.executeCommand('end');
    expect(client.getVtpAgent().getConfig().domain).toBe('LAB');
    expect(client.getVLAN(60)).toBeDefined();
  });
});

describe('VTP — security gates', () => {
  it('a client in a different domain ignores the server advertisement', async () => {
    const server = new CiscoSwitch('switch-cisco', 'S1', 8);
    const client = new CiscoSwitch('switch-cisco', 'S2', 8);
    await setupAsServer(server, 'LAB');
    await setupAsClient(client, 'PROD');
    await makeTrunk(server, 'FastEthernet0/1');
    await makeTrunk(client, 'FastEthernet0/1');
    new Cable('w').connect(server.getPort('FastEthernet0/1')!,
                            client.getPort('FastEthernet0/1')!);
    await server.executeCommand('configure terminal');
    await server.executeCommand('vlan 99');
    await server.executeCommand('end');
    expect(client.getVLAN(99)).toBeUndefined();
  });

  it('password mismatch rejects the advertisement', async () => {
    const server = new CiscoSwitch('switch-cisco', 'S1', 8);
    const client = new CiscoSwitch('switch-cisco', 'S2', 8);
    await server.executeCommand('enable');
    await server.executeCommand('configure terminal');
    await server.executeCommand('vtp domain LAB');
    await server.executeCommand('vtp password right');
    await server.executeCommand('end');
    await client.executeCommand('enable');
    await client.executeCommand('configure terminal');
    await client.executeCommand('vtp domain LAB');
    await client.executeCommand('vtp password wrong');
    await client.executeCommand('vtp mode client');
    await client.executeCommand('end');
    await makeTrunk(server, 'FastEthernet0/1');
    await makeTrunk(client, 'FastEthernet0/1');
    new Cable('w').connect(server.getPort('FastEthernet0/1')!,
                            client.getPort('FastEthernet0/1')!);
    await server.executeCommand('configure terminal');
    await server.executeCommand('vlan 77');
    await server.executeCommand('end');
    expect(client.getVLAN(77)).toBeUndefined();
  });
});

describe('VTP — wire format', () => {
  it('frames use the link-local multicast 01:00:0c:cc:cc:cc and ethertype 0x2003', async () => {
    const bus = new EventBus();
    const server = new CiscoSwitch('switch-cisco', 'S1', 8);
    const client = new CiscoSwitch('switch-cisco', 'S2', 8);
    server.setEventBus(bus);
    client.setEventBus(bus);
    await setupAsServer(server, 'LAB');
    await setupAsClient(client, 'LAB');
    await makeTrunk(server, 'FastEthernet0/1');
    await makeTrunk(client, 'FastEthernet0/1');
    const cable = new Cable('w');
    cable.setEventBus(bus);

    let seen: { dst: string; ether: number } | null = null;
    bus.subscribe('cable.frame.delivered', (e) => {
      if (e.payload.frame.etherType === ETHERTYPE_VTP) {
        seen = {
          dst: e.payload.frame.dstMAC.toString().toLowerCase(),
          ether: e.payload.frame.etherType,
        };
      }
    });
    cable.connect(server.getPort('FastEthernet0/1')!,
                  client.getPort('FastEthernet0/1')!);
    await server.executeCommand('configure terminal');
    await server.executeCommand('vlan 8');
    await server.executeCommand('end');
    expect(seen).not.toBeNull();
    expect(seen!.dst).toBe(VTP_MULTICAST_MAC);
    expect(seen!.ether).toBe(ETHERTYPE_VTP);
  });
});

describe('VTP — reactive bus', () => {
  it('vtp.db.synced fires on the client when it adopts the server DB', async () => {
    const bus = new EventBus();
    const server = new CiscoSwitch('switch-cisco', 'S1', 8);
    const client = new CiscoSwitch('switch-cisco', 'S2', 8);
    server.setEventBus(bus);
    client.setEventBus(bus);
    await setupAsServer(server, 'LAB');
    await setupAsClient(client, 'LAB');
    await makeTrunk(server, 'FastEthernet0/1');
    await makeTrunk(client, 'FastEthernet0/1');
    new Cable('w').connect(server.getPort('FastEthernet0/1')!,
                            client.getPort('FastEthernet0/1')!);

    const synced: Array<{ deviceId: string; vlansAdded: number[] }> = [];
    bus.subscribe('vtp.db.synced', (e) => synced.push(e.payload));
    await server.executeCommand('configure terminal');
    await server.executeCommand('vlan 42');
    await server.executeCommand('end');
    expect(synced.some(s => s.deviceId === client.id && s.vlansAdded.includes(42))).toBe(true);
  });

  it('vtp.mode.changed fires on mode toggle', async () => {
    const bus = new EventBus();
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    sw.setEventBus(bus);
    const changes: Array<{ newMode: string }> = [];
    bus.subscribe('vtp.mode.changed', (e) => changes.push(e.payload));
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('vtp mode transparent');
    await sw.executeCommand('end');
    expect(changes.some(c => c.newMode === 'transparent')).toBe(true);
  });
});

describe('VTP — transparent mode', () => {
  it('transparent does not adopt the DB but forwards the frame', async () => {
    const bus = new EventBus();
    const server = new CiscoSwitch('switch-cisco', 'S1', 8);
    const transparent = new CiscoSwitch('switch-cisco', 'T', 8);
    const client = new CiscoSwitch('switch-cisco', 'S2', 8);
    server.setEventBus(bus);
    transparent.setEventBus(bus);
    client.setEventBus(bus);
    await setupAsServer(server, 'LAB');
    await transparent.executeCommand('enable');
    await transparent.executeCommand('configure terminal');
    await transparent.executeCommand('vtp mode transparent');
    await transparent.executeCommand('end');
    await setupAsClient(client, 'LAB');
    await makeTrunk(server, 'FastEthernet0/1');
    await makeTrunk(transparent, 'FastEthernet0/1');
    await makeTrunk(transparent, 'FastEthernet0/2');
    await makeTrunk(client, 'FastEthernet0/1');
    new Cable('a').connect(server.getPort('FastEthernet0/1')!,
                            transparent.getPort('FastEthernet0/1')!);
    new Cable('b').connect(transparent.getPort('FastEthernet0/2')!,
                            client.getPort('FastEthernet0/1')!);

    await server.executeCommand('configure terminal');
    await server.executeCommand('vlan 11');
    await server.executeCommand('end');

    expect(transparent.getVLAN(11)).toBeUndefined();
    expect(client.getVLAN(11)).toBeDefined();
  });
});

describe('VTP — Summary and Subset advertisements are distinct frames', () => {
  it('a Summary Advertisement alone never touches the local VLAN database', async () => {
    const client = new CiscoSwitch('switch-cisco', 'S2', 8);
    await setupAsClient(client, 'LAB');
    await makeTrunk(client, 'FastEthernet0/1');
    client.getVtpAgent().handleFrame('FastEthernet0/1', {
      srcMAC: new MACAddress('00:11:22:33:44:55'),
      dstMAC: new MACAddress(VTP_MULTICAST_MAC),
      etherType: ETHERTYPE_VTP,
      payload: {
        type: 'vtp', version: 1, messageType: 'summary',
        domain: 'LAB', revision: 5, updater: '00:11:22:33:44:55',
        passwordHash: hashPassword('LAB', ''),
        vlans: [{ id: 99, name: 'ghost', mtu: 1500, type: 'ethernet' }],
      },
    });
    expect(client.getVLAN(99)).toBeUndefined();
    expect(client.getVtpAgent().getConfig().revision).toBe(0);
  });

  it('an orphan Subset Advertisement with no matching Summary is ignored', async () => {
    const client = new CiscoSwitch('switch-cisco', 'S2', 8);
    await setupAsClient(client, 'LAB');
    await makeTrunk(client, 'FastEthernet0/1');
    client.getVtpAgent().handleFrame('FastEthernet0/1', {
      srcMAC: new MACAddress('00:11:22:33:44:55'),
      dstMAC: new MACAddress(VTP_MULTICAST_MAC),
      etherType: ETHERTYPE_VTP,
      payload: {
        type: 'vtp', version: 1, messageType: 'subset',
        domain: 'LAB', revision: 5, updater: '00:11:22:33:44:55',
        passwordHash: hashPassword('LAB', ''),
        vlans: [{ id: 99, name: 'ghost', mtu: 1500, type: 'ethernet' }],
      },
    });
    expect(client.getVLAN(99)).toBeUndefined();
    expect(client.getVtpAgent().getConfig().revision).toBe(0);
  });

  it('a Subset that follows its matching Summary applies the VLAN diff', async () => {
    const client = new CiscoSwitch('switch-cisco', 'S2', 8);
    await setupAsClient(client, 'LAB');
    await makeTrunk(client, 'FastEthernet0/1');
    const agent = client.getVtpAgent();
    agent.handleFrame('FastEthernet0/1', {
      srcMAC: new MACAddress('00:11:22:33:44:55'),
      dstMAC: new MACAddress(VTP_MULTICAST_MAC),
      etherType: ETHERTYPE_VTP,
      payload: {
        type: 'vtp', version: 1, messageType: 'summary',
        domain: 'LAB', revision: 5, updater: '00:11:22:33:44:55',
        passwordHash: hashPassword('LAB', ''),
        vlans: [],
      },
    });
    agent.handleFrame('FastEthernet0/1', {
      srcMAC: new MACAddress('00:11:22:33:44:55'),
      dstMAC: new MACAddress(VTP_MULTICAST_MAC),
      etherType: ETHERTYPE_VTP,
      payload: {
        type: 'vtp', version: 1, messageType: 'subset',
        domain: 'LAB', revision: 5, updater: '00:11:22:33:44:55',
        passwordHash: hashPassword('LAB', ''),
        vlans: [{ id: 88, name: 'sales', mtu: 1500, type: 'ethernet' }],
      },
    });
    expect(client.getVLAN(88)?.name).toBe('sales');
    expect(agent.getConfig().revision).toBe(5);
  });
});

describe('VTP — Advertisement Request on trunk link-up', () => {
  it('a client sends a Request Advertisement the moment its trunk link comes up', async () => {
    const client = new CiscoSwitch('switch-cisco', 'S2', 8);
    await setupAsClient(client, 'LAB');
    await makeTrunk(client, 'FastEthernet0/1');
    const bus = new EventBus();
    client.setEventBus(bus);
    const sent: string[] = [];
    bus.subscribe('vtp.frame.sent', (e) => sent.push(e.payload.messageType));

    const peer = new CiscoSwitch('switch-cisco', 'PEER', 8);
    await makeTrunk(peer, 'FastEthernet0/1');
    new Cable('w').connect(client.getPort('FastEthernet0/1')!,
                            peer.getPort('FastEthernet0/1')!);

    expect(sent.some(t => t.startsWith('request:link-up'))).toBe(true);
  });

  it('a server never sends a Request Advertisement of its own on trunk link-up', async () => {
    const server = new CiscoSwitch('switch-cisco', 'S1', 8);
    await setupAsServer(server, 'LAB');
    await makeTrunk(server, 'FastEthernet0/1');
    const bus = new EventBus();
    server.setEventBus(bus);
    const sent: string[] = [];
    bus.subscribe('vtp.frame.sent', (e) => sent.push(e.payload.messageType));

    const peer = new CiscoSwitch('switch-cisco', 'PEER', 8);
    await makeTrunk(peer, 'FastEthernet0/1');
    new Cable('w').connect(server.getPort('FastEthernet0/1')!,
                            peer.getPort('FastEthernet0/1')!);

    expect(sent.some(t => t.startsWith('request:'))).toBe(false);
    expect(sent.some(t => t.startsWith('summary:link-up'))).toBe(true);
  });

  it('a server replies to a Request Advertisement with an immediate full summary+subset resync', async () => {
    const server = new CiscoSwitch('switch-cisco', 'S1', 8);
    await setupAsServer(server, 'LAB');
    await server.executeCommand('configure terminal');
    await server.executeCommand('vlan 70');
    await server.executeCommand('end');
    await makeTrunk(server, 'FastEthernet0/1');
    const bus = new EventBus();
    server.setEventBus(bus);
    const sent: string[] = [];
    bus.subscribe('vtp.frame.sent', (e) => sent.push(e.payload.messageType));

    server.getVtpAgent().handleFrame('FastEthernet0/1', {
      srcMAC: new MACAddress('00:aa:bb:cc:dd:ee'),
      dstMAC: new MACAddress(VTP_MULTICAST_MAC),
      etherType: ETHERTYPE_VTP,
      payload: {
        type: 'vtp', version: 1, messageType: 'request',
        domain: 'LAB', revision: 0, updater: '00:aa:bb:cc:dd:ee',
        passwordHash: hashPassword('LAB', ''),
        vlans: [],
      },
    });

    expect(sent.some(t => t.startsWith('summary:request-reply'))).toBe(true);
    expect(sent.some(t => t.startsWith('subset:request-reply'))).toBe(true);
  });
});
