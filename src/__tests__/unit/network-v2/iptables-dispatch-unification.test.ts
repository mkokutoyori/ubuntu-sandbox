// iptables/ip6tables must dispatch the same way regardless of pipes/composite
// syntax — PRD-Iptables-UFW.md §2.1 objectif F.16.

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';

describe('iptables/ip6tables dispatch unification', () => {
  let gw: LinuxServer;

  beforeEach(() => {
    gw = new LinuxServer('linux-server', 'GW');
  });

  it('registers the MASQUERADE interface for a plain (non-composite) iptables command', async () => {
    await gw.executeCommand('ip addr add 10.0.0.1/24 dev eth0');
    await gw.executeCommand('ip addr add 203.0.113.1/30 dev eth1');
    await gw.executeCommand('iptables -t nat -A POSTROUTING -o eth1 -j MASQUERADE');

    expect(gw.getOutgoingMasqueradeIP('203.0.113.2')).toBe('203.0.113.1');
  });

  it('registers the MASQUERADE interface even when the iptables command is piped (composite syntax)', async () => {
    await gw.executeCommand('ip addr add 10.0.0.1/24 dev eth0');
    await gw.executeCommand('ip addr add 203.0.113.1/30 dev eth1');
    // Piped: previously bypassed tryNetworkCommand's chemin A entirely,
    // going straight to chemin B, which never called the NAT hook.
    await gw.executeCommand('iptables -t nat -A POSTROUTING -o eth1 -j MASQUERADE | cat');

    expect(gw.getOutgoingMasqueradeIP('203.0.113.2')).toBe('203.0.113.1');
  });

  it('registers the MASQUERADE interface when chained with &&', async () => {
    await gw.executeCommand('ip addr add 10.0.0.1/24 dev eth0');
    await gw.executeCommand('ip addr add 203.0.113.1/30 dev eth1');
    await gw.executeCommand('true && iptables -t nat -A POSTROUTING -o eth1 -j MASQUERADE');

    expect(gw.getOutgoingMasqueradeIP('203.0.113.2')).toBe('203.0.113.1');
  });

  it('iptables rule text is identical regardless of dispatch path (plain vs piped)', async () => {
    await gw.executeCommand('iptables -A INPUT -p tcp --dport 22 -j ACCEPT');
    const plain = await gw.executeCommand('iptables -S INPUT');

    const gw2 = new LinuxServer('linux-server', 'GW2');
    await gw2.executeCommand('iptables -A INPUT -p tcp --dport 22 -j ACCEPT | cat');
    const piped = await gw2.executeCommand('iptables -S INPUT');

    expect(plain).toBe(piped);
  });

  it('ip6tables rule text is identical regardless of dispatch path (plain vs piped)', async () => {
    await gw.executeCommand('ip6tables -A INPUT -p tcp --dport 22 -j ACCEPT');
    const plain = await gw.executeCommand('ip6tables -S INPUT');

    const gw2 = new LinuxServer('linux-server', 'GW2');
    await gw2.executeCommand('ip6tables -A INPUT -p tcp --dport 22 -j ACCEPT | cat');
    const piped = await gw2.executeCommand('ip6tables -S INPUT');

    expect(plain).toBe(piped);
  });
});
