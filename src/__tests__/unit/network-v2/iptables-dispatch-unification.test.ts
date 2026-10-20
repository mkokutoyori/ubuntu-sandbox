// iptables/ip6tables must dispatch the same way regardless of pipes/composite
// syntax — PRD-Iptables-UFW.md §2.1 objectif F.16.

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';

describe('iptables/ip6tables dispatch unification', () => {
  let gw: LinuxServer;

  beforeEach(() => {
    gw = new LinuxServer('linux-server', 'GW');
  });

  const masqueradeRule = '-A POSTROUTING -o eth1 -j MASQUERADE';

  it('puts the MASQUERADE rule in the nat table for a plain (non-composite) iptables command', async () => {
    await gw.executeCommand('iptables -t nat -A POSTROUTING -o eth1 -j MASQUERADE');

    expect(await gw.executeCommand('iptables -t nat -S POSTROUTING')).toContain(masqueradeRule);
  });

  it('puts the MASQUERADE rule in the nat table even when the iptables command is piped (composite syntax)', async () => {
    await gw.executeCommand('iptables -t nat -A POSTROUTING -o eth1 -j MASQUERADE | cat');

    expect(await gw.executeCommand('iptables -t nat -S POSTROUTING')).toContain(masqueradeRule);
  });

  it('puts the MASQUERADE rule in the nat table when chained with &&', async () => {
    await gw.executeCommand('true && iptables -t nat -A POSTROUTING -o eth1 -j MASQUERADE');

    expect(await gw.executeCommand('iptables -t nat -S POSTROUTING')).toContain(masqueradeRule);
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
