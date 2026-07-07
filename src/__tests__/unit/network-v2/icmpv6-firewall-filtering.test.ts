/**
 * ICMPv6 filtered by ip6tables INPUT, with Neighbor Discovery exempted.
 *
 * PRD-Iptables-UFW.md §1.3 item C.7 / §2.1 objectif C.7 (Phase 3): before
 * this fix, `handleIPv6` dispatched every ICMPv6 packet straight to
 * `handleICMPv6` without ever consulting `firewallFilter6` — a `ping6`
 * always crossed the firewall regardless of any `-p icmpv6` rule, unlike
 * TCP/UDP-v6 which were already filtered. Fixing this required also adding
 * `-p icmpv6`/`ipv6-icmp` as recognized protocol keywords in
 * `LinuxIptablesManager` (protocol number 58) — `ip6tables -p icmpv6`
 * previously failed at rule-parse time ("unknown protocol").
 *
 * The fix explicitly exempts Neighbor Discovery messages (RFC 4861:
 * neighbor/router solicitation and advertisement) from filtering — blocking
 * those would break address resolution itself rather than just the traffic
 * an administrator meant to block.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

describe('ICMPv6 firewall filtering', () => {
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

  it('accepts -p icmpv6 as a valid protocol keyword (rejected before this fix)', async () => {
    const out = await server.executeCommand('ip6tables -A INPUT -p icmpv6 -j DROP');
    expect(out).not.toContain('unknown protocol');
    const list = await server.executeCommand('ip6tables -S INPUT');
    expect(list).toContain('-p icmpv6');
  });

  it('-p icmpv6 -j DROP blocks ping6 (100% loss)', async () => {
    await server.executeCommand('ip6tables -A INPUT -p icmpv6 -j DROP');
    const out = await client.executeCommand('ping6 -c 1 -W 1 fd00::1');
    expect(out).toMatch(/100% packet loss/);
  });

  it('-p icmpv6 -j REJECT sends back a real Destination Unreachable instead of a silent timeout', async () => {
    await server.executeCommand('ip6tables -A INPUT -p icmpv6 -j REJECT');
    const out = await client.executeCommand('ping6 -c 1 -W 1 fd00::1');
    expect(out).toMatch(/Destination Host Unreachable/);
    expect(out).not.toMatch(/bytes from/);
  });

  it('a -p icmpv6 DROP rule does not affect TCP/UDP traffic (protocol scoping is correct)', async () => {
    await server.executeCommand('ip6tables -A INPUT -p icmpv6 -j DROP');
    const out = await client.executeCommand('nc -zv -w 1 fd00::1 22');
    expect(out).toMatch(/succeeded|open|Connected/i);
  });

  it('Neighbor Discovery keeps working under a blanket icmpv6 DROP (address resolution is never filtered)', async () => {
    await server.executeCommand('ip6tables -A INPUT -p icmpv6 -j DROP');
    // A successful TCP handshake to fd00::1 requires the client to have
    // resolved the server's MAC via NS/NA first — if ND were filtered too,
    // this would time out at the neighbor-resolution stage rather than
    // merely failing to receive the (deliberately blocked) ping reply.
    const out = await client.executeCommand('nc -zv -w 1 fd00::1 22');
    expect(out).toMatch(/succeeded|open|Connected/i);
  });

  it('without any icmpv6 rule, ping6 succeeds normally (no regression)', async () => {
    const out = await client.executeCommand('ping6 -c 1 -W 1 fd00::1');
    expect(out).toMatch(/bytes from/);
  });
});
