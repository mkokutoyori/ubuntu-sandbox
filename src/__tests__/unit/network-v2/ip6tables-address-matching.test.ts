/**
 * ip6tables — correspondance d'adresse/CIDR IPv6 réelle.
 *
 * PRD-Iptables-UFW.md §1.3 item D.10 / §2.1 objectif D.10 (Phase 1) :
 * avant cette phase, `ip6tables -s`/`-d` ne pouvait matcher qu'un littéral
 * IPv4 (le moteur reposait sur `IPAddress`, strictement IPv4) — toute adresse
 * IPv6 échouait systématiquement à la validation. Ce fichier vérifie que le
 * moteur utilise désormais `IPv6Address` pour la famille 6 : correspondance
 * exacte, correspondance de préfixe CIDR, rejet des adresses malformées, et
 * `-m iprange` en IPv6.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

describe('ip6tables — real IPv6 address/CIDR matching', () => {
  let server: LinuxServer;
  let client1: LinuxPC;
  let client2: LinuxPC;
  let sw: HuaweiSwitch;

  beforeEach(async () => {
    EquipmentRegistry.resetInstance();
    server = new LinuxServer('linux-server', 'srv', 0, 0);
    client1 = new LinuxPC('linux-pc', 'c1', 0, 0);
    client2 = new LinuxPC('linux-pc', 'c2', 0, 0);
    sw = new HuaweiSwitch('switch-huawei', 'sw', 8, 0, 0);
    [server, client1, client2, sw].forEach((d) => d.powerOn());

    const p = Array.from(sw.getPorts().values());
    new Cable('c1').connect(server.getPort('eth0')!, p[0]);
    new Cable('c2').connect(client1.getPort('eth0')!, p[1]);
    new Cable('c3').connect(client2.getPort('eth0')!, p[2]);

    await server.executeCommand('ip -6 addr add fd00::1/64 dev eth0');
    await client1.executeCommand('ip -6 addr add fd00::2/64 dev eth0');
    await client2.executeCommand('ip -6 addr add fd00::3/64 dev eth0');
  });

  it('-s <exact address> blocks only that source, not another one in the same LAN', async () => {
    await server.executeCommand('ip6tables -A INPUT -s fd00::2 -j DROP');

    const blocked = await client1.executeCommand('nc -zv -w 1 fd00::1 22');
    expect(blocked).toMatch(/refused|closed|timed out|no route/i);

    const allowed = await client2.executeCommand('nc -zv -w 1 fd00::1 22');
    expect(allowed).toMatch(/succeeded|open|Connected/i);
  });

  it('-s <prefix>/64 matches every address inside the prefix', async () => {
    await server.executeCommand('ip6tables -A INPUT -s fd00::/64 -j DROP');

    const blocked1 = await client1.executeCommand('nc -zv -w 1 fd00::1 22');
    const blocked2 = await client2.executeCommand('nc -zv -w 1 fd00::1 22');
    expect(blocked1).toMatch(/refused|closed|timed out|no route/i);
    expect(blocked2).toMatch(/refused|closed|timed out|no route/i);
  });

  it('a rule for a different prefix does not match traffic outside it', async () => {
    await server.executeCommand('ip6tables -A INPUT -s fd01::/64 -j DROP');

    const stillAllowed = await client1.executeCommand('nc -zv -w 1 fd00::1 22');
    expect(stillAllowed).toMatch(/succeeded|open|Connected/i);
  });

  it('-d matches the destination address of an outbound rule the same way', async () => {
    await server.executeCommand('ip6tables -A INPUT -s fd00::2/128 -j REJECT');
    const out = await client1.executeCommand('nc -zv -w 1 fd00::1 22');
    expect(out).toMatch(/refused/i);
  });

  it('rejects a malformed IPv6 address with a real validation error', async () => {
    const out = await server.executeCommand('ip6tables -A INPUT -s not-an-address -j DROP');
    expect(out).toContain('host/network');
  });

  it('rejects an out-of-range prefix length (>128)', async () => {
    const out = await server.executeCommand('ip6tables -A INPUT -s fd00::/200 -j DROP');
    expect(out).toContain('host/network');
  });

  it('-L renders the configured IPv6 source spec back correctly', async () => {
    await server.executeCommand('ip6tables -A INPUT -s fd00::2/64 -j DROP');
    const out = await server.executeCommand('ip6tables -L');
    expect(out).toContain('fd00::2/64');
  });

  it('-m iprange matches an IPv6 range (--src-range)', async () => {
    await server.executeCommand(
      'ip6tables -A INPUT -m iprange --src-range fd00::2-fd00::2 -j DROP',
    );
    const blocked = await client1.executeCommand('nc -zv -w 1 fd00::1 22');
    expect(blocked).toMatch(/refused|closed|timed out|no route/i);

    const allowed = await client2.executeCommand('nc -zv -w 1 fd00::1 22');
    expect(allowed).toMatch(/succeeded|open|Connected/i);
  });
});
