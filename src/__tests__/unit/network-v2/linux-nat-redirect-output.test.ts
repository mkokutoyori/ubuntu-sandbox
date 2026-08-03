/**
 * PRD-Port-Forwarding.md Phase 6 — Linux `iptables -j REDIRECT` and the
 * `nat` table's `OUTPUT` chain actually take effect, and a nat-table target
 * used in a chain its real netfilter hook mask doesn't cover is rejected
 * the way real Linux rejects it, instead of being silently accepted as
 * pure CLI decor.
 *
 * The per-chain restriction and its exact rejection wording were verified
 * empirically against a real `iptables` binary (not assumed from memory):
 * DNAT/REDIRECT only take effect in PREROUTING/OUTPUT, SNAT only in
 * POSTROUTING/INPUT, MASQUERADE only in POSTROUTING — `-A INPUT -j DNAT`
 * genuinely fails on a real box with
 * "RULE_APPEND failed (Invalid argument): rule in chain INPUT", exit 4.
 *
 * REDIRECT-in-PREROUTING (redirecting a service to a different local port)
 * turns out to hit the same reply-path asymmetry Phase 5 documented for
 * cross-host DNAT, even though the destination address never changes: the
 * moment the destination PORT changes, the SYN-ACK's source port no longer
 * matches what the client dialed, so TcpStack's exact 4-tuple demux still
 * never recognizes the reply. The TCP case below stops at "the SYN reached
 * the redirected port", exactly like Phase 5's DNAT test, for the same
 * underlying reason — this isn't a same-host-only quirk of REDIRECT.
 * OUTPUT-chain UDP has no such demux requirement and round-trips for real.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Cable } from '@/network/hardware/Cable';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

describe('PRD-Port-Forwarding.md Phase 6 — nat-table per-chain target validation', () => {
  it('rejects DNAT in INPUT with the real RULE_APPEND wording', async () => {
    const srv = new LinuxServer('linux-server', 'SRV1');
    const out = await srv.executeCommand('iptables -t nat -A INPUT -p tcp --dport 80 -j DNAT --to-destination 10.0.0.5:8080');
    expect(out).toContain('RULE_APPEND failed (Invalid argument): rule in chain INPUT');
  });

  it('rejects REDIRECT in POSTROUTING', async () => {
    const srv = new LinuxServer('linux-server', 'SRV1');
    const out = await srv.executeCommand('iptables -t nat -A POSTROUTING -p tcp --dport 80 -j REDIRECT --to-ports 8080');
    expect(out).toContain('RULE_APPEND failed (Invalid argument): rule in chain POSTROUTING');
  });

  it('rejects SNAT in PREROUTING', async () => {
    const srv = new LinuxServer('linux-server', 'SRV1');
    const out = await srv.executeCommand('iptables -t nat -A PREROUTING -p tcp --dport 80 -j SNAT --to-source 10.0.0.9');
    expect(out).toContain('RULE_APPEND failed (Invalid argument): rule in chain PREROUTING');
  });

  it('rejects MASQUERADE outside POSTROUTING', async () => {
    const srv = new LinuxServer('linux-server', 'SRV1');
    const out = await srv.executeCommand('iptables -t nat -A OUTPUT -j MASQUERADE');
    expect(out).toContain('RULE_APPEND failed (Invalid argument): rule in chain OUTPUT');
  });

  it('rejects with RULE_INSERT wording for -I', async () => {
    const srv = new LinuxServer('linux-server', 'SRV1');
    const out = await srv.executeCommand('iptables -t nat -I INPUT -p tcp --dport 80 -j REDIRECT --to-ports 8080');
    expect(out).toContain('RULE_INSERT failed (Invalid argument): rule in chain INPUT');
  });

  it('accepts REDIRECT in PREROUTING (no regression)', async () => {
    const srv = new LinuxServer('linux-server', 'SRV1');
    const out = await srv.executeCommand('iptables -t nat -A PREROUTING -p tcp --dport 80 -j REDIRECT --to-ports 8080');
    expect(out).toBe('');
  });

  it('accepts DNAT in OUTPUT (no regression)', async () => {
    const srv = new LinuxServer('linux-server', 'SRV1');
    const out = await srv.executeCommand('iptables -t nat -A OUTPUT -p tcp --dport 80 -j DNAT --to-destination 10.0.0.5:8080');
    expect(out).toBe('');
  });

  it('accepts SNAT in POSTROUTING (no regression)', async () => {
    const srv = new LinuxServer('linux-server', 'SRV1');
    const out = await srv.executeCommand('iptables -t nat -A POSTROUTING -j SNAT --to-source 203.0.113.1');
    expect(out).toBe('');
  });

  it('accepts SNAT in INPUT (real on Linux, even with no data-plane consumer here)', async () => {
    const srv = new LinuxServer('linux-server', 'SRV1');
    const out = await srv.executeCommand('iptables -t nat -A INPUT -j SNAT --to-source 203.0.113.1');
    expect(out).toBe('');
  });
});

describe('PRD-Port-Forwarding.md Phase 6 — REDIRECT in PREROUTING', () => {
  it('a SYN dialed at the published port reaches the listener on the redirected port', async () => {
    const client = new LinuxPC('linux-pc', 'CLIENT');
    const srv = new LinuxServer('linux-server', 'SRV1');
    client.configureInterface('eth0', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    srv.configureInterface('eth0', new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
    new Cable('c1').connect(client.getPort('eth0')!, srv.getPort('eth0')!);
    await srv.executeCommand('iptables -t nat -A PREROUTING -p tcp --dport 80 -j REDIRECT --to-ports 8080');

    let acceptedLocalPort: number | null = null;
    let acceptedRemoteIp: string | null = null;
    srv.getTcpStack().listen(8080, {
      onAccept: (s) => { acceptedLocalPort = s.localPort; acceptedRemoteIp = s.remoteIp; },
    });

    // The destination port changed (80 -> 8080), so the SYN-ACK's source
    // port no longer matches what the client dialed — same reply-path
    // asymmetry as Phase 5's DNAT case. Assertions below capture accept
    // time, which is what actually proves the redirect took effect.
    client.getTcpStack().connect('10.0.0.2', 80);

    expect(acceptedLocalPort).toBe(8080);
    expect(acceptedRemoteIp).toBe('10.0.0.1');
  });

  it('with no matching REDIRECT rule, a SYN to an unlistened port is not accepted anywhere (no regression)', async () => {
    const client = new LinuxPC('linux-pc', 'CLIENT');
    const srv = new LinuxServer('linux-server', 'SRV1');
    client.configureInterface('eth0', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    srv.configureInterface('eth0', new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
    new Cable('c1').connect(client.getPort('eth0')!, srv.getPort('eth0')!);

    let accepted = false;
    srv.getTcpStack().listen(8080, { onAccept: () => { accepted = true; } });
    client.getTcpStack().connect('10.0.0.2', 80);

    expect(accepted).toBe(false);
  });
});

describe('PRD-Port-Forwarding.md Phase 6 — nat OUTPUT chain for locally-generated UDP', () => {
  it('REDIRECT sends a locally-originated datagram to a local listener instead of the wire', async () => {
    const host = new LinuxServer('linux-server', 'HOST1');
    const other = new LinuxPC('linux-pc', 'OTHER');
    host.configureInterface('eth0', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    other.configureInterface('eth0', new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
    new Cable('c1').connect(host.getPort('eth0')!, other.getPort('eth0')!);
    await host.executeCommand('iptables -t nat -A OUTPUT -p udp --dport 80 -j REDIRECT --to-ports 9090');

    const receivedLocally: string[] = [];
    const receivedRemotely: string[] = [];
    host.udpBind(9090, (d) => receivedLocally.push(d.udp.payload as string));
    other.udpBind(80, (d) => receivedRemotely.push(d.udp.payload as string));

    const sent = host.sendUdpDatagram(new IPAddress('10.0.0.2'), 80, 40000, 'hello', 5);

    expect(sent).toBe(true);
    expect(receivedLocally).toEqual(['hello']);
    expect(receivedRemotely).toEqual([]);
  });

  it('DNAT redirects a locally-originated datagram to a different real host', async () => {
    const host = new LinuxServer('linux-server', 'HOST1');
    const original = new LinuxPC('linux-pc', 'ORIGINAL');
    const redirectedTo = new LinuxServer('linux-server', 'REDIRECTED');
    host.configureInterface('eth0', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    host.configureInterface('eth1', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
    original.configureInterface('eth0', new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
    redirectedTo.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
    new Cable('c1').connect(host.getPort('eth0')!, original.getPort('eth0')!);
    new Cable('c2').connect(host.getPort('eth1')!, redirectedTo.getPort('eth0')!);
    await host.executeCommand('iptables -t nat -A OUTPUT -p udp --dport 80 -j DNAT --to-destination 10.0.1.2:9090');

    const receivedAtOriginal: string[] = [];
    const receivedAtRedirected: string[] = [];
    original.udpBind(80, (d) => receivedAtOriginal.push(d.udp.payload as string));
    redirectedTo.udpBind(9090, (d) => receivedAtRedirected.push(d.udp.payload as string));

    const sent = host.sendUdpDatagram(new IPAddress('10.0.0.2'), 80, 40000, 'hello', 5);

    expect(sent).toBe(true);
    expect(receivedAtOriginal).toEqual([]);
    expect(receivedAtRedirected).toEqual(['hello']);
  });

  it('with no matching OUTPUT rule, a locally-originated datagram is unaffected (no regression)', async () => {
    const host = new LinuxServer('linux-server', 'HOST1');
    const other = new LinuxPC('linux-pc', 'OTHER');
    host.configureInterface('eth0', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    other.configureInterface('eth0', new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
    new Cable('c1').connect(host.getPort('eth0')!, other.getPort('eth0')!);

    const received: string[] = [];
    other.udpBind(80, (d) => received.push(d.udp.payload as string));
    const sent = host.sendUdpDatagram(new IPAddress('10.0.0.2'), 80, 40000, 'hello', 5);

    expect(sent).toBe(true);
    expect(received).toEqual(['hello']);
  });
});
