/**
 * `ufw` really blocks IPv6 traffic end-to-end — PRD-Iptables-UFW.md §1.3
 * item E.13 / §2.1 objectif E.13 (Phase 4).
 *
 * Before this fix, `ufw`'s "(v6)" rules were cosmetic only: never injected
 * into any real engine (`LinuxFirewallManager` didn't even hold a reference
 * to `ip6tables`). This test drives the whole stack through
 * `executeCommand` — `ufw enable`/`ufw deny` on the server, a real `nc -zv`
 * probe from an IPv6-only client — rather than poking the engines directly,
 * to prove the CLI-visible behavior actually changed.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

describe('ufw really blocks real IPv6 traffic (not just a cosmetic (v6) tag)', () => {
  let server: LinuxServer;
  let client: LinuxPC;
  let sw: HuaweiSwitch;

  beforeEach(async () => {
    EquipmentRegistry.resetInstance();
    server = new LinuxServer('linux-server', 'srv', 0, 0);
    client = new LinuxPC('linux-pc', 'c1', 0, 0);
    sw = new HuaweiSwitch('switch-huawei', 'sw', 8, 0, 0);
    [server, client, sw].forEach((d) => d.powerOn());

    const p = Array.from(sw.getPorts().values());
    new Cable('c1').connect(server.getPort('eth0')!, p[0]);
    new Cable('c2').connect(client.getPort('eth0')!, p[1]);

    await server.executeCommand('ip -6 addr add fd00::1/64 dev eth0');
    await client.executeCommand('ip -6 addr add fd00::2/64 dev eth0');
  });

  it('ufw deny 22 blocks an IPv6 client, not just IPv4 (default-deny incoming policy)', async () => {
    await server.executeCommand('ufw default deny incoming');
    await server.executeCommand('ufw enable');

    const out = await client.executeCommand('nc -zv -w 1 fd00::1 22');
    expect(out).toMatch(/refused|closed|timed out|no route/i);
  });

  it('ufw allow 22/tcp lets an IPv6 client through under a default-deny policy', async () => {
    await server.executeCommand('ufw default deny incoming');
    await server.executeCommand('ufw allow 22/tcp');
    await server.executeCommand('ufw enable');

    const out = await client.executeCommand('nc -zv -w 1 fd00::1 22');
    expect(out).toMatch(/succeeded|open|Connected/i);
  });

  it('ufw deny <specific v4 address> does not affect the IPv6 client at all', async () => {
    await server.executeCommand('ufw default allow incoming');
    await server.executeCommand('ufw deny from 10.0.0.9');
    await server.executeCommand('ufw enable');

    const out = await client.executeCommand('nc -zv -w 1 fd00::1 22');
    expect(out).toMatch(/succeeded|open|Connected/i);
  });

  it('ufw status shows the (v6) rule and the live engine agrees with it', async () => {
    await server.executeCommand('ufw default deny incoming');
    await server.executeCommand('ufw allow 22/tcp');
    await server.executeCommand('ufw enable');

    const status = await server.executeCommand('ufw status');
    expect(status).toContain('22/tcp (v6)');

    const out = await client.executeCommand('nc -zv -w 1 fd00::1 22');
    expect(out).toMatch(/succeeded|open|Connected/i);
  });
});
