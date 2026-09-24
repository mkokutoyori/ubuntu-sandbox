/*
 * Probe — an ICMP error whose embedded packet belongs to a session crosses
 * the FortiGate with that session, translated back through its NAT.
 *
 * Before: measured on the user's lab (lan_with_firewall_fortigate
 * topology), `traceroute -n 192.168.30.4` from PC1 printed "2  * * *":
 * R3 answered "time exceeded" to 192.168.20.2, the address policy 1 NATs
 * PC1 to, and FW1 had no session for that ICMP message, so it went to the
 * implicit deny. Without NAT the error was dropped the same way, as a new
 * port2 -> port1 flow no policy allows. `ping -t 2` lost R3's report the
 * same way. The embedded packet carries the TRANSLATED addresses, so the
 * session is found through the reverse of its key, which is the session's
 * reply index.
 *
 * Authority: RFC 5508 (BCP 148), text supplied by the user in
 * new_firewall/rfc/rfc_5508.txt. §4.2 REQ-4 (error from the external
 * realm): revert the embedded packet, keep type and code, address the
 * outer header to the embedded packet's source after translation; REQ-5
 * (error from the private realm): revert the embedded packet, and give the
 * outer source the mapping's public address when the sender is the mapped
 * host, the NAT's own public address otherwise; a packet without a mapping
 * is dropped. §4.3 REQ-6: the session is neither refreshed nor deleted.
 * REQ-3 (checksum validation) has nothing to evaluate: the simulator never
 * corrupts an embedded header. Errors are the simulator's own
 * isICMPErrorMessage (RFC 1122 §3.2.2): a query never takes this path.
 *
 * Measured before the change (git stash of src/network/devices/firewall):
 * 6 of the 7 cases fail — the 3 lab cases below and the 3 engine cases,
 * which find no reapplyToIcmpError on the old engine.
 * Passing either way:
 *   - "traceroute reaches the server" is the WITNESS: routes, policy and
 *     NAT carry the probes; only the errors were lost.
 */
import { describe, it, expect } from 'vitest';
import { loadUserLab, type UserLab } from '../../new_firewall/userLab';
import { taper } from '../../new_firewall/fortigateBatteryHarness';
import { FirewallNatEngine } from '@/network/devices/firewall/nat/FirewallNatEngine';
import { NatPolicyStore } from '@/network/devices/firewall/nat/NatPolicyStore';
import { ObjectStore } from '@/network/devices/firewall/model/ObjectStore';
import type { SessionTranslation } from '@/network/devices/firewall/session/SessionTable';
import { IPAddress, IP_PROTO_UDP, createIPv4Packet, type ICMPPacket, type IPv4Packet, type UDPPacket } from '@/network/core/types';
import { buildICMPError } from '@/network/core/IcmpErrors';

async function configuredLab(nat: boolean): Promise<UserLab> {
  const lab = await loadUserLab();
  await taper(lab.FW1, [
    'config router static', 'edit 1', 'set dst 192.168.30.0 255.255.255.0',
    'set gateway 192.168.20.1', 'set device "port2"', 'next', 'end',
  ]);
  if (!nat) await taper(lab.FW1, ['config firewall policy', 'edit 1', 'set nat disable', 'next', 'end']);
  await taper(lab.PC1, ['ip addr add 192.168.1.10/24 dev eth0', 'ip route add default via 192.168.1.99']);
  return lab;
}

describe('an ICMP error follows its session through FW1', () => {
  it('traceroute reaches the server', async () => {
    const lab = await configuredLab(true);
    expect(await lab.PC1.executeCommand('traceroute -n 192.168.30.4')).toMatch(/^ 3  192\.168\.30\.4 /m);
  });

  it('the time exceeded of the hop behind the NAT comes back', async () => {
    const lab = await configuredLab(true);
    const out = await lab.PC1.executeCommand('traceroute -n 192.168.30.4');
    expect(out).toMatch(/^ 2  192\.168\.20\.1 /m);
    expect(out).not.toContain('* * *');
  });

  it('without NAT the time exceeded is not taken for a new flow', async () => {
    const lab = await configuredLab(false);
    expect(await lab.PC1.executeCommand('traceroute -n 192.168.30.4')).toMatch(/^ 2  192\.168\.20\.1 /m);
  });

  it('ping -t reports the router behind the NAT', async () => {
    const lab = await configuredLab(true);
    const out = await lab.PC1.executeCommand('ping -c 1 -t 2 192.168.30.4');
    expect(out).toContain('From 192.168.20.1 icmp_seq=1 Time to live exceeded');
    expect(out).toContain('1 packets transmitted, 0 received, +1 errors, 100% packet loss');
  });
});

function udp(source: string, sourcePort: number, dest: string, destPort: number): IPv4Packet {
  const datagram: UDPPacket = { type: 'udp', sourcePort, destinationPort: destPort, length: 8, checksum: 0, payload: null };
  return createIPv4Packet(new IPAddress(source), new IPAddress(dest), IP_PROTO_UDP, 64, datagram, 8);
}

function engine(): FirewallNatEngine {
  return new FirewallNatEngine({ objects: new ObjectStore(), policy: new NatPolicyStore(), interfaceAddress: () => undefined });
}

const embeddedOf = (packet: IPv4Packet): IPv4Packet => (packet.payload as ICMPPacket).originalPacket!;

const SNAT: SessionTranslation = {
  natRuleId: 'p1', originalSource: '192.168.1.10', originalSourcePort: 5000,
  translatedSource: '192.168.20.2', translatedSourcePort: 61000,
  originalDest: '192.168.30.4', originalDestPort: 53, translatedDest: '192.168.30.4', translatedDestPort: 53,
};

const VIP: SessionTranslation = {
  natRuleId: 'vip', originalSource: '198.51.100.7', originalSourcePort: 5000,
  translatedSource: '198.51.100.7', translatedSourcePort: 5000,
  originalDest: '203.0.113.1', originalDestPort: 53, translatedDest: '10.0.0.5', translatedDestPort: 53,
};

describe('RFC 5508 on the NAT engine', () => {
  it('REQ-4: an external error reverts the embedded packet and is addressed to its original sender', () => {
    const sent = udp('192.168.20.2', 61000, '192.168.30.4', 53);
    const error = buildICMPError(new IPAddress('192.168.20.1'), sent, 'time-exceeded', 0, 64);
    const out = engine().reapplyToIcmpError(error, SNAT, 'c2s', '192.168.1.99');
    const embedded = embeddedOf(out);
    expect([embedded.sourceIP.toString(), (embedded.payload as UDPPacket).sourcePort]).toEqual(['192.168.1.10', 5000]);
    expect(out.destinationIP.toString()).toBe('192.168.1.10');
    expect(out.sourceIP.toString()).toBe('192.168.20.1');
    expect((out.payload as ICMPPacket).icmpType).toBe('time-exceeded');
  });

  it('REQ-5 c: the mapped private host is shown by its public address', () => {
    const sent = udp('198.51.100.7', 5000, '10.0.0.5', 53);
    const error = buildICMPError(new IPAddress('10.0.0.5'), sent, 'destination-unreachable', 3, 64);
    const out = engine().reapplyToIcmpError(error, VIP, 'c2s', '203.0.113.1');
    expect(embeddedOf(out).destinationIP.toString()).toBe('203.0.113.1');
    expect(out.sourceIP.toString()).toBe('203.0.113.1');
    expect(out.destinationIP.toString()).toBe('198.51.100.7');
  });

  it('REQ-5 c: any other private sender is shown by the NAT\'s own public address', () => {
    const sent = udp('198.51.100.7', 5000, '10.0.0.5', 53);
    const error = buildICMPError(new IPAddress('10.0.0.254'), sent, 'time-exceeded', 0, 64);
    const out = engine().reapplyToIcmpError(error, VIP, 'c2s', '203.0.113.2');
    expect(out.sourceIP.toString()).toBe('203.0.113.2');
  });
});
