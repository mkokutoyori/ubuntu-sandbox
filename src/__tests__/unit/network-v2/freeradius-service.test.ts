import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { MACAddress, IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { CLIENTS_CONF_PATH, USERS_FILE_PATH } from '@/network/devices/linux/freeradius/RadiusdService';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function vfsOf(server: LinuxServer): VirtualFileSystem {
  return (server as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
}

function writeRoot(server: LinuxServer, path: string, content: string): void {
  vfsOf(server).writeFile(path, content, 0, 0, 0o022);
}

function setupLab(bus: EventBus) {
  const nas = new CiscoRouter('NAS');
  const server = new LinuxServer('linux-server', 'AAA');
  const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
  nas.setEventBus(bus); server.setEventBus(bus); sw.setEventBus(bus);
  new Cable('a').connect(nas.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('b').connect(server.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  nas.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  server.getPort('eth0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  return { nas, server };
}

describe('freeradius — default config and systemd lifecycle (PRD-RADIUS §2.2)', () => {
  it('seeds a working default clients.conf/users pair and loads the default secret automatically', () => {
    const server = new LinuxServer('linux-server', 'AAA');
    expect(server.getRadiusServer().getConfig().sharedSecret).toBe('testing123');
    expect(vfsOf(server).readFile(CLIENTS_CONF_PATH)).toContain('secret = testing123');
    expect(vfsOf(server).readFile(USERS_FILE_PATH)).toBe('');
  });

  it('is reachable out of the box — no systemctl dance required (regression guard for existing labs)', async () => {
    const bus = new EventBus();
    const { nas, server } = setupLab(bus);
    server.getRadiusServer().setSharedSecret('shared');
    server.getRadiusServer().addUser('alice', 'wonderland');
    nas.getRadiusClient().addServer('10.0.0.2', 'shared', { timeoutMs: 200, retransmit: 0 });

    const accepted = await nas.getRadiusClient().authenticate('alice', 'wonderland');
    expect(accepted).toBe(true);
  });

  it('reports active (running) in systemctl status', async () => {
    const server = new LinuxServer('linux-server', 'AAA');
    const out = await server.executeCommand('systemctl status freeradius');
    expect(out).toContain('freeradius.service - FreeRADIUS multi-protocol policy server');
    expect(out).toContain('active (running)');
  });

  it('picks up an edited clients.conf/users pair on systemctl reload', async () => {
    const bus = new EventBus();
    const { nas, server } = setupLab(bus);

    writeRoot(server, CLIENTS_CONF_PATH, 'client 10.0.0.1 {\n\tsecret = new-secret\n}\n');
    writeRoot(server, USERS_FILE_PATH, 'bob Cleartext-Password := "hunter2"\n');
    const out = await server.executeCommand('systemctl reload freeradius');
    expect(out.trim()).toBe('');

    nas.getRadiusClient().addServer('10.0.0.2', 'new-secret', { timeoutMs: 200, retransmit: 0 });
    const accepted = await nas.getRadiusClient().authenticate('bob', 'hunter2');
    expect(accepted).toBe(true);
  });

  it('closes UDP 1812/1813 on systemctl stop, and reopens (reloading clients.conf/users) on systemctl start', async () => {
    const bus = new EventBus();
    const { nas, server } = setupLab(bus);
    // A real restart reloads config from disk — so, unlike the other tests
    // here, configure via the files (not the JS setters) to match what
    // survives a stop/start cycle.
    writeRoot(server, CLIENTS_CONF_PATH, 'client 10.0.0.1 {\n\tsecret = shared\n}\n');
    writeRoot(server, USERS_FILE_PATH, 'alice Cleartext-Password := "wonderland"\n');
    await server.executeCommand('systemctl reload freeradius');
    nas.getRadiusClient().addServer('10.0.0.2', 'shared', { timeoutMs: 150, retransmit: 0 });
    expect(await nas.getRadiusClient().authenticate('alice', 'wonderland')).toBe(true);

    await server.executeCommand('systemctl stop freeradius');
    expect(await nas.getRadiusClient().authenticate('alice', 'wonderland')).toBe(false);

    await server.executeCommand('systemctl start freeradius');
    expect(await nas.getRadiusClient().authenticate('alice', 'wonderland')).toBe(true);
  });

  it('rejects systemctl start/reload on a broken clients.conf (no client blocks) and keeps serving on a bad reload', async () => {
    const bus = new EventBus();
    const { nas, server } = setupLab(bus);
    server.getRadiusServer().setSharedSecret('shared');
    server.getRadiusServer().addUser('alice', 'wonderland');
    nas.getRadiusClient().addServer('10.0.0.2', 'shared', { timeoutMs: 200, retransmit: 0 });

    writeRoot(server, CLIENTS_CONF_PATH, '# no client blocks here\n');
    const reloadOut = await server.executeCommand('systemctl reload freeradius');
    expect(reloadOut).toContain('no client');

    // Still serving with the last-known-good config (mirrors bind9's own reload-safety guarantee).
    expect(await nas.getRadiusClient().authenticate('alice', 'wonderland')).toBe(true);

    await server.executeCommand('systemctl stop freeradius');
    const startOut = await server.executeCommand('systemctl start freeradius');
    expect(startOut).toContain('Failed to start freeradius.service');
  });
});

describe('radtest (freeradius-utils)', () => {
  function setupRadtestLab(bus: EventBus) {
    const client = new LinuxServer('linux-server', 'CLIENT');
    const target = new LinuxServer('linux-server', 'TARGET');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    client.setEventBus(bus); target.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(client.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('b').connect(target.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
    client.configureInterface('eth0', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    target.configureInterface('eth0', new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
    target.getRadiusServer().setSharedSecret('shared');
    target.getRadiusServer().addUser('alice', 'wonderland');
    return { client, target };
  }

  it('prints Access-Accept for a correct PAP login', async () => {
    const bus = new EventBus();
    const { client } = setupRadtestLab(bus);
    const out = await client.executeCommand('radtest alice wonderland 10.0.0.2 10 shared');
    expect(out).toContain('Access-Accept');
  });

  it('prints Access-Reject for a wrong password', async () => {
    const bus = new EventBus();
    const { client } = setupRadtestLab(bus);
    const out = await client.executeCommand('radtest alice wrong-password 10.0.0.2 10 shared');
    expect(out).toContain('Access-Reject');
  });

  it('supports -t chap', async () => {
    const bus = new EventBus();
    const { client } = setupRadtestLab(bus);
    const out = await client.executeCommand('radtest -t chap alice wonderland 10.0.0.2 10 shared');
    expect(out).toContain('Access-Accept');
  });

  it('supports -t mschap', async () => {
    const bus = new EventBus();
    const { client } = setupRadtestLab(bus);
    const out = await client.executeCommand('radtest -t mschap alice wonderland 10.0.0.2 10 shared');
    expect(out).toContain('Access-Accept');
  });
});
