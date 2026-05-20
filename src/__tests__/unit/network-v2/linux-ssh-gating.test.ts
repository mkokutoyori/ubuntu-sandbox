/**
 * Unit tests — ssh client gated on remote sshd service state.
 *
 * The original simulator hardcoded "Connection refused" for every
 * `ssh user@host` call, ignoring the topology entirely. After Phase D
 * the client:
 *   - resolves the remote on the simulated topology (EquipmentRegistry)
 *   - refuses when the remote's `ssh` service is inactive or masked
 *   - accepts otherwise, writing /var/log/auth.log on the remote
 *   - honours PermitRootLogin no in /etc/ssh/sshd_config
 *
 * Same behaviour on LinuxPC and LinuxServer — both ship sshd by default.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Hub } from '@/network/devices/Hub';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

function wire(a: LinuxPC | LinuxServer, b: LinuxPC | LinuxServer): void {
  const hub = new Hub('hub', 'h', 0, 0);
  new Cable(a.getPorts()[0], hub.getPorts()[0]);
  new Cable(b.getPorts()[0], hub.getPorts()[1]);
}

function configure(d: LinuxPC | LinuxServer, ip: string): void {
  d.getPorts()[0].configureIP(new IPAddress(ip), new SubnetMask('255.255.255.0'));
}

describe('ssh client — remote sshd gating', () => {
  let client: LinuxPC;
  let server: LinuxServer;

  beforeEach(() => {
    EquipmentRegistry.getInstance().clear();
    client = new LinuxPC('linux-pc', 'pc-client', 0, 0);
    server = new LinuxServer('linux-server', 'srv-target', 100, 0);
    wire(client, server);
    configure(client, '10.0.0.2');
    configure(server, '10.0.0.10');
    // Provision the named users the tests log in as (sshd refuses
    // unknown users on the remote).
    const um = (server as unknown as { executor: { userMgr: {
      useradd: (u: string, o?: object) => void;
      setPassword: (u: string, p: string) => void;
      getUser: (u: string) => unknown;
    } } }).executor.userMgr;
    for (const u of ['alice', 'user']) {
      if (!um.getUser(u)) { um.useradd(u, { m: true, s: '/bin/bash' }); um.setPassword(u, 'x'); }
    }
  });

  it('connects when sshd is active on the remote', async () => {
    const out = await client.executeCommand('ssh user@10.0.0.10');
    expect(out).toContain('Welcome to Ubuntu');
    expect(out).toContain('Connection to 10.0.0.10 closed');
  });

  it('refuses when sshd is stopped on the remote', async () => {
    server.executeCommand('systemctl stop ssh');
    const out = await client.executeCommand('ssh user@10.0.0.10');
    expect(out).toMatch(/Connection refused/);
  });

  it('refuses when the IP is not on the topology at all', async () => {
    const out = await client.executeCommand('ssh user@192.0.2.99');
    expect(out).toMatch(/Could not resolve hostname/);
  });

  it('records a syslog line in /var/log/auth.log on the remote on success', async () => {
    await client.executeCommand('ssh alice@10.0.0.10');
    const log = await server.executeCommand('cat /var/log/auth.log');
    expect(log).toContain('Accepted password for alice');
    expect(log).toContain('from 10.0.0.2');
  });

  it('records a Failed line on refusal', async () => {
    server.executeCommand('systemctl stop ssh');
    await client.executeCommand('ssh alice@10.0.0.10');
    const log = await server.executeCommand('cat /var/log/auth.log');
    expect(log).toContain('Failed password for alice');
  });

  it('PermitRootLogin no in sshd_config blocks root', async () => {
    // Default sshd_config already has PermitRootLogin no — confirm.
    const out = await client.executeCommand('ssh root@10.0.0.10');
    expect(out).toMatch(/Permission denied/);
  });

  it('non-root user is unaffected by PermitRootLogin no', async () => {
    const out = await client.executeCommand('ssh user@10.0.0.10');
    expect(out).toContain('Welcome to Ubuntu');
  });
});

describe('ssh client — works identically from LinuxServer', () => {
  it('server-to-server ssh respects the same gating', async () => {
    EquipmentRegistry.getInstance().clear();
    const a = new LinuxServer('linux-server', 'srv-a', 0, 0);
    const b = new LinuxServer('linux-server', 'srv-b', 100, 0);
    wire(a, b);
    configure(a, '10.0.0.20');
    configure(b, '10.0.0.21');
    const um = (b as unknown as { executor: { userMgr: { useradd: (u: string, o?: object) => void; setPassword: (u: string, p: string) => void; getUser: (u: string) => unknown } } }).executor.userMgr;
    if (!um.getUser('alice')) { um.useradd('alice', { m: true, s: '/bin/bash' }); um.setPassword('alice', 'x'); }
    expect(await a.executeCommand('ssh alice@10.0.0.21')).toContain('Welcome to Ubuntu');
    b.executeCommand('systemctl stop ssh');
    expect(await a.executeCommand('ssh alice@10.0.0.21')).toMatch(/Connection refused/);
  });
});
