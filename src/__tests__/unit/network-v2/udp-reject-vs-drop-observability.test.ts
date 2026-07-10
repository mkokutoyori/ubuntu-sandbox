/**
 * Outbound UDP: DROP vs REJECT observability — PRD-Iptables-UFW.md §1.3
 * item C.9 (Phase 3).
 *
 * The original gap analysis, based on reading `sendUdpDatagram` in
 * isolation, stated that DROP and REJECT "both just return false" for
 * outbound UDP. Re-investigated while implementing Phase 3: `firewallFilter`
 * always routes through `LinuxMachine.runFilterTable`, which *already*
 * differentiates the two verdicts — distinctly tagged kernel log lines
 * (`[netfilter DROP]` vs `[netfilter REJECT]`) and a `linux.firewall.drop`
 * bus event carrying `verdict: 'drop' | 'reject'` — for every direction,
 * outbound UDP included. This file pins that (already-correct) behavior so
 * it isn't accidentally regressed, and documents the actually-remaining
 * gap: no synthetic ICMP is delivered back into the *sending* process's own
 * error path the way a real kernel would (there is no consumer of such a
 * signal for UDP anywhere in this codebase today — see the PRD for why this
 * remains out of scope rather than speculative/untested code).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { IPAddress } from '@/network/core/types';

describe('outbound UDP — DROP vs REJECT already differentiated (log + bus event)', () => {
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

  it('DROP on OUTPUT logs [netfilter DROP] and returns false, like REJECT', async () => {
    await client.executeCommand('sudo iptables -A OUTPUT -p udp --dport 9999 -j DROP');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sent = (client as any).sendUdpDatagram(new IPAddress('10.0.0.1'), 9999, 5000, 'x', 1);
    expect(sent).toBe(false);
    const dmesg = await client.executeCommand('dmesg');
    expect(dmesg).toMatch(/\[netfilter DROP\][^\n]*DPT=9999/);
    expect(dmesg).not.toMatch(/\[netfilter REJECT\][^\n]*DPT=9999/);
  });

  it('REJECT on OUTPUT logs [netfilter REJECT] distinctly from DROP', async () => {
    await client.executeCommand('sudo iptables -A OUTPUT -p udp --dport 9999 -j REJECT');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sent = (client as any).sendUdpDatagram(new IPAddress('10.0.0.1'), 9999, 5000, 'x', 1);
    expect(sent).toBe(false);
    const dmesg = await client.executeCommand('dmesg');
    expect(dmesg).toMatch(/\[netfilter REJECT\][^\n]*DPT=9999/);
    expect(dmesg).not.toMatch(/\[netfilter DROP\][^\n]*DPT=9999/);
  });

  it('the linux.firewall.drop bus event carries the right verdict for outbound UDP', async () => {
    await client.executeCommand('sudo iptables -A OUTPUT -p udp --dport 9999 -j REJECT');
    const verdicts: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).getBus().subscribe('linux.firewall.drop', (e: any) => {
      verdicts.push(e.payload.verdict);
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).sendUdpDatagram(new IPAddress('10.0.0.1'), 9999, 5000, 'x', 1);
    expect(verdicts).toEqual(['reject']);
  });
});
