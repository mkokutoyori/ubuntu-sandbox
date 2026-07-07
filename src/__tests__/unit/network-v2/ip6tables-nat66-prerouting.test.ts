/**
 * ip6tables — NAT66 PREROUTING (DNAT), PRD-Iptables-UFW.md §1.3 item D.11 /
 * §2.1 objectif D.11 (Phase 2).
 *
 * `evaluatePreRouting6` is now wired on `LinuxMachine`, calling into
 * `this.executor.ip6tables.evaluateNat(pkt, 'PREROUTING')` exactly like
 * `evaluatePreRouting`/`iptables` already does for IPv4, and `EndHost.
 * handleIPv6` applies the DNAT rewrite before the local-destination check —
 * symmetrically to `handleIPv4`.
 *
 * Scope note (discovered while writing this test, documented honestly
 * rather than glossed over): there is no reverse-path NAT/conntrack
 * un-translation for replies in this simulator — a locally-terminated DNAT
 * to a second address the *same* host owns will have its TCP replies
 * (SYN-ACK/RST) sourced from the rewritten address, which a real client
 * would treat as unrelated to the connection it opened. This limitation is
 * pre-existing and identical for IPv4 (no test in this codebase exercises
 * IPv4 PREROUTING DNAT to a locally-owned address end-to-end either — the
 * only functional IPv4 DNAT coverage is the NAT-gateway/forwarding case,
 * which has no IPv6 equivalent since end hosts never forward IPv6, see
 * `docs/PRD-Iptables-UFW.md` §2.1 objectif D.11). So this suite verifies the
 * two things that *are* fully correct and testable: the engine matches real
 * IPv6 CIDR specs in the nat table (built on Phase 1), and the PREROUTING
 * rewrite genuinely happens before INPUT ever sees the packet — checked
 * server-side via the kernel log, not via a client-observed round trip.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxIptablesManager } from '@/network/devices/linux/LinuxIptablesManager';

describe('ip6tables — NAT66 PREROUTING (DNAT) engine', () => {
  it('evaluateNat matches a real IPv6 destination CIDR in the nat table and returns the DNAT target', () => {
    const ip6t = new LinuxIptablesManager(undefined, undefined, { family: 6 });
    ip6t.execute(['-t', 'nat', '-A', 'PREROUTING', '-d', 'fd00::/64', '-j', 'DNAT', '--to-destination', 'fd00::9']);

    const result = ip6t.evaluateNat(
      { direction: 'in', protocol: 6, srcIP: 'fd00::2', dstIP: 'fd00::1', srcPort: 0, dstPort: 22, iface: 'eth0' },
      'PREROUTING',
    );
    expect(result).toEqual({ action: 'DNAT', address: 'fd00::9' });
  });

  it('does not match when the destination falls outside the configured prefix', () => {
    const ip6t = new LinuxIptablesManager(undefined, undefined, { family: 6 });
    ip6t.execute(['-t', 'nat', '-A', 'PREROUTING', '-d', 'fd00::/64', '-j', 'DNAT', '--to-destination', 'fd00::9']);

    const result = ip6t.evaluateNat(
      { direction: 'in', protocol: 6, srcIP: 'fd00::2', dstIP: 'fd01::1', srcPort: 0, dstPort: 22, iface: 'eth0' },
      'PREROUTING',
    );
    expect(result).toBeNull();
  });
});

describe('ip6tables — NAT66 PREROUTING CLI on a real device', () => {
  let server: LinuxServer;

  beforeEach(() => {
    EquipmentRegistry.resetInstance();
    server = new LinuxServer('linux-server', 'srv', 0, 0);
    server.powerOn();
  });

  it('accepts and renders a real IPv6 DNAT rule in the nat table (rejected before Phase 1)', async () => {
    await server.executeCommand(
      'ip6tables -t nat -A PREROUTING -d fd00::1 -j DNAT --to-destination fd00::9',
    );
    const out = await server.executeCommand('ip6tables -t nat -S PREROUTING');
    expect(out).toContain('-A PREROUTING -d fd00::1 -j DNAT --to-destination fd00::9');
  });
});

describe('ip6tables — NAT66 PREROUTING runs before INPUT (hook order)', () => {
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
    await server.executeCommand('ip -6 addr add fd00::9/64 dev eth0');
    await client.executeCommand('ip -6 addr add fd00::2/64 dev eth0');
  });

  it('an INPUT rule targeting the original destination stops matching once PREROUTING has rewritten it', async () => {
    await server.executeCommand('ip6tables -A INPUT -d fd00::1 -j DROP');

    // Without NAT: the SYN is addressed to fd00::1, INPUT drops it, and the
    // drop is logged to the kernel log naming that destination.
    await client.executeCommand('nc -zv -w 1 fd00::1 22');
    const dmesgBefore = await server.executeCommand('dmesg');
    expect(dmesgBefore).toMatch(/\[netfilter DROP\][^\n]*DST=fd00::1\b/);
    const dropsBefore = (dmesgBefore.match(/\[netfilter DROP\][^\n]*DST=fd00::1\b/g) ?? []).length;

    // Add a PREROUTING DNAT that rewrites fd00::1 → fd00::9 *before* INPUT
    // ever evaluates the packet — the same SYN should no longer trigger the
    // `-d fd00::1` DROP rule, since by the time INPUT runs the destination
    // is already fd00::9.
    await server.executeCommand(
      'ip6tables -t nat -A PREROUTING -d fd00::1 -j DNAT --to-destination fd00::9',
    );
    await client.executeCommand('nc -zv -w 1 fd00::1 22');
    const dmesgAfter = await server.executeCommand('dmesg');
    const dropsAfter = (dmesgAfter.match(/\[netfilter DROP\][^\n]*DST=fd00::1\b/g) ?? []).length;

    expect(dropsAfter).toBe(dropsBefore);
  });
});
