/**
 * iptables `--reject-with` — PRD-Iptables-UFW.md §1.3 item C.8 /
 * §2.1 objectif C.8 (Phase 3).
 *
 * Before this fix, `--reject-with` was parsed and stored (shown in `-L`/`-S`)
 * but never consulted when actually generating the ICMP error — every
 * REJECT verdict produced destination-unreachable/admin-prohibited (code
 * 13) regardless of the configured value. The default (no `--reject-with`
 * on the rule) now matches real iptables: icmp-port-unreachable (code 3).
 *
 * `ping`'s rendered text now differentiates by code too (see
 * `icmpUnreachText` in `Ping.ts`), but these tests still observe the code
 * via the `host.icmp.echo-failed` bus event's `reason` string on the
 * client, which threads the real `icmp.code` value through
 * (`EndHost.handleICMP`).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { IPAddress } from '@/network/core/types';

async function waitUntil(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('iptables --reject-with', () => {
  let server: LinuxServer;
  let client: LinuxPC;
  let sw: CiscoSwitch;

  beforeEach(async () => {
    EquipmentRegistry.resetInstance();
    server = new LinuxServer('linux-server', 'srv', 0, 0);
    client = new LinuxPC('linux-pc', 'c1', 0, 0);
    sw = new CiscoSwitch('switch-cisco', 'sw', 8, 0, 0);
    [server, client, sw].forEach((d) => d.powerOn());

    new Cable('c1').connect(server.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('c2').connect(client.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);

    await server.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
    await client.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');
  });

  function captureReasons(): string[] {
    const reasons: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).getBus().subscribe('host.icmp.echo-failed', (e: any) => {
      const p = e.payload as { reason?: string };
      if (p.reason) reasons.push(p.reason);
    });
    return reasons;
  }

  it('default REJECT (no --reject-with) sends icmp-port-unreachable, code 3 (real iptables default)', async () => {
    await server.executeCommand('iptables -A INPUT -p udp --dport 9999 -j REJECT');
    const reasons = captureReasons();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).sendUdpDatagram(new IPAddress('10.0.0.1'), 9999, 5000, 'x', 1);
    await waitUntil(() => reasons.length > 0);
    expect(reasons[0]).toContain('code 3');
  });

  it('--reject-with icmp-host-unreachable selects code 1', async () => {
    await server.executeCommand(
      'iptables -A INPUT -p udp --dport 9999 -j REJECT --reject-with icmp-host-unreachable',
    );
    const reasons = captureReasons();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).sendUdpDatagram(new IPAddress('10.0.0.1'), 9999, 5000, 'x', 1);
    await waitUntil(() => reasons.length > 0);
    expect(reasons[0]).toContain('code 1');
  });

  it('--reject-with icmp-net-unreachable selects code 0', async () => {
    await server.executeCommand(
      'iptables -A INPUT -p udp --dport 9999 -j REJECT --reject-with icmp-net-unreachable',
    );
    const reasons = captureReasons();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).sendUdpDatagram(new IPAddress('10.0.0.1'), 9999, 5000, 'x', 1);
    await waitUntil(() => reasons.length > 0);
    expect(reasons[0]).toContain('code 0');
  });

  it('--reject-with icmp-port-unreachable selects code 3', async () => {
    await server.executeCommand(
      'iptables -A INPUT -p udp --dport 9999 -j REJECT --reject-with icmp-port-unreachable',
    );
    const reasons = captureReasons();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).sendUdpDatagram(new IPAddress('10.0.0.1'), 9999, 5000, 'x', 1);
    await waitUntil(() => reasons.length > 0);
    expect(reasons[0]).toContain('code 3');
  });

  it('--reject-with tcp-reset sends a TCP RST instead of any ICMP error', async () => {
    await server.executeCommand(
      'iptables -A INPUT -p tcp --dport 2222 -j REJECT --reject-with tcp-reset',
    );
    const reasons = captureReasons();
    const out = await client.executeCommand('nc -zv -w 1 10.0.0.1 2222');
    expect(out).toMatch(/refused/i);
    // Give any (incorrect) ICMP error a chance to arrive before asserting
    // its absence.
    await new Promise((r) => setTimeout(r, 100));
    expect(reasons.length).toBe(0);
  });
});
